-- Fix 01: Tabellenrechte ausdrücklich vergeben
-- (neuere Supabase-Projekte geben neue Tabellen nicht mehr automatisch für die API frei)
-- Gefahrlos mehrfach ausführbar. RLS-Policies bleiben die eigentliche Schutzschicht.

-- Besucher: dürfen nur Leistungen lesen (RLS: nur aktive)
grant usage on schema public to anon, authenticated;
grant select on public.services to anon;

-- Eingeloggte: Rechte auf Tabellenebene; RLS lässt aber NUR Admins durch
grant select, insert, update, delete on public.services, public.slots, public.bookings to authenticated;

-- Kontrolle: so sollte es aussehen
select table_name, grantee, string_agg(privilege_type, ', ' order by privilege_type) as rechte
from information_schema.role_table_grants
where table_schema = 'public' and grantee in ('anon', 'authenticated')
group by 1, 2 order by 1, 2;
