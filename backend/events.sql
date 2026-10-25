-- Buzzkill: live events (run AFTER schema.sql)
-- Phones write events here. The Pi listens live (Supabase Realtime) and reacts.


-- 1. EVENTS: every join, pickup and shake from a phone
create table public.events (
  id          bigint generated always as identity primary key,
  game        text not null references public.games (code) on delete cascade,
  user_id     uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  type        text not null check (type in ('join', 'pickup', 'left_page', 'shake')),
  created_at  timestamptz not null default now()
);


-- 2. SECURITY
--    A phone can only add events as ITSELF, and only for a game that is still open.
--    Only the Pi (secret key) turns events into pickups and SOL, so nobody can cheat.
alter table public.events enable row level security;

create policy "players add own events" on public.events
  for insert to authenticated
  with check (
    user_id = auth.uid()
    and exists (select 1 from public.games g
                where g.code = game and g.status in ('waiting', 'live'))
  );

create policy "anyone can read events" on public.events for select using (true);


-- 3. TURN ON REALTIME
--    events → the Pi hears every pickup instantly
--    games  → phones see when the game starts and ends
alter publication supabase_realtime add table public.events;
alter publication supabase_realtime add table public.games;
