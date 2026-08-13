/* Thin wrapper around the Supabase client: auth state, the leaderboard view,
 * and campaign-progress sync. Kept separate from main.js so the "no Supabase
 * configured" path (isSupabaseConfigured === false) never has to think about
 * any of this — every export below resolves to a harmless no-op in that case,
 * the same degrade-silently contract src/supabaseClient.js already has.
 */
import { getSupabaseClient } from "./supabaseClient.js";
import { isSupabaseConfigured } from "./supabaseConfig.js";

let client = null;
let clientReady = null;
let currentUser = null;
const listeners = new Set();

function ensureClient() {
  if (!isSupabaseConfigured) return Promise.resolve(null);
  if (!clientReady) {
    clientReady = getSupabaseClient().then((c) => {
      client = c;
      if (client) {
        client.auth.onAuthStateChange((_event, session) => {
          currentUser = session?.user || null;
          listeners.forEach((fn) => fn(currentUser));
        });
      }
      return client;
    });
  }
  return clientReady;
}

// Fires once immediately on subscribe with the current user (or null), then
// again on every sign-in/sign-out. Mirrors the shape of a DOM event
// listener's unsubscribe pattern so callers don't need to track state.
export function onAuthChange(fn) {
  listeners.add(fn);
  fn(currentUser);
  return () => listeners.delete(fn);
}

export function getCurrentUser() {
  return currentUser;
}

export async function restoreSession() {
  const c = await ensureClient();
  if (!c) return null;
  const { data } = await c.auth.getSession();
  currentUser = data?.session?.user || null;
  return currentUser;
}

export async function signInWithGoogle() {
  const c = await ensureClient();
  if (!c) return { error: "Cloud sync is not configured." };
  // Full-page redirect to Google and back — same origin/path, so
  // detectSessionInUrl (set in supabaseClient.js) picks the session up on
  // return without any extra code here.
  const { error } = await c.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: window.location.origin + window.location.pathname }
  });
  return { error: error ? error.message : null };
}

export async function signInAsGuest() {
  const c = await ensureClient();
  if (!c) return { error: "Cloud sync is not configured." };
  const { data, error } = await c.auth.signInAnonymously();
  if (data?.user) currentUser = data.user;
  return { error: error ? error.message : null };
}

export async function signOutCloud() {
  const c = await ensureClient();
  if (!c) return;
  await c.auth.signOut();
  currentUser = null;
}

export async function setCloudDisplayName(name) {
  const c = await ensureClient();
  if (!c || !currentUser) return;
  await c.from("profiles").update({ display_name: name }).eq("id", currentUser.id);
}

// Pushes local per-level stats up to the cloud, merging rather than
// overwriting: each field only ever moves toward "more complete" (best_score
// can only increase, completed can only flip true), so a stale local
// snapshot from an old device can never erase better progress made
// elsewhere. Safe to call on every sign-in and every level clear.
export async function syncLevelProgress(levelStats) {
  const c = await ensureClient();
  if (!c || !currentUser) return;
  const rows = Object.entries(levelStats || {})
    .map(([levelIndex, stat]) => ({
      level_index: Number(levelIndex),
      completed: !!stat.completed,
      best_score: Math.max(0, Math.floor(stat.best || 0))
    }))
    .filter((row) => Number.isInteger(row.level_index));
  if (!rows.length) return;

  const { data: existing } = await c
    .from("level_progress")
    .select("level_index, completed, best_score")
    .eq("user_id", currentUser.id);
  const existingByIndex = new Map((existing || []).map((row) => [row.level_index, row]));

  const merged = rows.map((row) => {
    const prior = existingByIndex.get(row.level_index);
    return {
      user_id: currentUser.id,
      level_index: row.level_index,
      completed: row.completed || !!prior?.completed,
      best_score: Math.max(row.best_score, prior?.best_score || 0)
    };
  });
  await c.from("level_progress").upsert(merged, { onConflict: "user_id,level_index" });
}

// The read half of the merge above: cloud progress the local device has
// never seen (e.g. cleared on a different device) needs to flow back down
// too. Caller is responsible for merging this with local levelStats using
// the same "higher wins" rule.
export async function fetchCloudLevelProgress() {
  const c = await ensureClient();
  if (!c || !currentUser) return null;
  const { data, error } = await c
    .from("level_progress")
    .select("level_index, completed, best_score")
    .eq("user_id", currentUser.id);
  if (error) return null;
  const stats = {};
  for (const row of data || []) {
    stats[row.level_index] = { completed: row.completed, best: row.best_score };
  }
  return stats;
}

export async function postRunToCloud({ mode, seed, score, level, startedLevel }) {
  const c = await ensureClient();
  if (!c || !currentUser) return { posted: false };
  const { error } = await c.from("runs").insert({
    user_id: currentUser.id,
    mode,
    seed,
    score,
    level_reached: level,
    started_level: startedLevel
  });
  return { posted: !error, error: error ? error.message : null };
}

// Normalises to {name, score, level} — the same shape the old /api/scores
// endpoint returns — so the rendering code in main.js does not need to know
// which backend answered it.
export async function fetchCloudLeaderboard(mode, seed) {
  const c = await ensureClient();
  if (!c) return null;
  let query = c
    .from("leaderboard")
    .select("display_name, score, level_reached")
    .eq("mode", mode)
    .order("score", { ascending: false })
    .limit(50);
  if (mode === "daily") query = query.eq("seed", seed);
  const { data, error } = await query;
  if (error) return null;
  return data.map((row) => ({
    name: row.display_name || "Anonymous",
    score: row.score,
    level: row.level_reached
  }));
}
