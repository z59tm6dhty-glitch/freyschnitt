-- Fix 03: Nur noch eine Leistung ("Haarschnitt")
-- Die anderen Leistungen werden nur deaktiviert (nicht gelöscht), damit alte Buchungen gültig bleiben.
-- Gefahrlos mehrfach ausführbar.

insert into public.services (name, sort) values ('Haarschnitt', 1)
on conflict (name) do nothing;

update public.services
   set active = (name = 'Haarschnitt'),
       sort   = case when name = 'Haarschnitt' then 1 else sort end;

-- Kontrolle: nur "Haarschnitt" ist aktiv
select id, name, active from public.services order by sort;
