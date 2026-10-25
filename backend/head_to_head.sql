-- Buzzkill: who's in the lobby with you, and how you stack up (run after stats.sql)
--
-- lobby_players(code) -> one row per OTHER player in that game:
--   games_together, they_won, you_won, last_result ('won' / 'lost' / 'tie', from YOUR side)
--   their_pph / your_pph            pickups per hour (all finished games)
--   their_longest / your_longest    longest focus stretch in seconds (time between pickups, games with pickup times)
--   their_clean / your_clean        % of games with 0 pickups
--   friend                          'friends' / 'sent' / 'received' / null
-- "Won" = fewer pickups in a game you both played. Only players in the game (or its host) can call it.

create or replace function public.lobby_players(p_code text)
returns table (
  user_id uuid, username text, is_guest boolean,
  games_together int, they_won int, you_won int, last_result text,
  their_pph numeric, your_pph numeric,
  their_longest int, your_longest int,
  their_clean int, your_clean int,
  friend text
)
language sql stable security definer set search_path = ''
as $$
  with me as (select auth.uid() as id),
  allowed as (
    select 1 from public.results r, me where r.game = p_code and r.user_id = me.id
    union select 1 from public.games g, me where g.code = p_code and g.host_id = me.id
  ),
  lobby as (
    select r.user_id from public.results r, me
    where r.game = p_code and r.user_id <> me.id and exists (select 1 from allowed)
  ),
  people as (select user_id from lobby union select id from me),
  -- every finished game for these people, with its length and longest focus stretch
  played as (
    select r.user_id, r.game, r.pickups, g.end_time,
           extract(epoch from g.end_time - g.start_time) as secs,
           case when cardinality(r.pickup_times) = r.pickups then (
             select max(extract(epoch from d))::int from (
               select t - lag(t) over (order by t) as d
               from unnest(array[g.start_time] || r.pickup_times || array[g.end_time]) as t
             ) x
           ) end as longest
    from public.results r
    join public.games g on g.code = r.game
    where g.status = 'ended' and g.start_time is not null and g.end_time is not null
      and r.user_id in (select user_id from people)
  ),
  overall as (
    select user_id,
           round(sum(pickups) * 3600.0 / greatest(sum(secs), 1), 1) as pph,
           max(longest) as longest,
           round(avg(case when pickups = 0 then 100.0 else 0 end))::int as clean
    from played group by user_id
  ),
  vs as (
    select o.user_id,
           count(*)::int as together,
           count(*) filter (where o.pickups < m.pickups)::int as they_won,
           count(*) filter (where o.pickups > m.pickups)::int as you_won,
           (array_agg(case when m.pickups < o.pickups then 'won' when m.pickups > o.pickups then 'lost' else 'tie' end
                      order by o.end_time desc))[1] as last_result
    from played o
    join played m on m.game = o.game and m.user_id = (select id from me)
    where o.user_id <> (select id from me)
    group by o.user_id
  )
  select l.user_id, p.username, p.is_guest,
         coalesce(vs.together, 0), coalesce(vs.they_won, 0), coalesce(vs.you_won, 0), vs.last_result,
         them.pph, mine.pph, them.longest, mine.longest, them.clean, mine.clean,
         (select case when f.status = 'accepted' then 'friends'
                      when f.requester = (select id from me) then 'sent' else 'received' end
          from public.friendships f
          where (f.requester = l.user_id and f.addressee = (select id from me))
             or (f.addressee = l.user_id and f.requester = (select id from me))
          limit 1)
  from lobby l
  join public.profiles p on p.id = l.user_id
  left join vs on vs.user_id = l.user_id
  left join overall them on them.user_id = l.user_id
  left join overall mine on mine.user_id = (select id from me)
  order by coalesce(vs.together, 0) desc, p.username;
$$;

revoke all on function public.lobby_players(text) from public, anon;
grant execute on function public.lobby_players(text) to authenticated;
