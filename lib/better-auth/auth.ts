import { betterAuth } from "better-auth";
import { mongodbAdapter } from "better-auth/adapters/mongodb";
import { memoryAdapter } from "better-auth/adapters/memory";
import { connectToDatabase } from "@/database/mongoose";
import { nextCookies } from "better-auth/next-js";
import { headers } from "next/headers";
import { cache } from "react";
import { sendPasswordResetEmail } from "@/lib/nodemailer/reset-password";

type MemoryRecord = Record<string, unknown>;

declare global {
    var __betterAuthMemoryStore: {
        user: MemoryRecord[];
        session: MemoryRecord[];
        account: MemoryRecord[];
        verification: MemoryRecord[];
        rateLimit: MemoryRecord[];
        jwks: MemoryRecord[];
        [key: string]: MemoryRecord[];
    } | undefined;
}

export const memoryStore = global.__betterAuthMemoryStore || (global.__betterAuthMemoryStore = {
    user: [],
    session: [],
    account: [],
    verification: [],
    rateLimit: [],
    jwks: [],
});

type AuthAdapter = ReturnType<typeof memoryAdapter> | ReturnType<typeof mongodbAdapter>;

// Typed from the real config, so additional user fields (country, ...) show up in session types
const createAuth = (adapter: AuthAdapter) => betterAuth({
    database: adapter,
    secret: process.env.BETTER_AUTH_SECRET || "openstock-dev-secret-key-at-least-32-characters!",
    baseURL: process.env.BETTER_AUTH_URL || "http://localhost:3000",
    // Onboarding answers live on the user so the profile page can show and edit them
    user: {
        additionalFields: {
            country: { type: "string", required: false },
            investmentGoals: { type: "string", required: false },
            riskTolerance: { type: "string", required: false },
            preferredIndustry: { type: "string", required: false },
        },
    },
    emailAndPassword: {
        enabled: true,
        disableSignUp: false,
        requireEmailVerification: false,
        minPasswordLength: 8,
        maxPasswordLength: 128,
        autoSignIn: true,
        sendResetPassword: async ({ user, url }) => {
            void sendPasswordResetEmail({
                email: user.email,
                name: user.name,
                resetUrl: url,
            }).catch((error) => {
                console.error('Failed to queue password reset email:', error);
            });
        },
    },
    // Signed session cookie for 5 min: pages stop paying a round trip per request.
    session: {
        cookieCache: { enabled: true, maxAge: 5 * 60 },
    },
    account: {
        accountLinking: { enabled: false },
    },
    // Providers stay disabled until their env vars are set
    socialProviders: {
        google: {
            enabled: !!process.env.GOOGLE_CLIENT_ID,
            clientId: (process.env.GOOGLE_CLIENT_ID as string) || "",
            clientSecret: (process.env.GOOGLE_CLIENT_SECRET as string) || "",
        },
        github: {
            enabled: !!process.env.GITHUB_CLIENT_ID,
            clientId: (process.env.GITHUB_CLIENT_ID as string) || "",
            clientSecret: (process.env.GITHUB_CLIENT_SECRET as string) || "",
        },
    },
    plugins: [nextCookies()],
});

let mongoDbInstance: Parameters<typeof mongodbAdapter>[0] | null = null;
if (process.env.MONGODB_URI) {
    try {
        const mongoose = await connectToDatabase();
        mongoDbInstance = (mongoose?.connection?.db as unknown as Parameters<typeof mongodbAdapter>[0]) || null;
    } catch {
        mongoDbInstance = null;
    }
}

export const auth = createAuth(
    mongoDbInstance ? mongodbAdapter(mongoDbInstance) : memoryAdapter(memoryStore)
);

// One session lookup per request, shared by layouts, pages and actions
export const getSession = cache(async () => {
    try {
        return await auth.api.getSession({ headers: await headers() });
    } catch {
        return null;
    }
});

// Server actions are public endpoints: never trust a userId sent from the client.
export const requireUserId = async () => {
    const session = await getSession();
    if (!session?.user) throw new Error("Unauthorized");
    return session.user.id;
};
