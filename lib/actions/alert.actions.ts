'use server';

import { connectToDatabase } from '@/database/mongoose';
import { Alert } from '@/database/models/alert.model';
import { revalidatePath } from 'next/cache';
import { requireUserId } from '@/lib/better-auth/auth';
import { hasFinnhubQuotes } from '@/lib/markets';
import { alertsEnabled } from '@/lib/market-data';

interface AlertItemData {
    _id: string;
    userId: string;
    symbol: string;
    targetPrice: number;
    condition: 'ABOVE' | 'BELOW';
    active: boolean;
    triggered: boolean;
    expiresAt: Date;
    createdAt: Date;
}

declare global {
    var __inMemoryAlerts: Map<string, AlertItemData[]> | undefined;
}

const getStore = (): Map<string, AlertItemData[]> => {
    if (!global.__inMemoryAlerts) {
        global.__inMemoryAlerts = new Map<string, AlertItemData[]>();
    }
    return global.__inMemoryAlerts;
};

// A ticker (AAPL, BRK.B) or a Binance pair. Anything else, including markup, is rejected
const SYMBOL_PATTERN = /^(BINANCE:[A-Z0-9]{2,20}|[A-Z0-9][A-Z0-9.-]{0,14})$/;
const CONDITIONS = ['ABOVE', 'BELOW'];

// Create a new alert.
export async function createAlert(params: {
    symbol: string;
    targetPrice: number;
    condition: 'ABOVE' | 'BELOW';
}) {
    const userId = await requireUserId();
    if (!alertsEnabled) throw new Error('Price alerts are part of OpenStock Cloud');
    const symbol = String(params.symbol ?? '').trim().toUpperCase();
    const targetPrice = Number(params.targetPrice);
    const condition = params.condition;

    if (!SYMBOL_PATTERN.test(symbol)) throw new Error('Invalid symbol');
    if (!CONDITIONS.includes(condition)) throw new Error('Invalid condition');
    if (!hasFinnhubQuotes(symbol)) throw new Error('Alerts are available for US stocks and crypto');
    if (!Number.isFinite(targetPrice) || targetPrice <= 0) throw new Error('Target price must be a positive number');

    try {
        const mongoose = await connectToDatabase();
        if (mongoose) {
            const newAlert = await Alert.create({ userId, symbol, targetPrice, condition, active: true });
            revalidatePath('/watchlist');
            return JSON.parse(JSON.stringify(newAlert));
        }
    } catch (error) {
        console.warn('MongoDB create alert fallback to memory store:', error);
    }

    const store = getStore();
    const list = store.get(userId) || [];
    const newAlert: AlertItemData = {
        _id: 'alert_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7),
        userId,
        symbol,
        targetPrice,
        condition,
        active: true,
        triggered: false,
        expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
        createdAt: new Date(),
    };
    list.unshift(newAlert);
    store.set(userId, list);

    revalidatePath('/watchlist');
    return newAlert;
}

// Get all alerts for a user
export async function getUserAlerts() {
    try {
        const userId = await requireUserId();
        try {
            const mongoose = await connectToDatabase();
            if (mongoose) {
                const alerts = await Alert.find({ userId }).sort({ createdAt: -1 });
                if (alerts && alerts.length > 0) {
                    return JSON.parse(JSON.stringify(alerts));
                }
            }
        } catch (error) {
            console.warn('MongoDB get alerts fallback to memory store:', error);
        }

        const store = getStore();
        return store.get(userId) || [];
    } catch {
        return [];
    }
}

// Delete an alert
export async function deleteAlert(alertId: string) {
    const userId = await requireUserId();
    try {
        const mongoose = await connectToDatabase();
        if (mongoose) {
            await Alert.findOneAndDelete({ _id: alertId, userId });
        }
    } catch (error) {
        console.warn('MongoDB delete alert fallback to memory store:', error);
    }

    const store = getStore();
    const list = store.get(userId) || [];
    store.set(userId, list.filter((a) => a._id !== alertId));

    revalidatePath('/watchlist');
    return { success: true };
}
