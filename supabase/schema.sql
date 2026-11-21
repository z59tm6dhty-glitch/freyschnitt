-- =====================================================================
-- Freyschnitt – Datenbank-Setup (Supabase / Postgres)
-- Ausführen: Supabase Dashboard → SQL Editor → New query → alles einfügen → Run
-- Das Skript ist für ein LEERES Projekt gedacht (einmal ausführen).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 0. Erweiterungen
-- ---------------------------------------------------------------------
create extension if not exists pg_cron;      -- tägliche Lösch-Jobs

-- ---------------------------------------------------------------------
-- 1. Tabellen
-- ---------------------------------------------------------------------

-- Leistungen (öffentlich lesbar, enthalten keine Personendaten)
create table public.services (
  id      smallint generated always as identity primary key,
  name    text     not null unique check (char_length(name) between 1 and 60),
  sort    smallint not null default 0,
  active  boolean  not null default true
);

-- Zeitfenster, die du anlegst
create table public.slots (
  id          uuid primary key default gen_random_uuid(),
  starts_at   timestamptz not null,
  ends_at     timestamptz not null,
  blocked     boolean     not null default false,   -- "gesperrt": nicht buchbar, bleibt aber stehen
  created_at  timestamptz not null default now(),
  constraint slot_length check (ends_at > starts_at and ends_at <= starts_at + interval '4 hours'),
  -- Slots dürfen sich nicht überschneiden (verhindert auch doppelte Serien)
  constraint slots_no_overlap exclude using gist (tstzrange(starts_at, ends_at) with &&)
);
create index slots_starts_at_idx on public.slots (starts_at);

