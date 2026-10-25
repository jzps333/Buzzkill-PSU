-- Buzzkill: closing a game, and leaving the lobby (run after shake_ramp.sql and phone_only.sql)
--
-- 1. The host can CLOSE a game before it starts (status 'cancelled'). Closed games never count in stats.
-- 2. Players who close their browser before the game starts are removed:
--      - the page sends 'leave' when it closes
--      - while waiting, phones send 'ping' every ~8 seconds; anyone silent for 25 seconds is dropped
--      - a ping after being dropped puts you back in
--    Once the game is live, nobody is removed.


-- 1. "Last seen" time for each player in the lobby
alter table public.results add column last_seen timestamptz not null default now();


-- 2. New phone messages: 'ping' (still here) and 'leave' (closed the page)
alter table public.events drop constraint events_type_check;
alter table public.events add constraint events_type_check
  check (type in ('join', 'ping', 'leave', 'pickup', 'left_page', 'shake', 'shake_stop'));

-- Joining or pinging (which can also add you) is phones only, same as before
drop policy "players add own events" on public.events;
create policy "players add own events" on public.events
  for insert to authenticated
  with check (
    user_id = auth.uid()
    and exists (select 1 from public.games g
                where g.code = game and g.status in ('waiting', 'live'))
    and (
      type not in ('join', 'ping')
      or (    coalesce(current_setting('request.headers', true)::json ->> 'user-agent', '') ~* '(iphone|ipod|android.*mobile|mobile)'
          and coalesce(current_setting('request.headers', true)::json ->> 'user-agent', '') !~* 'ipad')   -- phones yes, iPads no
    )
  );


-- 3. The referee, now with ping and leave
create or replace function public.process_event()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  g text;
begin
  select status into g from public.games where code = new.game;

  -- JOIN / PING: add the player, or refresh "still here" (only before the game starts).
  --   Phones ping every ~8 seconds while waiting. A ping after being dropped re-adds you.
  if new.type in ('join', 'ping') and g = 'waiting' then
    insert into public.results (game, user_id, last_seen) values (new.game, new.user_id, now())
    on conflict (game, user_id) do update set last_seen = now();

  -- LEAVE: closed the browser / left the page before the game started -> out of the game
  elsif new.type = 'leave' and g = 'waiting' then
    delete from public.results where game = new.game and user_id = new.user_id;

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


-- 4. DROP players who went quiet (25 seconds without a ping). Host page calls this every few seconds.
create or replace function public.prune_lobby(p_code text)
returns int
language plpgsql security definer set search_path = ''
as $$
declare
  removed int;
begin
  if not public.can_host(p_code) then raise exception 'Only the host can do this'; end if;
  delete from public.results r
  using public.games g
  where r.game = p_code and g.code = p_code and g.status = 'waiting'
    and r.last_seen < now() - interval '25 seconds';
  get diagnostics removed = row_count;
  return removed;
end;
$$;


-- 5. START A GAME: drop quiet players first, then it still needs 4+
create or replace function public.start_game(p_code text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  players int;
begin
  if not public.can_host(p_code) then raise exception 'Only the host can start this game'; end if;

  perform public.prune_lobby(p_code);
  select count(*) into players from public.results where game = p_code;
  if players < 4 then
    raise exception 'Need at least 4 players to start (you have %)', players;
  end if;

  update public.games set status = 'live', start_time = now()
  where code = p_code and status = 'waiting';
end;
$$;


-- 6. CLOSE A GAME before it starts. It never counts in stats.
create or replace function public.cancel_game(p_code text)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not public.can_host(p_code) then raise exception 'Only the host can close this game'; end if;
  update public.games set status = 'cancelled', end_time = now()
  where code = p_code and status = 'waiting';
  if not found then raise exception 'Only a game that has not started yet can be closed. End a live game instead.'; end if;
end;
$$;


revoke all on function public.prune_lobby(text), public.cancel_game(text) from public, anon;
grant execute on function public.prune_lobby(text), public.cancel_game(text) to authenticated, service_role;
