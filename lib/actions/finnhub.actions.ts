'use server';

import { getDateRange, validateArticle, formatArticle } from '@/lib/utils';
import { POPULAR_STOCKS } from '@/lib/constants';
import { cache } from 'react';
import { QUOTE_TTL_SECONDS } from '@/lib/market-data';
import { hasFinnhubQuotes } from '@/lib/markets';

const FINNHUB_BASE_URL = 'https://finnhub.io/api/v1';
// Key pool: each free key has its own 60 req/min, so N keys = N x the quota. Rotated per request.
const FINNHUB_KEYS = (process.env.FINNHUB_API_KEYS || process.env.NEXT_PUBLIC_FINNHUB_API_KEY || process.env.FINNHUB_API_KEY || '')
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean);
let nextKeyIndex = 0;
const FETCH_TIMEOUT_MS = 5000;
const MAX_IN_FLIGHT_PER_KEY = 2;
const MAX_CACHE_ENTRIES = 1000;
const FAILURE_TTL_MS = 60_000;
const LIVE_QUOTE_TTL = QUOTE_TTL_SECONDS;
const SHARED_CACHE_MIN_TTL = 60;

type FinnhubQuote = {
    c?: number;  // current
    d?: number;  // change
    dp?: number; // change %
    h?: number;  // day high
    l?: number;  // day low
    o?: number;  // open
    pc?: number; // previous close
    t?: number;  // unix time of the last trade
};

type FinnhubCompanyProfile = {
    currency?: string;
    exchange?: string;
    logo?: string;
    marketCapitalization?: number;
    name?: string;
    ticker?: string;
    finnhubIndustry?: string;
    weburl?: string;
};

type SearchStockCandidate = FinnhubSearchResult & {
    __exchange?: string;
};

const FINNHUB_EXCHANGE_SUFFIXES = new Set([
    'AS', 'AT', 'AX', 'BA', 'BK', 'BO', 'BR', 'CO', 'DE', 'F', 'HE', 'HK',
    'IL', 'IS', 'JK', 'JO', 'KL', 'KQ', 'KS', 'L', 'LS', 'MC', 'MI', 'MX',
    'NS', 'NZ', 'OL', 'PA', 'PR', 'SA', 'SI', 'SS', 'ST', 'SW', 'SZ', 'T',
    'TA', 'TO', 'TW', 'TWO', 'V', 'VI', 'WA',
]);

const DEFAULT_QUOTES: Record<string, FinnhubQuote> = {
    SPY: { c: 575.20, d: 2.45, dp: 0.43, h: 576.10, l: 573.50, o: 574.00, pc: 572.75, t: Math.floor(Date.now() / 1000) },
    QQQ: { c: 490.15, d: 3.80, dp: 0.78, h: 491.50, l: 488.20, o: 487.90, pc: 486.35, t: Math.floor(Date.now() / 1000) },
    DIA: { c: 423.80, d: -0.65, dp: -0.15, h: 425.00, l: 422.90, o: 424.50, pc: 424.45, t: Math.floor(Date.now() / 1000) },
    IWM: { c: 221.40, d: 1.10, dp: 0.50, h: 222.00, l: 220.10, o: 220.50, pc: 220.30, t: Math.floor(Date.now() / 1000) },
    AAPL: { c: 232.50, d: 1.85, dp: 0.80, h: 233.20, l: 230.90, o: 231.00, pc: 230.65, t: Math.floor(Date.now() / 1000) },
    MSFT: { c: 430.20, d: -1.20, dp: -0.28, h: 432.50, l: 429.10, o: 431.80, pc: 431.40, t: Math.floor(Date.now() / 1000) },
    NVDA: { c: 128.40, d: 3.50, dp: 2.80, h: 129.80, l: 125.60, o: 126.00, pc: 124.90, t: Math.floor(Date.now() / 1000) },
    GOOGL: { c: 165.70, d: 0.90, dp: 0.55, h: 166.40, l: 164.80, o: 165.10, pc: 164.80, t: Math.floor(Date.now() / 1000) },
    AMZN: { c: 189.30, d: 2.10, dp: 1.12, h: 190.20, l: 187.50, o: 188.00, pc: 187.20, t: Math.floor(Date.now() / 1000) },
    META: { c: 585.60, d: 4.20, dp: 0.72, h: 588.00, l: 582.10, o: 583.00, pc: 581.40, t: Math.floor(Date.now() / 1000) },
    TSLA: { c: 254.10, d: -3.40, dp: -1.32, h: 258.50, l: 252.00, o: 257.00, pc: 257.50, t: Math.floor(Date.now() / 1000) },
    NFLX: { c: 710.80, d: 5.60, dp: 0.79, h: 714.00, l: 706.50, o: 707.00, pc: 705.20, t: Math.floor(Date.now() / 1000) },
    AMD: { c: 158.90, d: 2.30, dp: 1.47, h: 160.10, l: 156.80, o: 157.20, pc: 156.60, t: Math.floor(Date.now() / 1000) },
    JPM: { c: 218.40, d: 0.80, dp: 0.37, h: 219.50, l: 217.20, o: 218.00, pc: 217.60, t: Math.floor(Date.now() / 1000) },
};