-- Buchungen (Kundendaten – nur für Admins sichtbar)
create table public.bookings (
  id            uuid primary key default gen_random_uuid(),
  slot_id       uuid     not null references public.slots(id) on delete restrict,
  service_id    smallint not null references public.services(id),
  name          text not null check (char_length(name) between 2 and 80),
  email         text not null check (char_length(email) <= 254 and email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  note          text check (char_length(note) <= 500),
  consent_at    timestamptz not null,                         -- Zeitpunkt der Datenschutz-Einwilligung
  status        text not null default 'confirmed' check (status in ('confirmed', 'cancelled')),
  cancel_token  uuid not null default gen_random_uuid() unique, -- für späteren Storno-Link
  created_at    timestamptz not null default now(),
  cancelled_at  timestamptz
);
-- DOPPELBUCHUNGS-SCHUTZ: pro Slot höchstens EINE bestätigte Buchung
create unique index bookings_one_confirmed_per_slot
  on public.bookings (slot_id) where status = 'confirmed';
create index bookings_email_idx on public.bookings (email) where status = 'confirmed';

-- Wer ist Admin? (zusätzlich zur abgeschalteten Registrierung)
create table public.admins (
  user_id uuid primary key references auth.users(id) on delete cascade
);

-- Für das Rate-Limit (nur gehashte IPs, werden nach 24 h gelöscht)
create table public.booking_attempts (
  id          bigint generated always as identity primary key,
  ip_hash     text not null,
  created_at  timestamptz not null default now()
);
create index booking_attempts_ip_idx on public.booking_attempts (ip_hash, created_at);

-- ---------------------------------------------------------------------
-- 2. Hilfsfunktion: bin ich Admin?
-- ---------------------------------------------------------------------
create function public.is_admin()
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (select 1 from public.admins where user_id = (select auth.uid()));
$$;

-- ---------------------------------------------------------------------
-- 3. Row Level Security
-- ---------------------------------------------------------------------
alter table public.services          enable row level security;
alter table public.slots             enable row level security;
alter table public.bookings          enable row level security;
alter table public.admins            enable row level security;
alter table public.booking_attempts  enable row level security;

-- Doppelter Boden: anon bekommt auf die sensiblen Tabellen gar keine Rechte,
-- selbst wenn mal eine Policy falsch wäre.
revoke all on public.slots, public.bookings, public.admins, public.booking_attempts from anon;
revoke insert, update, delete on public.services from anon;
revoke all on public.admins, public.booking_attempts from authenticated;

-- Rechte ausdrücklich vergeben (neuere Projekte machen das nicht mehr automatisch)
grant usage on schema public to anon, authenticated;
grant select on public.services to anon;
grant select, insert, update, delete on public.services, public.slots, public.bookings to authenticated;

-- services: alle dürfen aktive Leistungen lesen, Admin darf alles
create policy "services: aktive lesen" on public.services
  for select to anon, authenticated using (active);
create policy "services: admin alles" on public.services
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- slots: nur Admin (Öffentlichkeit sieht freie Slots nur über get_free_slots)
create policy "slots: admin alles" on public.slots
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- bookings: nur Admin
create policy "bookings: admin alles" on public.bookings
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- admins / booking_attempts: keine Policies = kein Zugriff von außen

-- ---------------------------------------------------------------------
-- 4. Öffentlich: freie Slots abrufen (nur Zeit, keine Kundendaten)
-- ---------------------------------------------------------------------
create function public.get_free_slots(p_days int default 35)
returns table (id uuid, starts_at timestamptz, ends_at timestamptz)
language sql stable security definer
set search_path = ''
as $$
  select s.id, s.starts_at, s.ends_at
  from public.slots s
  where not s.blocked
    and s.starts_at >= now() + interval '12 hours'                       -- Mindestvorlauf
    and s.starts_at <  now() + make_interval(days => least(greatest(coalesce(p_days, 35), 1), 90))
    and not exists (
      select 1 from public.bookings b
      where b.slot_id = s.id and b.status = 'confirmed'
    )
  order by s.starts_at;
$$;

-- ---------------------------------------------------------------------
-- 5. Buchen (NUR von der Edge Function mit service_role aufrufbar)
--    Gibt JSON zurück: {ok:true, ...} oder {ok:false, error:'CODE'}
-- ---------------------------------------------------------------------
create function public.book_slot(
  p_slot_id    uuid,
  p_service_id smallint,
  p_name       text,
  p_email      text,
  p_note       text,
  p_consent    boolean,
  p_ip_hash    text
)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_email    text := lower(trim(coalesce(p_email, '')));
  v_name     text := trim(coalesce(p_name, ''));
  v_note     text := nullif(trim(coalesce(p_note, '')), '');
  v_service  text;
  v_slot     public.slots%rowtype;
  v_id       uuid;
  v_token    uuid;
begin
  -- Rate-Limit: max. 5 Versuche pro IP und Stunde, max. 40 Versuche insgesamt pro Stunde.
  -- Der Versuch wird VOR den Prüfungen gespeichert, damit auch fehlgeschlagene zählen.
  if p_ip_hash is null or char_length(p_ip_hash) < 16 then
    return jsonb_build_object('ok', false, 'error', 'BAD_REQUEST');
  end if;
  if (select count(*) from public.booking_attempts
        where ip_hash = p_ip_hash and created_at > now() - interval '1 hour') >= 5
     or (select count(*) from public.booking_attempts
        where created_at > now() - interval '1 hour') >= 40 then
    return jsonb_build_object('ok', false, 'error', 'RATE_LIMIT');
  end if;
  insert into public.booking_attempts (ip_hash) values (p_ip_hash);

  -- Eingaben prüfen
  if p_consent is distinct from true then
    return jsonb_build_object('ok', false, 'error', 'NO_CONSENT');
  end if;
  if char_length(v_name) not between 2 and 80 then
    return jsonb_build_object('ok', false, 'error', 'INVALID_NAME');
  end if;
  if char_length(v_email) > 254 or v_email !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    return jsonb_build_object('ok', false, 'error', 'INVALID_EMAIL');
  end if;
  if char_length(coalesce(v_note, '')) > 500 then
    return jsonb_build_object('ok', false, 'error', 'INVALID_NOTE');
  end if;

  select name into v_service from public.services where id = p_service_id and active;
  if v_service is null then
    return jsonb_build_object('ok', false, 'error', 'INVALID_SERVICE');
  end if;

  -- Max. 2 offene Termine pro E-Mail-Adresse
  if (select count(*)
        from public.bookings b join public.slots s on s.id = b.slot_id
       where b.email = v_email and b.status = 'confirmed' and s.starts_at > now()) >= 2 then
    return jsonb_build_object('ok', false, 'error', 'TOO_MANY_BOOKINGS');
  end if;

  -- Slot sperren (andere gleichzeitige Buchungen warten hier)
  select * into v_slot from public.slots where id = p_slot_id for update;
  if not found or v_slot.blocked or v_slot.starts_at < now() + interval '12 hours' then
    return jsonb_build_object('ok', false, 'error', 'SLOT_UNAVAILABLE');
  end if;

  -- Eintragen; der Unique-Index ist die letzte Sicherung gegen Doppelbuchung
  begin
    insert into public.bookings (slot_id, service_id, name, email, note, consent_at)
    values (p_slot_id, p_service_id, v_name, v_email, v_note, now())
    returning id, cancel_token into v_id, v_token;
  exception when unique_violation then
    return jsonb_build_object('ok', false, 'error', 'SLOT_UNAVAILABLE');
  end;

  return jsonb_build_object(
    'ok', true,
    'booking_id', v_id,
    'cancel_token', v_token,
    'starts_at', v_slot.starts_at,
    'ends_at', v_slot.ends_at,
    'service', v_service,
    'name', v_name,
    'email', v_email,
    'note', v_note
  );
end;
$$;

-- ---------------------------------------------------------------------
-- 6. Admin: Slot-Serie anlegen
--    Beispiel: select public.create_slot_series(array[2,4], '2026-11-23', '2026-12-20', '18:00', '21:00', 45);
--    Wochentage: 1 = Mo … 7 = So. Zeiten gelten in deutscher Zeit (inkl. Sommerzeit).
--    Bereits belegte/überlappende Zeiten werden übersprungen.
-- ---------------------------------------------------------------------
create function public.create_slot_series(
  p_weekdays  int[],
  p_date_from date,
  p_date_to   date,
  p_time_from time,
  p_time_to   time,
  p_slot_min  int
)
returns int
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_day     date;
  v_local   timestamp;
  v_end     timestamp;
  v_start   timestamptz;
  v_count   int := 0;
  v_n       int;
begin
  if not public.is_admin() then
    raise exception 'Nicht erlaubt' using errcode = '42501';
  end if;
  if p_slot_min is null or p_slot_min not between 5 and 240 then
    raise exception 'Slot-Länge muss zwischen 5 und 240 Minuten liegen';
  end if;
  if p_time_to <= p_time_from then
    raise exception 'Endzeit muss nach Startzeit liegen';
  end if;
  if p_date_to < p_date_from or p_date_to > p_date_from + 120 then
    raise exception 'Zeitraum ungültig (max. 120 Tage)';
  end if;
  if p_weekdays is null or cardinality(p_weekdays) = 0
     or exists (select 1 from unnest(p_weekdays) w where w not between 1 and 7) then
    raise exception 'Wochentage ungültig (1 = Mo … 7 = So)';
  end if;

  for v_day in select d::date from generate_series(p_date_from, p_date_to, interval '1 day') d loop
    continue when not (extract(isodow from v_day)::int = any (p_weekdays));
    v_local := v_day + p_time_from;
    v_end   := v_day + p_time_to;
    while v_local + make_interval(mins => p_slot_min) <= v_end loop
      v_start := v_local at time zone 'Europe/Berlin';
      if v_start > now() then
        insert into public.slots (starts_at, ends_at)
        values (v_start, v_start + make_interval(mins => p_slot_min))
        on conflict do nothing;
        get diagnostics v_n = row_count;
        v_count := v_count + v_n;
      end if;
      v_local := v_local + make_interval(mins => p_slot_min);
    end loop;
  end loop;

  return v_count;
end;
$$;

-- ---------------------------------------------------------------------
-- 7. Aufräumen (Datenschutz): läuft täglich per pg_cron
-- ---------------------------------------------------------------------
create function public.purge_old_data()
returns void
language sql volatile security definer
set search_path = ''
as $$
  -- Buchungen, deren Termin älter als 3 Monate ist
  delete from public.bookings b
   using public.slots s
   where b.slot_id = s.id and s.starts_at < now() - interval '3 months';
  -- Vergangene Slots ohne Buchung
  delete from public.slots s
   where s.ends_at < now() - interval '1 day'
     and not exists (select 1 from public.bookings b where b.slot_id = s.id);
  -- Rate-Limit-Einträge
  delete from public.booking_attempts where created_at < now() - interval '24 hours';
$$;

select cron.schedule('freyschnitt-purge', '17 3 * * *', $$select public.purge_old_data();$$);

-- ---------------------------------------------------------------------
-- 8. Funktionsrechte (WICHTIG: Supabase erlaubt neue Funktionen sonst für alle)
-- ---------------------------------------------------------------------
revoke execute on function public.is_admin()                                         from public, anon, authenticated;
revoke execute on function public.get_free_slots(int)                                from public, anon, authenticated;
revoke execute on function public.book_slot(uuid, smallint, text, text, text, boolean, text) from public, anon, authenticated;
revoke execute on function public.create_slot_series(int[], date, date, time, time, int) from public, anon, authenticated;
revoke execute on function public.purge_old_data()                                   from public, anon, authenticated;

grant execute on function public.is_admin()                to authenticated;
grant execute on function public.get_free_slots(int)       to anon, authenticated;
grant execute on function public.book_slot(uuid, smallint, text, text, text, boolean, text) to service_role;
grant execute on function public.create_slot_series(int[], date, date, time, time, int) to authenticated;

-- ---------------------------------------------------------------------
-- 9. Start-Daten: Leistungen (später im Table Editor anpassbar)
-- ---------------------------------------------------------------------
insert into public.services (name, sort) values
  ('Haarschnitt', 1),
  ('Haarschnitt + Bart', 2),
  ('Nur Bart', 3);
