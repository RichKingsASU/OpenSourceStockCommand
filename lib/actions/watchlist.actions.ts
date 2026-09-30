'use server';

import { connectToDatabase } from '@/database/mongoose';
import { Watchlist } from '@/database/models/watchlist.model';
import { revalidatePath } from 'next/cache';
import { requireUserId } from '@/lib/better-auth/auth';

interface WatchlistItemData {
    userId: string;
    symbol: string;
    company: string;
    addedAt: Date;
}

declare global {
    var __inMemoryWatchlist: Map<string, WatchlistItemData[]> | undefined;
}

const getStore = (): Map<string, WatchlistItemData[]> => {
    if (!global.__inMemoryWatchlist) {
        global.__inMemoryWatchlist = new Map<string, WatchlistItemData[]>();
    }
    return global.__inMemoryWatchlist;
};

const DEFAULT_INITIAL_WATCHLIST: Omit<WatchlistItemData, 'userId'>[] = [
    { symbol: 'AAPL', company: 'Apple Inc', addedAt: new Date(Date.now() - 3600000 * 24) },
    { symbol: 'NVDA', company: 'NVIDIA Corp', addedAt: new Date(Date.now() - 3600000 * 12) },
    { symbol: 'MSFT', company: 'Microsoft Corp', addedAt: new Date(Date.now() - 3600000 * 4) },
];

export async function addToWatchlist(symbol: string, company: string) {
    const userId = await requireUserId();
    const upper = symbol.toUpperCase();

    try {
        const mongoose = await connectToDatabase();
        if (mongoose) {
            const newItem = await Watchlist.findOneAndUpdate(
                { userId, symbol: upper },
                {
                    userId,
                    symbol: upper,
                    company,
                    addedAt: new Date(),
                },
                { upsert: true, new: true }
            );
            revalidatePath('/', 'layout');
            return JSON.parse(JSON.stringify(newItem));
        }
    } catch (error) {
        console.warn('MongoDB watchlist add fallback to memory store:', error);
    }

    const store = getStore();
    const list = store.get(userId) || DEFAULT_INITIAL_WATCHLIST.map((item) => ({ ...item, userId }));
    const filtered = list.filter((i) => i.symbol !== upper);
    const item: WatchlistItemData = { userId, symbol: upper, company, addedAt: new Date() };
    filtered.unshift(item);
    store.set(userId, filtered);

    revalidatePath('/', 'layout');
    return item;
}

export async function removeFromWatchlist(symbol: string) {
    const userId = await requireUserId();
    const upper = symbol.toUpperCase();

    try {
        const mongoose = await connectToDatabase();
        if (mongoose) {
            await Watchlist.findOneAndDelete({ userId, symbol: upper });
        }
    } catch (error) {
        console.warn('MongoDB watchlist remove fallback to memory store:', error);
    }

    const store = getStore();
    const list = store.get(userId) || DEFAULT_INITIAL_WATCHLIST.map((item) => ({ ...item, userId }));
    store.set(userId, list.filter((i) => i.symbol !== upper));

    revalidatePath('/', 'layout');
    return { success: true };
}

export async function getUserWatchlist() {
    try {
        const userId = await requireUserId();
        try {
            const mongoose = await connectToDatabase();
            if (mongoose) {
                const watchlist = await Watchlist.find({ userId }).sort({ addedAt: -1 });
                if (watchlist && watchlist.length > 0) {
                    return JSON.parse(JSON.stringify(watchlist));
                }
            }
        } catch (error) {
            console.warn('MongoDB watchlist get fallback to memory store:', error);
        }

        const store = getStore();
        if (!store.has(userId)) {
            store.set(userId, DEFAULT_INITIAL_WATCHLIST.map((item) => ({ ...item, userId })));
        }
        return store.get(userId) || [];
    } catch {
        return [];
    }
}

export async function isStockInWatchlist(symbol: string) {
    try {
        const userId = await requireUserId();
        const upper = symbol.toUpperCase();

        try {
            const mongoose = await connectToDatabase();
            if (mongoose) {
                const item = await Watchlist.findOne({ userId, symbol: upper });
                return !!item;
            }
        } catch {
            // fallback
        }

        const store = getStore();
        const list = store.get(userId) || DEFAULT_INITIAL_WATCHLIST.map((item) => ({ ...item, userId }));
        return list.some((i) => i.symbol === upper);
    } catch {
        return false;
    }
}