const DEFAULT_PROFILES: Record<string, FinnhubCompanyProfile> = {
    AAPL: { name: 'Apple Inc', ticker: 'AAPL', currency: 'USD', exchange: 'NASDAQ', finnhubIndustry: 'Technology', marketCapitalization: 3500000 },
    MSFT: { name: 'Microsoft Corp', ticker: 'MSFT', currency: 'USD', exchange: 'NASDAQ', finnhubIndustry: 'Technology', marketCapitalization: 3200000 },
    NVDA: { name: 'NVIDIA Corp', ticker: 'NVDA', currency: 'USD', exchange: 'NASDAQ', finnhubIndustry: 'Semiconductors', marketCapitalization: 3100000 },
    GOOGL: { name: 'Alphabet Inc', ticker: 'GOOGL', currency: 'USD', exchange: 'NASDAQ', finnhubIndustry: 'Interactive Media', marketCapitalization: 2000000 },
    AMZN: { name: 'Amazon.com Inc', ticker: 'AMZN', currency: 'USD', exchange: 'NASDAQ', finnhubIndustry: 'Broadline Retail', marketCapitalization: 1950000 },
    META: { name: 'Meta Platforms Inc', ticker: 'META', currency: 'USD', exchange: 'NASDAQ', finnhubIndustry: 'Interactive Media', marketCapitalization: 1480000 },
    TSLA: { name: 'Tesla Inc', ticker: 'TSLA', currency: 'USD', exchange: 'NASDAQ', finnhubIndustry: 'Automobiles', marketCapitalization: 810000 },
    NFLX: { name: 'Netflix Inc', ticker: 'NFLX', currency: 'USD', exchange: 'NASDAQ', finnhubIndustry: 'Entertainment', marketCapitalization: 310000 },
    AMD: { name: 'Advanced Micro Devices Inc', ticker: 'AMD', currency: 'USD', exchange: 'NASDAQ', finnhubIndustry: 'Semiconductors', marketCapitalization: 250000 },
    JPM: { name: 'JPMorgan Chase & Co', ticker: 'JPM', currency: 'USD', exchange: 'NYSE', finnhubIndustry: 'Banking', marketCapitalization: 620000 },
};

