/* Supabase project connection details.
 *
 * The anon/publishable key below is NOT a secret — Supabase's security model
 * puts it in every client bundle on purpose and relies on Row Level Security
 * (see supabase/schema.sql) to decide what it can actually read or write.
 * The one key that must never end up here is the service_role key, which
 * bypasses RLS entirely and has no business existing outside a trusted
 * server.
 *
 * Left blank, the game runs exactly as it does today: local-only saves, no
 * sign-in, no synced leaderboard. Fill both in once the Supabase project
 * exists (see supabase/schema.sql for the SQL to run there first) and
 * accounts/leaderboard sync turn on automatically — nothing else to flip.
 */
export const SUPABASE_URL = "https://rapqtznhwpoaerghfeii.supabase.co";
export const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJhcHF0em5od3BvYWVyZ2hmZWlpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY1NTQ5OTYsImV4cCI6MjEwMjEzMDk5Nn0.YZXt0SG7xg00zn_o2mJ0Zpkew6PuINUtjTZOlkfc2Bk";

export const isSupabaseConfigured = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
