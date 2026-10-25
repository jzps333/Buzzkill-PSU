-- Buzzkill: security + Google sign-in (run AFTER schema.sql and events.sql)


-- 1. USERNAMES
--    Google users get their name automatically (e.g. "Vineet").
--    If a real username is already taken, add 4 random digits (e.g. "Vineet4821").
--    Names are cleaned: trimmed, max 30 characters.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
declare
  guest boolean := coalesce(new.is_anonymous, false);
  base  text;
  final text;
begin
  base := left(btrim(coalesce(
    nullif(btrim(new.raw_user_meta_data ->> 'username'), ''),
    nullif(btrim(new.raw_user_meta_data ->> 'full_name'), ''),
    nullif(btrim(new.raw_user_meta_data ->> 'name'), ''),
    nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
    'player'
  )), 24);

  final := base;
  if not guest then
    while exists (select 1 from public.profiles
                  where lower(username) = lower(final) and not is_guest) loop
      final := base || (1000 + floor(random() * 9000))::int;
    end loop;
  end if;

  insert into public.profiles (id, username, is_guest) values (new.id, final, guest);
  return new;
end;
$$;

alter table public.profiles
  add constraint username_length check (char_length(username) between 1 and 30);


-- 2. PROFILES: users can only change their username and wallet.
--    Before, someone could flip "is_guest" on their own profile.
revoke update on public.profiles from anon, authenticated;
grant update (username, wallet) on public.profiles to authenticated;

--    Wallet must look like a real Solana address (or be empty)
alter table public.profiles
  add constraint wallet_format check (wallet is null or wallet ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$');


-- 3. EVENTS: nobody needs to read other people's events.
--    The Pi uses the secret key, which can still read everything.
drop policy "anyone can read events" on public.events;


-- 4. GAMES + RESULTS: only the Pi (secret key) can write. Make that explicit.
revoke insert, update, delete on public.games, public.results from anon, authenticated;
revoke insert, update, delete on public.profiles from anon;
revoke delete on public.profiles from authenticated;
