-- Buzzkill: 5 second grace after you finish shaking (run after features.sql)
--
-- When your shaking time is done, you get 5 seconds to put the phone back face down.
-- Pickups in those 5 seconds don't count, so you don't get busted again by accident.
-- (Uses last_shake_at: your last shake was less than 5 seconds ago = still in the grace period.)

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
    if me.alarm_on or public.on_break(new.game) or coalesce(me.pass_until > now(), false)
       or coalesce(me.last_shake_at > now() - interval '5 seconds', false) then   -- just finished shaking: 5s to put it down
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
        and not alarm_on and coalesce(pass_until <= now(), true)
        and coalesce(last_shake_at <= now() - interval '5 seconds', true);   -- teammates in their 5s grace are spared
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
