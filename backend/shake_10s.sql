-- Buzzkill: 10 seconds of shaking turns your alarm off (instead of 30s, 60s, 90s...).
-- game.sql already has this change. Run THIS file once on the live database:
-- Supabase -> SQL Editor -> paste -> Run. It only replaces the referee function.

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

  -- PICKUP: +1, alarm on. 10 seconds of shaking turns it off.
  elsif new.type in ('pickup', 'left_page') and g = 'live' then
    update public.results set
      pickups           = pickups + 1,
      alarm_on          = true,
      shake_secs_needed = 10,
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
