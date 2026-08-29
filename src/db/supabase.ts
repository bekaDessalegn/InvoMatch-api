import { createClient } from "@supabase/supabase-js";

import { env } from "../config/env";

/**
 * Server-side Supabase client, authenticated with the service-role key.
 *
 * This client bypasses Row Level Security and must only ever be used from
 * trusted backend code — never returned to or instantiated in the Flutter
 * app. All CRUD routes and Claude-powered endpoints should read/write the
 * database exclusively through this client.
 */
export const supabase = createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});
