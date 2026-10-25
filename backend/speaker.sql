-- Buzzkill: play roasts from the Pi's Bluetooth speaker instead of the laptop (run after lobby.sql)
--
-- 1. The Pi checks in every few seconds (speakers.last_seen), so the host page knows it's online.
-- 2. The host page picks where a game's roasts play: games.speaker = the Pi's id, or null = not the Pi.
-- 3. The Pi only talks for games that picked it.


-- 1. SPEAKERS: one row per Pi. Only the Pi (secret key) writes here.
create table public.speakers (
  id        text primary key,                      -- e.g. 'brick' (SPEAKER_ID in hardware/.env)
  name      text not null default 'Buzzkill speaker',
  last_seen timestamptz not null default now()
);

alter table public.speakers enable row level security;
create policy "anyone can read speakers" on public.speakers for select using (true);
revoke insert, update, delete on public.speakers from anon, authenticated;


-- 2. Which speaker plays this game's roasts (null = none, the laptop can still do it)
alter table public.games add column speaker text references public.speakers (id) on delete set null;


-- 3. The host (or the Pi) picks the speaker for a game
create or replace function public.set_game_speaker(p_code text, p_speaker text)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not public.can_host(p_code) then raise exception 'Only the host can change the speaker'; end if;
  if p_speaker is not null and not exists (select 1 from public.speakers where id = p_speaker) then
    raise exception 'That speaker does not exist';
  end if;
  -- One game per speaker: the last game to pick it gets it
  update public.games set speaker = null
  where speaker = p_speaker and code <> p_code and status in ('waiting', 'live');
  update public.games set speaker = p_speaker where code = p_code;
end;
$$;

revoke all on function public.set_game_speaker(text, text) from public, anon;
grant execute on function public.set_game_speaker(text, text) to authenticated, service_role;
