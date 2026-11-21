-- =====================================================================
-- Fix 02: Freundes-Passwort
-- Besucher bekommen keinen direkten Datenbankzugriff mehr. Freie Termine,
-- Leistungen und Buchungen gibt es nur noch über die Edge Function "book",
-- die das Passwort (Secret FRIEND_CODE) prüft.
-- Einmal im SQL Editor ausführen. Gefahrlos mehrfach ausführbar.
-- =====================================================================

-- Fehlversuche zählen (nur gehashte IPs, nach 24 h gelöscht)
create table if not exists public.code_failures (
  id          bigint generated always as identity primary key,
  ip_hash     text not null,
  created_at  timestamptz not null default now()
);
create index if not exists code_failures_ip_idx on public.code_failures (ip_hash, created_at);
alter table public.code_failures enable row level security;
revoke all on public.code_failures from anon, authenticated;

create or replace function public.code_gate(p_ip_hash text, p_ok boolean)
returns text
language plpgsql volatile security definer
set search_path = ''
as $$
begin
  if p_ip_hash is null or char_length(p_ip_hash) < 16 then
    return 'BLOCKED';
  end if;
  if (select count(*) from public.code_failures
        where ip_hash = p_ip_hash and created_at > now() - interval '1 hour') >= 10 then
    return 'BLOCKED';
  end if;
  if p_ok is distinct from true then
    insert into public.code_failures (ip_hash) values (p_ip_hash);
    return 'WRONG';
  end if;
  return 'OK';
end;
$$;
revoke execute on function public.code_gate(text, boolean) from public, anon, authenticated;
grant  execute on function public.code_gate(text, boolean) to service_role;

-- Freie Slots: nur noch für die Edge Function
revoke execute on function public.get_free_slots(int) from public, anon, authenticated;
grant  execute on function public.get_free_slots(int) to service_role;

-- Leistungen: kein öffentlicher Lesezugriff mehr (Admin behält Zugriff über seine Policy)
drop policy if exists "services: aktive lesen" on public.services;
revoke all on public.services from anon;
grant select on public.services to service_role;

-- Aufräum-Job um die neue Tabelle erweitern
create or replace function public.purge_old_data()
returns void
language sql volatile security definer
set search_path = ''
as $$
  delete from public.bookings b
   using public.slots s
   where b.slot_id = s.id and s.starts_at < now() - interval '3 months';
  delete from public.slots s
   where s.ends_at < now() - interval '1 day'
     and not exists (select 1 from public.bookings b where b.slot_id = s.id);
  delete from public.booking_attempts where created_at < now() - interval '24 hours';
  delete from public.code_failures    where created_at < now() - interval '24 hours';
$$;
revoke execute on function public.purge_old_data() from public, anon, authenticated;

-- Kontrolle: anon darf hier NICHTS mehr haben → erwartet: 0 Zeilen
select table_name, privilege_type from information_schema.role_table_grants
 where table_schema = 'public' and grantee = 'anon'
union all
select routine_name, 'EXECUTE' from information_schema.role_routine_grants
 where routine_schema = 'public' and grantee = 'anon';