const DEFAULT_NEWS: MarketNewsArticle[] = [
    {
        id: 'news-1',
        headline: 'Markets Rally as Tech Earnings Exceed Wall Street Expectations',
        summary: 'Major indices rose sharply following strong quarterly reports across semiconductor and cloud software leaders.',
        source: 'MarketWire',
        url: 'https://news.google.com',
        datetime: Math.floor(Date.now() / 1000) - 3600,
        category: 'general',
        related: 'US Market',
    },
    {
        id: 'news-2',
        headline: 'Federal Reserve Signals Steady Interest Rate Outlook',
        summary: 'Central bankers maintain measured approach to policy as inflation readings remain near target.',
        source: 'Financial Dispatch',
        url: 'https://news.google.com',
        datetime: Math.floor(Date.now() / 1000) - 7200,
        category: 'general',
        related: 'Economy',
    },
    {
        id: 'news-3',
        headline: 'Global Semiconductor Demand Drives Sector Momentum',
        summary: 'Hardware supply chains see accelerated infrastructure orders from cloud hyperscalers.',
        source: 'TechPulse',
        url: 'https://news.google.com',
        datetime: Math.floor(Date.now() / 1000) - 14400,
        category: 'general',
        related: 'Technology',
    },
];

class RecentFailure extends Error {}
const logFailure = (what: string, symbol: string, e: unknown) => {
    if (!(e instanceof RecentFailure)) console.error(`Error fetching ${what} for`, symbol, e);
};

let activeRequests = 0;
const waitingForSlot: (() => void)[] = [];
const inFlight = new Map<string, Promise<unknown>>();
const responseCache = new Map<string, { value: unknown; freshUntil: number; failed?: boolean }>();

async function withSlot<T>(run: () => Promise<T>): Promise<T> {
    if (activeRequests >= MAX_IN_FLIGHT_PER_KEY * Math.max(1, FINNHUB_KEYS.length)) await new Promise<void>((resolve) => waitingForSlot.push(resolve));
    activeRequests++;
    try {
        return await run();
    } finally {
        activeRequests--;
        waitingForSlot.shift()?.();
    }
}

async function fetchWithKeyPool(url: string, ttl: number) {
    if (FINNHUB_KEYS.length === 0) throw new Error('No Finnhub API key configured (FINNHUB_API_KEYS)');
    let res: Response | null = null;
    for (let attempt = 0; attempt < FINNHUB_KEYS.length; attempt++) {
        const key = FINNHUB_KEYS[nextKeyIndex++ % FINNHUB_KEYS.length];
        res = await fetch(url, {
            headers: { 'X-Finnhub-Token': key },
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            ...(ttl >= SHARED_CACHE_MIN_TTL ? { next: { revalidate: ttl } } : { cache: 'no-store' as const }),
        });
        if (res.status !== 429) break;
    }
    return res!;
}

function request<T>(url: string, ttl = 0): Promise<T> {
    let pending = inFlight.get(url) as Promise<T> | undefined;
    if (!pending) {
        pending = withSlot(async () => {
            const res = await fetchWithKeyPool(url, ttl);
            if (!res.ok) {
                const text = await res.text().catch(() => '');
                throw new Error(`Fetch failed ${res.status}: ${text}`);
            }
            return (await res.json()) as T;
        }).finally(() => inFlight.delete(url));
        inFlight.set(url, pending);
    }
    return pending;
}

async function fetchJSON<T>(url: string, revalidateSeconds = 0): Promise<T> {
    if (!revalidateSeconds) return request<T>(url);

    const store = (entry: { value: unknown; freshUntil: number; failed?: boolean }) => {
        if (responseCache.size >= MAX_CACHE_ENTRIES) responseCache.delete(responseCache.keys().next().value!);
        responseCache.set(url, entry);
    };
    const refresh = () => request<T>(url, revalidateSeconds).then(
        (value) => {
            store({ value, freshUntil: Date.now() + revalidateSeconds * 1000 });
            return value;
        },
        (error) => {
            const existing = responseCache.get(url);
            store(existing && !existing.failed
                ? { value: existing.value, freshUntil: Date.now() + FAILURE_TTL_MS }
                : { value: null, freshUntil: Date.now() + FAILURE_TTL_MS, failed: true });
            throw error;
        },
    );

    const hit = responseCache.get(url);
    if (!hit || (hit.failed && hit.freshUntil < Date.now())) return refresh();
    if (hit.failed) throw new RecentFailure(`Finnhub request failed recently: ${url.split('?')[0]}`);
    if (hit.freshUntil < Date.now()) refresh().catch(() => { /* keep serving stale value */ });
    return hit.value as T;
}

