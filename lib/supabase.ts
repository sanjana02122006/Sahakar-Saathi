"use client";

import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

if (!url || !anonKey) {
  throw new Error(
    "Missing Supabase env vars. Run `npm run env:pull` with SB_TOKEN set, or copy .env.example to .env.local."
  );
}

/**
 * Browser Supabase client. Static export means there is no server runtime —
 * auth lives entirely in the browser via persisted session + RLS on the DB.
 */
export const supabase = createClient(url, anonKey, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});
