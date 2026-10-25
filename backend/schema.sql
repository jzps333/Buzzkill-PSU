-- Buzzkill database
-- Paste this whole file into Supabase → SQL Editor → Run.
-- Supabase already handles logins (the auth.users table). These are OUR tables.


-- 1. PROFILES: one row per user (players and guests)
create table public.profiles (
  id        uuid primary key references auth.users on delete cascade,  -- same id as the login
  username  text not null,
  is_guest  boolean not null default false,
  wallet    text                                                        -- Solana address (optional)
);

-- Real users can't share a username. Guests can.
create unique index profiles_username_unique on public.profiles (lower(username)) where not is_guest;


-- 2. GAMES: one row per study session
create table public.games (
  code        text primary key,                 -- room code, e.g. ABC123
  status      text not null default 'waiting',  -- waiting / live / ended
  start_time  timestamptz,
  end_time    timestamptz
);


-- 3. RESULTS: one row per person per game. Every stat comes from here.
create table public.results (
  game      text references public.games (code) on delete cascade,
  user_id   uuid references public.profiles (id) on delete cascade,
  pickups   int not null default 0,       -- times they picked up their phone
  sol_in    numeric not null default 0,   -- SOL they staked
  sol_back  numeric not null default 0,   -- SOL they got back at the end
  primary key (game, user_id)
);


-- 4. Make a profile automatically every time someone signs up or joins as a guest
create function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
begin
  insert into public.profiles (id, username, is_guest)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'username', 'player'),
    coalesce(new.is_anonymous, false)
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();


-- 5. LEADERBOARD: stats for every real user, most focused first
--    pickups_per_hour = fewer is better (fair no matter how long or how often you played)
--    avg_sol / total_sol = SOL back minus SOL in (positive = winning money)
create view public.leaderboard
with (security_invoker = on) as
select
  p.id,
  p.username,
  count(*)                                                     as games,
  sum(r.pickups)                                               as total_pickups,
  round(sum(r.pickups) * 3600.0
        / greatest(sum(extract(epoch from g.end_time - g.start_time)), 1), 2)
                                                               as pickups_per_hour,
  round(avg(case when r.pickups = 0 then 1.0 else 0 end) * 100, 1)
                                                               as clean_pct,
  round(sum(extract(epoch from g.end_time - g.start_time)) / 60.0, 1)
                                                               as minutes_played,
  round(avg(case when r.sol_in > 0 then r.sol_back - r.sol_in end), 4)
                                                               as avg_sol,
  round(sum(r.sol_back - r.sol_in), 4)                         as total_sol
from public.results r
join public.profiles p on p.id = r.user_id
join public.games g    on g.code = r.game
where g.status = 'ended'
  and not p.is_guest
group by p.id, p.username
order by pickups_per_hour asc, clean_pct desc, minutes_played desc;


-- 6. SECURITY (Row Level Security)
--    Everyone can READ (so the leaderboard works).
--    Users can only edit their OWN profile (e.g. add a wallet).
--    Games and results are only written by the Pi, using the secret key,
--    so nobody can cheat by changing their own pickups.
alter table public.profiles enable row level security;
alter table public.games    enable row level security;
alter table public.results  enable row level security;

create policy "anyone can read profiles" on public.profiles for select using (true);
create policy "anyone can read games"    on public.games    for select using (true);
create policy "anyone can read results"  on public.results  for select using (true);

create policy "users edit own profile" on public.profiles
  for update using (auth.uid() = id) with check (auth.uid() = id);