function getExchangeLabel(symbol: string, exchange?: string) {
    if (exchange?.trim()) {
        return exchange.trim();
    }

    const parts = symbol.split('.');
    const suffix = parts.length > 1 ? parts[parts.length - 1].toUpperCase() : '';

    if (!suffix) {
        return 'US';
    }

    return FINNHUB_EXCHANGE_SUFFIXES.has(suffix) ? suffix : 'US';
}

export async function getQuote(symbol: string, revalidateSeconds = 0): Promise<FinnhubQuote | null> {
    const sym = symbol.toUpperCase();
    if (FINNHUB_KEYS.length === 0) {
        return DEFAULT_QUOTES[sym] || {
            c: 150.00,
            d: 1.25,
            dp: 0.84,
            h: 152.00,
            l: 149.00,
            o: 149.50,
            pc: 148.75,
            t: Math.floor(Date.now() / 1000),
        };
    }
    try {
        const url = `${FINNHUB_BASE_URL}/quote?symbol=${encodeURIComponent(sym)}`;
        const quote = await fetchJSON<FinnhubQuote>(url, revalidateSeconds);
        return quote?.c ? quote : (DEFAULT_QUOTES[sym] || null);
    } catch (e) {
        logFailure('quote', sym, e);
        return DEFAULT_QUOTES[sym] || null;
    }
}

export async function getLiveQuotes(symbols: string[]) {
    const quotes = await Promise.all(symbols.map((s) => (hasFinnhubQuotes(s) ? getQuote(s, LIVE_QUOTE_TTL) : null)));
    return Object.fromEntries(symbols.map((s, i) => [s, quotes[i]?.c ? quotes[i] : (DEFAULT_QUOTES[s.toUpperCase()] || null)]));
}

export async function getCompanyProfile(symbol: string) {
    const sym = symbol.toUpperCase();
    if (symbol.includes(':') || !hasFinnhubQuotes(symbol)) return null;
    if (FINNHUB_KEYS.length === 0) {
        return DEFAULT_PROFILES[sym] || {
            name: sym,
            ticker: sym,
            currency: 'USD',
            exchange: 'US',
            finnhubIndustry: 'General',
            marketCapitalization: 100000,
        };
    }
    try {
        const url = `${FINNHUB_BASE_URL}/stock/profile2?symbol=${encodeURIComponent(sym)}`;
        const profile = await fetchJSON<FinnhubCompanyProfile>(url, 86400);
        return profile?.name ? profile : (DEFAULT_PROFILES[sym] || null);
    } catch (e) {
        logFailure('profile', sym, e);
        return DEFAULT_PROFILES[sym] || null;
    }
}

export async function getWatchlistData(symbols: string[]) {
    if (!symbols || symbols.length === 0) return [];

    const promises = symbols.map(async (sym) => {
        const covered = hasFinnhubQuotes(sym);
        const [quote, profile] = covered
            ? await Promise.all([getQuote(sym, LIVE_QUOTE_TTL), getCompanyProfile(sym)])
            : [null, null];

        return {
            symbol: sym,
            price: quote?.c || 0,
            change: quote?.d || 0,
            changePercent: quote?.dp || 0,
            currency: profile?.currency || 'USD',
            name: profile?.name || sym,
            logo: profile?.logo,
            marketCap: profile?.marketCapitalization,
            peRatio: 0
        };
    });

    return await Promise.all(promises);
}

