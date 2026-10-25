-- Buzzkill: friends list (run after schema.sql and security.sql)
--
-- Add a friend by username -> they get a request -> they accept -> you're friends.
-- Guests can't have friends (they're not saved).


-- 1. FRIENDSHIPS: one row per pair of people
create table public.friendships (
  id          bigint generated always as identity primary key,
  requester   uuid not null references public.profiles (id) on delete cascade,   -- who sent the request
  addressee   uuid not null references public.profiles (id) on delete cascade,   -- who received it
  status      text not null default 'pending' check (status in ('pending', 'accepted')),
  created_at  timestamptz not null default now(),
  check (requester <> addressee)
);

-- Only one row per pair, no matter who asked first
create unique index friendships_pair
  on public.friendships (least(requester, addressee), greatest(requester, addressee));


-- 2. SECURITY
--    You can only see and delete friendships you're part of.
--    Sending and accepting go through the functions below (they do the checks).
alter table public.friendships enable row level security;

create policy "see your own friendships" on public.friendships
  for select to authenticated using (auth.uid() in (requester, addressee));

create policy "remove your own friendships" on public.friendships
  for delete to authenticated using (auth.uid() in (requester, addressee));   -- unfriend, decline, or cancel

revoke insert, update on public.friendships from anon, authenticated;
revoke all on public.friendships from anon;


-- 3. SEND A REQUEST (by username)
--    If they already sent YOU a request, this accepts it instead.
create or replace function public.send_friend_request(p_username text)
returns text
language plpgsql security definer set search_path = ''
as $$
declare
  me       uuid := auth.uid();
  them     uuid;
  existing public.friendships;
begin
  if me is null or exists (select 1 from public.profiles where id = me and is_guest) then
    raise exception 'Make an account to add friends';
  end if;

  select id into them from public.profiles
  where lower(username) = lower(btrim(p_username)) and not is_guest;
  if them is null then raise exception 'No player named "%"', btrim(p_username); end if;
  if them = me then raise exception 'You can''t add yourself'; end if;

  select * into existing from public.friendships
  where least(requester, addressee) = least(me, them)
    and greatest(requester, addressee) = greatest(me, them);

  if found then
    if existing.status = 'accepted' then return 'already_friends'; end if;
    if existing.addressee = me then                       -- they asked you first: accept
      update public.friendships set status = 'accepted' where id = existing.id;
      return 'accepted';
    end if;
    return 'already_sent';
  end if;

  insert into public.friendships (requester, addressee) values (me, them);
  return 'sent';
end;
$$;


-- 4. ACCEPT A REQUEST (only the person who received it)
create or replace function public.accept_friend_request(p_id bigint)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  update public.friendships set status = 'accepted'
  where id = p_id and addressee = auth.uid() and status = 'pending';
  if not found then raise exception 'Request not found'; end if;
end;
$$;

revoke all on function public.send_friend_request(text), public.accept_friend_request(bigint) from public, anon;
grant execute on function public.send_friend_request(text), public.accept_friend_request(bigint) to authenticated;
