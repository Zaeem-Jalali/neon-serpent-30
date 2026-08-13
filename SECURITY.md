# Security

An honest account of what this project defends against, how, and what it
does **not** protect against. Nothing here claims the game is "unhackable" —
no software is, and a client-side game is a particularly hard case, because
everything it ships is by definition in the player's hands.

## Reporting a vulnerability

Email **jalalizaeem@gmail.com**. Please do not open a public GitHub issue for
a security problem.

## Secrets

**There are no secret keys in this repository, and there cannot be.** The
game is a static site: every file it ships is readable by anyone who loads
it. The security model is built around that fact rather than fighting it.

| Credential | Where it lives | Why that is safe |
| --- | --- | --- |
| Supabase **anon** key | `src/supabaseConfig.js`, public | Designed to be public. It grants no access on its own — every table is gated by Row Level Security (below). |
| Supabase **service_role** key | **Nowhere in this repo** | Bypasses RLS entirely. It must never be placed in client code. |
| Google OAuth **client secret** | Supabase dashboard only | Never reaches the browser. The OAuth flow is handled by Supabase's backend. |

If the anon key is ever rotated, update `src/supabaseConfig.js`. Leaking it
is not a security incident; leaking `service_role` would be.

## Database access control

Every table has Row Level Security enabled (`supabase/schema.sql`):

- A row can only be written by the authenticated user it belongs to
  (`auth.uid() = user_id`).
- `runs` is **append-only**. No `update` or `delete` policy is granted, so
  RLS refuses both outright — a player cannot edit or erase history,
  including their own.
- `level_progress` is private: readable only by its owner.
- `profiles` and `runs` are publicly readable by design; a leaderboard that
  nobody can read is not a leaderboard. Only the display name is exposed —
  never an email address.
- The `leaderboard` view is declared `security_invoker`, so it runs with the
  querying user's permissions. Without that, a view silently runs as its
  owner and bypasses the very policies above.

## Abuse and denial of service

- **Run submissions are rate limited in the database** (10/minute/user, via
  a `before insert` trigger). This is enforced server-side because anything
  enforced only in the client is a suggestion. It exists specifically so a
  free guest account cannot be minted and looped to inflate the leaderboard
  or burn the project's quota.
- **Display-name changes are rate limited** (one per 5 seconds).
- **The local dev server rate limits per IP** (`server.js`: 120 reads and 20
  writes per minute) and caps request bodies at 4 KB.
- **Input is validated server-side**: score, level and seed are range- and
  pattern-checked, names are stripped of control characters and length
  capped.
- **Network-level DoS protection is the host's job.** Netlify sits in front
  of the static site and Supabase in front of the database; both operate
  their own DDoS mitigation at a scale application code cannot replicate.

## Browser-side hardening

- A strict **Content Security Policy** with no `'unsafe-inline'` anywhere
  (`netlify.toml`, mirrored in `server.js`). Scripts may load only from the
  site itself and `esm.sh`; connections only to the site and Supabase. This
  is why the service worker is registered from a file rather than inline.
- `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY` and
  `frame-ancestors 'none'` (clickjacking), `Referrer-Policy`,
  `Permissions-Policy` denying geolocation/camera/microphone/payment/USB,
  and `Cross-Origin-Opener-Policy: same-origin`.
- **All user-supplied text is rendered with `textContent`, never
  `innerHTML`** — leaderboard names come from other players and are the one
  genuine XSS vector in the app.
- Static file serving blocks path traversal, dotfiles and the score store.

## Known limitations

Stated plainly rather than buried:

1. **Scores are self-reported and are not cheat-proof.** RLS proves *who*
   submitted a run; it cannot prove the run was really played. A determined
   player can submit a fabricated score. The fix is server-side replay
   validation — the engine is fully deterministic and DOM-free, so
   `{seed, startLevel, inputs[]}` is enough to replay a run headlessly and
   verify the score. That is a planned follow-up, not something already in
   place.
2. **Client-side code cannot keep secrets.** Anything the browser needs, the
   player has. This is why the architecture puts all trust decisions in the
   database rather than in the client.
3. **Rate limits reduce abuse; they do not eliminate it.** Someone willing
   to create many accounts can still submit many runs, just slowly.
4. **No independent security audit has been performed.** This document
   describes measures taken in good faith, not a certification.
