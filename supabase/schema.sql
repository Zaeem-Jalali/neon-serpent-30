-- Neon Serpent 30 — Supabase schema.
--
-- Paste this whole file into the Supabase SQL editor (Project -> SQL Editor
-- -> New query) and run it once, after the project itself exists. Safe to
-- re-run: every statement is guarded so a second run is a no-op rather than
-- an error.
--
-- Design notes:
--   - Auth is Google OAuth + anonymous guest play, no email/password, so
--     this schema never stores a credential of any kind.
--   - "runs" is an append-only history, never mutated or deleted. The old
--     server.js leaderboard kept exactly one best row per name and
--     overwrote it in place; here the same "one best run per player per
--     board" rule is enforced at READ time (see the `leaderboard` view
--     below) rather than by throwing away every run but the best. That
--     keeps a full history for free, which is what "Daily History" wants
--     once it moves off localStorage-only.
--   - RLS on every table: a row can only ever be written by the user_id it
--     belongs to. Reads are public on `runs`/`profiles`/`leaderboard`
--     because the whole point is other players seeing your score; reads on
--     `level_progress` are private, since campaign progress is not a
--     leaderboard-shaped thing anyone else needs to see.

-- ---------------------------------------------------------------------
-- profiles: one row per player, holding just the leaderboard display name.
-- ---------------------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null default '' check (char_length(display_name) <= 24),
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

drop policy if exists "profiles are publicly readable" on public.profiles;
create policy "profiles are publicly readable"
  on public.profiles for select
  using (true);

drop policy if exists "users insert their own profile" on public.profiles;
create policy "users insert their own profile"
  on public.profiles for insert
  with check (auth.uid() = id);

drop policy if exists "users update their own profile" on public.profiles;
create policy "users update their own profile"
  on public.profiles for update
  using (auth.uid() = id);

-- A new auth.users row (Google sign-in or anonymous) always needs a
-- matching profiles row before it can be referenced from `runs` or
-- `level_progress`, so create one automatically rather than relying on the
-- client to remember to do it as a separate step.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, display_name) values (new.id, '');
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------
-- runs: one row per finished run. Append-only — see the design note above
-- for why this is never updated or deleted from the client.
-- ---------------------------------------------------------------------
create table if not exists public.runs (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  mode text not null check (mode in ('campaign', 'daily')),
  seed text not null default 'campaign',
  score integer not null check (score >= 0 and score <= 10000000),
  level_reached integer not null check (level_reached between 1 and 30),
  started_level integer not null default 0 check (started_level >= 0),
  duration_ms integer check (duration_ms is null or duration_ms >= 0),
  created_at timestamptz not null default now()
);

alter table public.runs enable row level security;

drop policy if exists "runs are publicly readable" on public.runs;
create policy "runs are publicly readable"
  on public.runs for select
  using (true);

drop policy if exists "users insert their own runs" on public.runs;
create policy "users insert their own runs"
  on public.runs for insert
  with check (auth.uid() = user_id);

-- No update or delete policy on purpose: with none granted, RLS blocks both
-- outright, which is what "append-only" should mean at the database level,
-- not just by client convention.

create index if not exists runs_leaderboard_idx on public.runs (mode, seed, score desc);
create index if not exists runs_user_idx on public.runs (user_id, created_at desc);

/* Server-side rate limit on run submissions.
 *
 * RLS decides WHO may write a row; it says nothing about HOW OFTEN. Without
 * this, an authenticated client — including a guest account anyone can mint
 * for free — could insert rows in a loop, inflate the leaderboard and burn
 * through the project's database quota. Enforced in the database rather
 * than the client because anything enforced only in the client is a
 * suggestion.
 *
 * A real run takes minutes; the honest client posts once when a run ends.
 * 10 per minute leaves enormous headroom for legitimate play (including
 * fast restarts on early levels) while capping abuse at a level that cannot
 * meaningfully cost anything.
 */
create or replace function public.enforce_run_rate_limit()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  recent_count integer;
begin
  select count(*) into recent_count
  from public.runs
  where user_id = new.user_id
    and created_at > now() - interval '1 minute';

  if recent_count >= 10 then
    raise exception 'Rate limit exceeded: too many runs submitted. Please wait a moment.'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists runs_rate_limit on public.runs;
create trigger runs_rate_limit
  before insert on public.runs
  for each row execute function public.enforce_run_rate_limit();

/* Same reasoning for profile renames: the display name is the one piece of
   user-controlled text other players see, so it is worth stopping anyone
   cycling it rapidly. Needs its own timestamp — created_at never changes,
   so it cannot measure the gap between two renames. */
alter table public.profiles
  add column if not exists updated_at timestamptz not null default now();

create or replace function public.enforce_profile_update_limit()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if new.display_name is distinct from old.display_name then
    if old.updated_at > now() - interval '5 seconds' then
      raise exception 'Please wait a few seconds before changing your display name again.'
        using errcode = 'check_violation';
    end if;
    new.updated_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_rename_limit on public.profiles;
create trigger profiles_rename_limit
  before update on public.profiles
  for each row execute function public.enforce_profile_update_limit();

-- One best run per player per board, newest run wins any score tie. Views
-- default to running as their owner, which would bypass the RLS on `runs`
-- and `profiles` above — security_invoker makes it run as the querying user
-- instead, so the view's own access is exactly as public/private as the
-- tables it reads.
create or replace view public.leaderboard
with (security_invoker = true) as
select distinct on (r.user_id, r.mode, r.seed)
  r.user_id,
  p.display_name,
  r.mode,
  r.seed,
  r.score,
  r.level_reached,
  r.created_at
from public.runs r
join public.profiles p on p.id = r.user_id
order by r.user_id, r.mode, r.seed, r.score desc, r.created_at asc;

-- ---------------------------------------------------------------------
-- level_progress: campaign unlock/completion state, synced up from
-- localStorage on first sign-in. Private — nobody else needs to see which
-- levels you have cleared, only your own best score.
-- ---------------------------------------------------------------------
create table if not exists public.level_progress (
  user_id uuid not null references auth.users (id) on delete cascade,
  level_index integer not null check (level_index between 0 and 29),
  completed boolean not null default false,
  best_score integer not null default 0 check (best_score >= 0),
  updated_at timestamptz not null default now(),
  primary key (user_id, level_index)
);

alter table public.level_progress enable row level security;

drop policy if exists "users read their own progress" on public.level_progress;
create policy "users read their own progress"
  on public.level_progress for select
  using (auth.uid() = user_id);

drop policy if exists "users insert their own progress" on public.level_progress;
create policy "users insert their own progress"
  on public.level_progress for insert
  with check (auth.uid() = user_id);

drop policy if exists "users update their own progress" on public.level_progress;
create policy "users update their own progress"
  on public.level_progress for update
  using (auth.uid() = user_id);
