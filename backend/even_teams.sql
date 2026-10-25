-- Buzzkill: teams are always even (run after features.sql)
-- 4 players = 2v2, 6 = 3v3, 8 = 4v4, and so on. A teams game won't start with an odd number of players,
-- because "fewest team pickups wins" isn't fair when one team has an extra person.
-- It only replaces start_game.

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

  -- Teams are always even: 2v2 with 4 players, 3v3 with 6, 4v4 with 8...
  if (select mode from public.games where code = p_code) = 'teams' and players % 2 = 1 then
    raise exception 'Teams need an even number of players (you have %). One more for %v%, or one less for %v%.',
      players, (players + 1) / 2, (players + 1) / 2, (players - 1) / 2, (players - 1) / 2;
  end if;

  -- Pomodoro: most votes wins. Ties go to classic, then sprint, deep, none. No votes = classic.
  select v.choice into pick
  from (select pomo_vote as choice, count(*) as n from public.results
        where game = p_code and pomo_vote is not null group by pomo_vote) v
  order by v.n desc, array_position(array['classic', 'sprint', 'deep', 'none'], v.choice)
  limit 1;
  pick := coalesce(pick, 'classic');
  select o.work_min, o.break_min into w, b from public.pomo_options() o where o.choice = pick;

  -- Teams: shuffle players and alternate them into team 1 and team 2 (even count, so always NvN)
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
