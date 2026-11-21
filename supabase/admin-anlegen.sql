-- Erst im Dashboard unter Authentication → Users deinen User anlegen,
-- dann hier DEINE E-Mail eintragen und im SQL Editor ausführen.
insert into public.admins (user_id)
select id from auth.users where email = 'DEINE-EMAIL@beispiel.de';

-- Kontrolle: muss genau 1 Zeile zeigen
select a.user_id, u.email from public.admins a join auth.users u on u.id = a.user_id;
