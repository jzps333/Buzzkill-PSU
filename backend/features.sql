-- Buzzkill: emergency pass, teams, pomodoro voting (run after lobby.sql)
--
-- EMERGENCY PASS: 1 per player per game. Use it on the BUSTED screen right after picking up:
--   that pickup is cancelled and you get 10 free minutes (pickups don't count).
-- TEAMS: host picks solo or teams. At the start, players are split into team 1 (Honey) and team 2 (Stingers).
--   If anyone on your team picks up, the whole team gets busted and everyone has to shake.
--   Shaking time grows with the TEAM's total pickups. Fewest team pickups wins.
-- POMODORO: everyone votes in the lobby. Most votes wins at the start (ties / no votes = classic).
--   During breaks phones are free. After a break ends there's a 15 second grace period to put phones down.


-- 1. NEW COLUMNS
alter table public.games
  add column mode        text not null default 'solo' check (mode in ('solo', 'teams')),
  add column pomo_choice text,           -- sprint / classic / deep / none (picked at start)
  add column pomo_work   int,            -- focus minutes
  add column pomo_break  int;            -- break minutes

alter table public.results
  add column team        int check (team in (1, 2)),   -- set at start in teams mode
  add column pomo_vote   text,                          -- this player's vote
  add column pass_used   boolean not null default false,
  add column pass_until  timestamptz,                   -- emergency pass active until
  add column alarm_cause uuid;                          -- whose pickup turned this alarm on

alter table public.events add column detail text;      -- extra info, e.g. which pomodoro you voted for

alter table public.events drop constraint events_type_check;
alter table public.events add constraint events_type_check
  check (type in ('join', 'ping', 'leave', 'vote', 'pickup', 'left_page', 'pass', 'shake', 'shake_stop'));


-- 2. POMODORO OPTIONS
create or replace function public.pomo_options()
returns table (choice text, work_min int, break_min int)
language sql immutable
as $$
  values ('sprint', 15, 3), ('classic', 25, 5), ('deep', 50, 10), ('none', 0, 0);
$$;

-- Is this game on a break right now? (also true for 15 seconds after a break ends, to put phones down)
create or replace function public.on_break(p_code text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  with g as (
    select extract(epoch from now() - start_time) as t,
           pomo_work * 60 as w,
           (pomo_work + pomo_break) * 60 as c
    from public.games
    where code = p_code and status = 'live' and pomo_work > 0 and pomo_break > 0 and start_time is not null
  )
  select coalesce((select (t::numeric % c::numeric) >= w                  -- in the break part of the cycle
                       or (t >= c and (t::numeric % c::numeric) < 15)     -- 15s grace after a break
                   from g), false);
$$;


-- 3. SHAKING TIME for a number of earlier pickups: 10s, 30s, 1 min, then +30s each
create or replace function public.shake_time(earlier_pickups int)
returns int
language sql immutable
as $$
  select case earlier_pickups when 0 then 10 when 1 then 30 else 30 * earlier_pickups end;
$$;


-- 4. THE REFEREE
create or replace function public.process_event()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  g      public.games;
  me     public.results;
  before int;
  need   int;
begin
  select * into g from public.games where code = new.game;
  select * into me from public.results where game = new.game and user_id = new.user_id;

  -- JOIN / PING: add the player, or refresh "still here" (only before the game starts)
  if new.type in ('join', 'ping') and g.status = 'waiting' then
    insert into public.results (game, user_id, last_seen) values (new.game, new.user_id, now())
    on conflict (game, user_id) do update set last_seen = now();

  -- LEAVE: closed the page before the start -> out of the game
  elsif new.type = 'leave' and g.status = 'waiting' then
    delete from public.results where game = new.game and user_id = new.user_id;

  -- VOTE: pomodoro vote in the lobby
  elsif new.type = 'vote' and g.status = 'waiting' and me.user_id is not null
        and new.detail in (select choice from public.pomo_options()) then
    update public.results set pomo_vote = new.detail, last_seen = now()
    where game = new.game and user_id = new.user_id;

  -- PICKUP: ignored on a break, during your emergency pass, or if you're already busted
  elsif new.type in ('pickup', 'left_page') and g.status = 'live' and me.user_id is not null then
    if me.alarm_on or public.on_break(new.game) or coalesce(me.pass_until > now(), false) then
      return new;
    end if;

    -- Shaking time grows with your pickups (solo) or your TEAM's pickups (teams)
    if g.mode = 'teams' and me.team is not null then
      select coalesce(sum(pickups), 0) into before from public.results where game = new.game and team = me.team;
    else
      before := me.pickups;
    end if;
    need := public.shake_time(before);

    update public.results set
      pickups           = pickups + 1,
      alarm_on          = true,
      alarm_cause       = new.user_id,
      shake_secs_needed = need,
      shake_secs_done   = 0,
      is_shaking        = false,
      last_shake_at     = null,
      first_pickup_at   = coalesce(first_pickup_at, now())
    where game = new.game and user_id = new.user_id;

    -- Teams: everyone on your team gets busted too (unless they're already busted or on a pass)
    if g.mode = 'teams' and me.team is not null then
      update public.results set
        alarm_on          = true,
        alarm_cause       = new.user_id,
        shake_secs_needed = need,
        shake_secs_done   = 0,
        is_shaking        = false,
        last_shake_at     = null
      where game = new.game and team = me.team and user_id <> new.user_id
        and not alarm_on and coalesce(pass_until <= now(), true);
    end if;

  -- EMERGENCY PASS: cancel the pickup you just made, 10 free minutes. Once per game.
  elsif new.type = 'pass' and g.status = 'live' and me.user_id is not null
        and me.alarm_on and me.alarm_cause = new.user_id and not me.pass_used and me.pickups > 0 then
    update public.results set
      pickups         = pickups - 1,
      first_pickup_at = case when pickups - 1 = 0 then null else first_pickup_at end,
      alarm_on        = false,
      is_shaking      = false,
      pass_used       = true,
      pass_until      = now() + interval '10 minutes'
    where game = new.game and user_id = new.user_id;

    -- Teams: teammates busted because of this pickup are let off too
    update public.results set alarm_on = false, is_shaking = false
    where game = new.game and alarm_cause = new.user_id and user_id <> new.user_id and alarm_on;

  -- SHAKE: adds shaking time (sound paused while shaking). Enough time = alarm off.
  elsif new.type = 'shake' and g.status = 'live' then
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

    update public.results set alarm_on = false, is_shaking = false
    where game = new.game and user_id = new.user_id and alarm_on
      and shake_secs_done >= shake_secs_needed;

  -- SHAKE_STOP: stopped shaking early, sound comes back
  elsif new.type = 'shake_stop' and g.status = 'live' then
    update public.results set is_shaking = false
    where game = new.game and user_id = new.user_id and alarm_on;
  end if;

  return new;
end;
$$;


-- 5. CREATE A GAME, now with a mode: 'solo' (default) or 'teams'
drop function public.create_game();

create or replace function public.create_game(p_mode text default 'solo')
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
  if p_mode not in ('solo', 'teams') then raise exception 'Mode must be solo or teams'; end if;

  loop
    new_code := upper(substr(md5(random()::text), 1, 6));
    exit when not exists (select 1 from public.games where code = new_code);
  end loop;

  insert into public.games (code, status, host_id, mode)
  values (new_code, 'waiting', case when auth.role() = 'service_role' then null else auth.uid() end, p_mode);
  return new_code;
end;
$$;


-- 6. START A GAME: drop quiet players, need 4+, pick the pomodoro, split teams
create or replace function public.start_game(p_code text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  players int;
  pick    text;
  w       int;
  b       int;
begin
  if not public.can_host(p_code) then raise exception 'Only the host can start this game'; end if;

  perform public.prune_lobby(p_code);
  select count(*) into players from public.results where game = p_code;
  if players < 4 then
    raise exception 'Need at least 4 players to start (you have %)', players;
  end if;

  -- Pomodoro: most votes wins. Ties go to classic, then sprint, deep, none. No votes = classic.
  select v.choice into pick
  from (select pomo_vote as choice, count(*) as n from public.results
        where game = p_code and pomo_vote is not null group by pomo_vote) v
  order by v.n desc, array_position(array['classic', 'sprint', 'deep', 'none'], v.choice)
  limit 1;
  pick := coalesce(pick, 'classic');
  select o.work_min, o.break_min into w, b from public.pomo_options() o where o.choice = pick;

  -- Teams: shuffle players and alternate them into team 1 and team 2
  if (select mode from public.games where code = p_code) = 'teams' then
    with shuffled as (
      select user_id, row_number() over (order by random()) as n
      from public.results where game = p_code
    )
    update public.results r set team = case when s.n % 2 = 1 then 1 else 2 end
    from shuffled s where r.game = p_code and r.user_id = s.user_id;
  end if;

  update public.games set status = 'live', start_time = now(),
         pomo_choice = pick, pomo_work = w, pomo_break = b
  where code = p_code and status = 'waiting';
end;
$$;


-- 7. TITLES view: add each player's team (new column at the end)
create or replace view public.game_awards
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
    and r.first_pickup_at = min(r.first_pickup_at) over (partition by r.game) as first_to_fold,
  r.team
from public.results r
join public.profiles p on p.id = r.user_id;


-- 8. PERMISSIONS
revoke all on function public.create_game(text) from public, anon;
grant execute on function public.create_game(text) to authenticated, service_role;
revoke all on function public.on_break(text) from public, anon;
grant execute on function public.on_break(text) to authenticated, service_role;
