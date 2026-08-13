/* Lazily loads the Supabase JS SDK from a CDN and hands back a shared client.
 *
 * Loaded via dynamic import rather than a <script type="module"> tag in
 * index.html so that an unconfigured project (SUPABASE_URL/ANON_KEY both
 * blank) never fetches the SDK at all — the game keeps running exactly as
 * it does today, local-only, with zero added network requests.
 *
 * The CDN host (esm.sh) and Supabase's own API host are both allow-listed in
 * the CSP (see netlify.toml and server.js's securityHeaders) — a stricter
 * policy would silently block this import with no visible error beyond the
 * browser console.
 */
import { SUPABASE_URL, SUPABASE_ANON_KEY, isSupabaseConfigured } from "./supabaseConfig.js";

let clientPromise = null;

export function getSupabaseClient() {
  if (!isSupabaseConfigured) return Promise.resolve(null);
  if (!clientPromise) {
    clientPromise = import("https://esm.sh/@supabase/supabase-js@2")
      .then(({ createClient }) =>
        createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
          auth: {
            persistSession: true,
            autoRefreshToken: true,
            // Reads the access token Supabase appends to the URL after an
            // OAuth redirect back from Google, then strips it.
            detectSessionInUrl: true
          }
        })
      )
      .catch((err) => {
        // Offline, CDN unreachable, ad blocker, whatever — accounts/sync
        // are a bonus, not a requirement to play, so this degrades to the
        // same "no account features" state as leaving the config blank.
        console.error("Supabase client failed to load; continuing without it.", err);
        return null;
      });
  }
  return clientPromise;
}
