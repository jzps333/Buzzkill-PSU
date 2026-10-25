-- Buzzkill: you can only JOIN a game from a phone (run after game.sql)
--
-- The website already blocks laptops, and the join page checks for a real motion sensor.
-- This is the last line of defense: the database refuses a "join" unless the request
-- comes from a phone browser (iPhone / Android phone). iPads and tablets are blocked too.

drop policy "players add own events" on public.events;

create policy "players add own events" on public.events
  for insert to authenticated
  with check (
    user_id = auth.uid()
    and exists (select 1 from public.games g
                where g.code = game and g.status in ('waiting', 'live'))
    and (
      type <> 'join'
      or (    coalesce(current_setting('request.headers', true)::json ->> 'user-agent', '') ~* '(iphone|ipod|android.*mobile|mobile)'
          and coalesce(current_setting('request.headers', true)::json ->> 'user-agent', '') !~* 'ipad')   -- phones yes, iPads no
    )
  );
