-- Buzzkill: game rules live in the database (run AFTER schema.sql, events.sql, security.sql)
--
-- The database is the referee. Phones send events, the database counts pickups,
-- runs the shake penalty, and pays out. The Pi (or the website's host page as a backup)
-- only starts/ends games and plays sounds.


-- 1. NEW COLUMNS
alter table public.games
  add column host_id uuid references public.profiles (id) on delete set null;   -- who started it from the website (null = the Pi)

alter table public.results
  add column alarm_on        boolean     not null default false,  -- roast is playing for this person
  add column shake_secs_needed numeric   not null default 0,      -- seconds of shaking to turn it off (30 per pickup)
  add column shake_secs_done   numeric   not null default 0,      -- seconds shaken so far
  add column is_shaking        boolean   not null default false,  -- shaking right now = sound paused
  add column first_pickup_at timestamptz,                         -- for "First to Fold"
  add column last_shake_at   timestamptz;                         -- stops shake spamming


-- 2. WHO IS ALLOWED TO RUN A GAME: the Pi (secret key) or the person who created it
create or replace function public.can_host(p_code text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select auth.role() = 'service_role'
      or exists (select 1 from public.games where code = p_code and host_id = auth.uid());
$$;


-- 3. CREATE A GAME (logged-in, non-guest users from the website; the Pi can also call it)
create or replace function public.create_game()
returns text
language plpgsql security definer set search_path = ''
as $$
declare
  new_code text;
begin
  if auth.role() <> 'service_role' and not exists (
       select 1 from public.profiles where id = auth.uid() and not is_guest) then
    raise exception 'Log in (not as a guest) to host a game';
  end if;

  loop
    new_code := upper(substr(md5(random()::text), 1, 6));
    exit when not exists (select 1 from public.games where code = new_code);
  end loop;

  insert into public.games (code, status, host_id)
  values (new_code, 'waiting', case when auth.role() = 'service_role' then null else auth.uid() end);
  return new_code;
end;
$$;


-- 4. START A GAME (needs at least 4 players, always, for everyone including the Pi)
create or replace function public.start_game(p_code text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  players int;
begin
  if not public.can_host(p_code) then raise exception 'Only the host can start this game'; end if;

  select count(*) into players from public.results where game = p_code;
  if players < 4 then
    raise exception 'Need at least 4 players to start (you have %)', players;
  end if;

  update public.games set status = 'live', start_time = now()
  where code = p_code and status = 'waiting';
end;
$$;


-- 5. END A GAME + PAY OUT
--    Each pickup loses 0.02 SOL (never more than you put in).
--    Players with 0 pickups split everything that was lost, by how much they put in.
--    If nobody has 0 pickups, everyone gets their stake back.
create or replace function public.finish_game(p_code text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  pot         numeric;
  clean_total numeric;
begin
  if not public.can_host(p_code) then raise exception 'Only the host can end this game'; end if;

  update public.games set status = 'ended', end_time = now()
  where code = p_code and status = 'live';
  if not found then return; end if;

  update public.results set alarm_on = false, is_shaking = false where game = p_code;

  select coalesce(sum(least(pickups * 0.02, sol_in)), 0) into pot
  from public.results where game = p_code and sol_in > 0;

  select coalesce(sum(sol_in), 0) into clean_total
  from public.results where game = p_code and sol_in > 0 and pickups = 0;

  update public.results set sol_back = round(
    case
      when clean_total = 0 then sol_in                                   -- nobody clean: refund
      when pickups = 0     then sol_in + pot * sol_in / clean_total      -- clean: stake + share of pot
      else                      sol_in - least(pickups * 0.02, sol_in)   -- slipped: stake minus losses
    end, 9)                                                              -- 9 decimals = smallest SOL unit
  where game = p_code and sol_in > 0;
end;
$$;


-- 6. THE REFEREE: runs on every event a phone sends
create or replace function public.process_event()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  g text;
begin
  select status into g from public.games where code = new.game;

  -- JOIN: add the player (only before the game starts)
  if new.type = 'join' and g = 'waiting' then
    insert into public.results (game, user_id) values (new.game, new.user_id)
    on conflict do nothing;

  -- PICKUP: +1, alarm on. Shaking needed: 10s, 30s, 1 min, then +30s every pickup after.
  elsif new.type in ('pickup', 'left_page') and g = 'live' then
    update public.results set
      pickups           = pickups + 1,
      alarm_on          = true,
      shake_secs_needed = case pickups          -- pickups BEFORE this one
                            when 0 then 10      -- 1st pickup: 10 seconds
                            when 1 then 30      -- 2nd pickup: 30 seconds
                            else 30 * pickups   -- 3rd: 60s (1 min), 4th: 90s, 5th: 120s, ... (+30s each time)
                          end,
      shake_secs_done   = 0,
      is_shaking        = false,
      last_shake_at     = null,
      first_pickup_at   = coalesce(first_pickup_at, now())
    where game = new.game and user_id = new.user_id and not alarm_on;   -- already roasting? don't count twice

  -- SHAKE: the phone sends this about twice a second while you shake.
  --   Time between two shakes counts as shaking time (max 1 second each).
  --   While shaking, the sound pauses (is_shaking = true).
  elsif new.type = 'shake' and g = 'live' then
    update public.results set
      shake_secs_done = shake_secs_done + case
        when last_shake_at > now() - interval '1.5 seconds'
          then least(extract(epoch from now() - last_shake_at), 1)
        else 0
      end,
      is_shaking    = true,
      last_shake_at = now()
    where game = new.game and user_id = new.user_id and alarm_on
      and (last_shake_at is null or last_shake_at < now() - interval '150 milliseconds');

    -- Shook long enough? Alarm off for good.
    update public.results set alarm_on = false, is_shaking = false
    where game = new.game and user_id = new.user_id and alarm_on
      and shake_secs_done >= shake_secs_needed;

  -- SHAKE_STOP: they stopped shaking before the timer was up. Sound comes back.
  elsif new.type = 'shake_stop' and g = 'live' then
    update public.results set is_shaking = false
    where game = new.game and user_id = new.user_id and alarm_on;
  end if;

  return new;
end;
$$;

create trigger on_event after insert on public.events
  for each row execute procedure public.process_event();


-- 7. TITLES for each finished game
create view public.game_awards
with (security_invoker = on) as
select
  r.game,
  r.user_id,
  p.username,
  r.pickups,
  r.sol_in,
  r.sol_back,
  r.pickups = 0                                                          as iron_will,
  r.pickups > 0 and r.pickups = max(r.pickups) over (partition by r.game) as doomscroller,
  r.first_pickup_at is not null
    and r.first_pickup_at = min(r.first_pickup_at) over (partition by r.game) as first_to_fold
from public.results r
join public.profiles p on p.id = r.user_id;


-- 8. RIVALRIES: how you do against every other player (your nemesis = most losses)
create view public.rivalries
with (security_invoker = on) as
select
  a.user_id,
  b.user_id                                     as opponent_id,
  pb.username                                   as opponent,
  count(*)                                      as games_together,
  count(*) filter (where a.pickups < b.pickups) as wins,
  count(*) filter (where a.pickups > b.pickups) as losses
from public.results a
join public.results b   on b.game = a.game and b.user_id <> a.user_id
join public.games g     on g.code = a.game and g.status = 'ended'
join public.profiles pa on pa.id = a.user_id and not pa.is_guest
join public.profiles pb on pb.id = b.user_id and not pb.is_guest
group by a.user_id, b.user_id, pb.username;


-- 9. PERMISSIONS + REALTIME
revoke all on function public.create_game(), public.start_game(text),
              public.finish_game(text), public.can_host(text) from public, anon;
grant execute on function public.create_game(), public.start_game(text),
                         public.finish_game(text) to authenticated, service_role;
revoke all on function public.process_event() from public, anon, authenticated;

alter publication supabase_realtime add table public.results;   -- phones see their alarm, the Pi hears it
