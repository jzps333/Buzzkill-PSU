-- Buzzkill: DEMO game history for the team's real accounts (run after head_to_head.sql)
--
-- Makes 18 finished games over the last two weeks among the real (non-guest) accounts,
-- so dashboards, the leaderboard and the lobby head-to-heads have numbers to show.
-- Every demo game is marked games.demo = true and has a code starting with DEMO.
--
-- REMOVE ALL DEMO DATA (also deletes their results):
--   delete from public.games where demo;

alter table public.games add column if not exists demo boolean not null default false;

do $$
declare
  -- How often each person picks up (per hour). Anyone else gets 1.5.
  rate jsonb := '{"riv": 0.5, "maddie.murphy": 0.9, "vineet": 1.2, "pratosh": 1.7, "vineetg": 2.3, "riv2": 2.8}';
  ids uuid[];
  players uuid[];
  n int;
  i int;
  code text;
  t0 timestamptz;
  t1 timestamptz;
  mins int;
  p uuid;
  r numeric;
  times timestamptz[];
  slot int;
begin
  delete from public.games where demo;          -- running it again replaces the old demo games

  select array_agg(id) into ids from public.profiles
  where not is_guest and lower(username) <> 'setup-test';
  if coalesce(array_length(ids, 1), 0) < 4 then raise exception 'Need at least 4 real accounts for demo games'; end if;

  for i in 1..18 loop
    code := 'DEMO' || lpad(i::text, 2, '0');
    mins := 25 + floor(random() * 66)::int;                                   -- 25 to 90 minutes
    t1   := now() - (i * interval '18 hours') - random() * interval '6 hours';
    t0   := t1 - mins * interval '1 minute';

    -- 4 to everyone, shuffled
    select array_agg(x order by random()) into players from unnest(ids) x;
    n := 4 + floor(random() * (array_length(ids, 1) - 3))::int;
    players := players[1:n];

    insert into public.games (code, status, start_time, end_time, host_id, mode, pomo_choice, pomo_work, pomo_break, demo)
    values (code, 'ended', t0, t1, players[1], 'solo', 'classic', 25, 5, true);

    foreach p in array players loop
      select coalesce((rate ->> lower(username))::numeric, 1.5) into r from public.profiles where id = p;
      -- Each 5-minute slot: a chance of one pickup at a random moment in it
      times := '{}';
      for slot in 0..(mins / 5 - 1) loop
        if random() < r * 5 / 60 then
          times := times || (t0 + (slot * 5 + random() * 5) * interval '1 minute');
        end if;
      end loop;
      insert into public.results (game, user_id, pickups, pickup_times, first_pickup_at, last_seen)
      values (code, p, cardinality(times), times, times[1], t0);
    end loop;
  end loop;
end $$;