export async function getNews(symbols?: string[]): Promise<MarketNewsArticle[]> {
    if (FINNHUB_KEYS.length === 0) {
        return DEFAULT_NEWS;
    }
    try {
        const range = getDateRange(5);
        const cleanSymbols = (symbols || [])
            .map((s) => s?.trim().toUpperCase())
            .filter((s): s is string => Boolean(s));

        const maxArticles = 6;

        if (cleanSymbols.length > 0) {
            const perSymbolArticles: Record<string, RawNewsArticle[]> = {};

            await Promise.all(
                cleanSymbols.map(async (sym) => {
                    try {
                        const url = `${FINNHUB_BASE_URL}/company-news?symbol=${encodeURIComponent(sym)}&from=${range.from}&to=${range.to}`;
                        const articles = await fetchJSON<RawNewsArticle[]>(url, 300);
                        perSymbolArticles[sym] = (articles || []).filter(validateArticle);
                    } catch (e) {
                        console.error('Error fetching company news for', sym, e);
                        perSymbolArticles[sym] = [];
                    }
                })
            );

            const collected: MarketNewsArticle[] = [];
            for (let round = 0; round < maxArticles; round++) {
                for (let i = 0; i < cleanSymbols.length; i++) {
                    const sym = cleanSymbols[i];
                    const list = perSymbolArticles[sym] || [];
                    if (list.length === 0) continue;
                    const article = list.shift();
                    if (!article || !validateArticle(article)) continue;
                    collected.push(formatArticle(article, true, sym, round));
                    if (collected.length >= maxArticles) break;
                }
                if (collected.length >= maxArticles) break;
            }

            if (collected.length > 0) {
                collected.sort((a, b) => (b.datetime || 0) - (a.datetime || 0));
                return collected.slice(0, maxArticles);
            }
        }

        const generalUrl = `${FINNHUB_BASE_URL}/news?category=general`;
        const general = await fetchJSON<RawNewsArticle[]>(generalUrl, 300);

        const seen = new Set<string>();
        const unique: RawNewsArticle[] = [];
        for (const art of general || []) {
            if (!validateArticle(art)) continue;
            const key = `${art.id}-${art.url}-${art.headline}`;
            if (seen.has(key)) continue;
            seen.add(key);
            unique.push(art);
            if (unique.length >= 20) break;
        }

        const formatted = unique.slice(0, maxArticles).map((a, idx) => formatArticle(a, false, undefined, idx));
        return formatted.length > 0 ? formatted : DEFAULT_NEWS;
    } catch (err) {
        console.warn('getNews error, returning default news:', err);
        return DEFAULT_NEWS;
    }
}

export const searchStocks = cache(async (query?: string): Promise<StockWithWatchlistStatus[]> => {
    try {
        const trimmed = typeof query === 'string' ? query.trim() : '';
        let results: SearchStockCandidate[] = [];

        if (!trimmed) {
            results = POPULAR_STOCKS.map(({ symbol, name, exchange }) => ({
                symbol,
                description: name,
                displaySymbol: symbol,
                type: 'Common Stock',
                __exchange: exchange,
            }));
        } else if (FINNHUB_KEYS.length === 0) {
            results = POPULAR_STOCKS
                .filter(({ symbol, name }) =>
                    symbol.toLowerCase().includes(trimmed.toLowerCase()) ||
                    name.toLowerCase().includes(trimmed.toLowerCase())
                )
                .map(({ symbol, name, exchange }) => ({
                    symbol,
                    description: name,
                    displaySymbol: symbol,
                    type: 'Common Stock',
                    __exchange: exchange,
                }));
        } else {
            const url = `${FINNHUB_BASE_URL}/search?q=${encodeURIComponent(trimmed)}`;
            const data = await fetchJSON<FinnhubSearchResponse>(url, 1800);
            results = Array.isArray(data?.result) ? data.result : [];
        }

        const mapped: StockWithWatchlistStatus[] = results
            .map((r) => {
                const upper = (r.symbol || '').toUpperCase();
                const name = r.description || upper;
                const exchangeFromProfile = r.__exchange;
                const exchange = getExchangeLabel(upper, exchangeFromProfile);
                const type = r.type || 'Stock';
                const item: StockWithWatchlistStatus = {
                    symbol: upper,
                    name,
                    exchange,
                    type,
                    isInWatchlist: false,
                };
                return item;
            })
            .slice(0, 15);

        return mapped;
    } catch (err) {
        console.error('Error in stock search:', err);
        return [];
    }
});
