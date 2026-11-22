// Freyschnitt – Admin-Bereich
// Alle Kundendaten werden mit textContent eingefügt (nie innerHTML) → kein XSS über Namen/Notizen.
(function () {
  "use strict";

  const C = window.FREY_CONFIG;
  const sb = window.supabase.createClient(C.SUPABASE_URL, C.SUPABASE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true },
  });
  const TZ = "Europe/Berlin";
  const $ = (id) => document.getElementById(id);

  const fDay = new Intl.DateTimeFormat("de-DE", { timeZone: TZ, weekday: "long", day: "numeric", month: "long" });
  const fDayShort = new Intl.DateTimeFormat("de-DE", { timeZone: TZ, weekday: "short", day: "2-digit", month: "2-digit", year: "2-digit" });
  const fTime = new Intl.DateTimeFormat("de-DE", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
  const fStamp = new Intl.DateTimeFormat("de-DE", { timeZone: TZ, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  const dayKey = (d) => new Intl.DateTimeFormat("sv-SE", { timeZone: TZ }).format(d);
  const todayBerlin = () => dayKey(new Date());
  const addDays = (iso, n) => { const d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

  // ---------- kleine DOM-Helfer ----------
  function el(tag, props, ...children) {
    const e = document.createElement(tag);
    if (props) for (const [k, v] of Object.entries(props)) {
      if (k === "class") e.className = v;
      else if (k === "text") e.textContent = v;
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) e.setAttribute(k, v === true ? "" : v);
    }
    for (const c of children) if (c != null) e.append(c);
    return e;
  }
  function flash(text, ok) {
    const m = $("app-msg");
    m.textContent = text;
    m.className = "msg " + (ok ? "ok" : "error");
    clearTimeout(flash.t);
    flash.t = setTimeout(() => { m.textContent = ""; }, ok ? 4000 : 8000);
  }

  // ---------- Login ----------
  async function showForSession(session) {
    if (!session) {
      $("app-view").hidden = true;
      $("logout").hidden = true;
      $("reload").hidden = true;
      $("login-view").hidden = false;
      return;
    }
    const { data: isAdmin, error } = await sb.rpc("is_admin");
    if (error || !isAdmin) {
      await sb.auth.signOut();
      $("login-msg").textContent = "Dieser Account hat keine Admin-Rechte.";
      return;
    }
    $("login-view").hidden = true;
    $("app-view").hidden = false;
    $("logout").hidden = false;
    $("reload").hidden = false;
    loadBookings();
  }

  $("login-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    $("login-msg").textContent = "";
    $("login-btn").disabled = true;
    const { data, error } = await sb.auth.signInWithPassword({
      email: $("l-email").value.trim(),
      password: $("l-pass").value,
    });
    $("login-btn").disabled = false;
    $("l-pass").value = "";
    if (error) {
      $("login-msg").textContent = /rate|too many/i.test(error.message)
        ? "Zu viele Versuche. Bitte später nochmal."
        : "E-Mail oder Passwort falsch.";
      return;
    }
    showForSession(data.session);
  });

  $("logout").addEventListener("click", async () => {
    await sb.auth.signOut();
    showForSession(null);
  });

  sb.auth.onAuthStateChange((event) => {
    if (event === "SIGNED_OUT") showForSession(null);
  });

  // ---------- Tabs ----------
  const tabs = { "tab-bookings": "p-bookings", "tab-slots": "p-slots", "tab-new": "p-new" };
  for (const [tabId, panelId] of Object.entries(tabs)) {
    $(tabId).addEventListener("click", () => {
      for (const [t, p] of Object.entries(tabs)) {
        $(t).setAttribute("aria-selected", t === tabId ? "true" : "false");
        $(p).hidden = t !== tabId;
      }
      if (tabId === "tab-bookings") loadBookings();
      if (tabId === "tab-slots") loadSlots();
      if (tabId === "tab-new") updatePreview();
    });
  }

  // ---------- Aktualisieren ----------
  // Lädt den gerade offenen Tab neu. Passiert auch automatisch, wenn man
  // zur App zurückkehrt (z. B. Home-Bildschirm-App aus dem Hintergrund).
  async function refresh() {
    if ($("app-view").hidden) return;
    const btn = $("reload");
    if (btn.classList.contains("spin")) return;
    btn.classList.add("spin");
    const started = Date.now();
    try {
      if (!$("p-bookings").hidden) await loadBookings();
      else if (!$("p-slots").hidden) await loadSlots();
      else updatePreview();
    } finally {
      // kurz sichtbar lassen, damit man merkt, dass etwas passiert ist
      setTimeout(() => btn.classList.remove("spin"), Math.max(0, 400 - (Date.now() - started)));
    }
  }
  $("reload").addEventListener("click", refresh);
  let hiddenAt = 0;
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) hiddenAt = Date.now();
    else if (hiddenAt && Date.now() - hiddenAt > 30000) refresh();
  });

  // ---------- Buchungen ----------
  $("show-all").addEventListener("change", loadBookings);

  async function loadBookings() {
    const box = $("bookings-list");
    box.replaceChildren(el("p", { class: "loading", text: "Lade …" }));
    const { data, error } = await sb
      .from("bookings")
      .select("id,name,email,note,status,created_at,cancelled_at,services(name),slots(starts_at,ends_at)")
      .limit(1000);
    if (error) { box.replaceChildren(el("p", { class: "empty", text: "Fehler: " + error.message })); return; }

    const showAll = $("show-all").checked;
    const now = Date.now();
    const list = data
      .filter((b) => b.slots)
      .filter((b) => showAll || (b.status === "confirmed" && new Date(b.slots.ends_at).getTime() > now))
      .sort((a, b) => showAll
        ? new Date(b.slots.starts_at) - new Date(a.slots.starts_at)
        : new Date(a.slots.starts_at) - new Date(b.slots.starts_at));

    if (!list.length) {
      box.replaceChildren(el("p", { class: "empty", text: showAll ? "Keine Buchungen gespeichert." : "Keine kommenden Buchungen." }));
      return;
    }

    box.replaceChildren(...list.map((b) => {
      const s = new Date(b.slots.starts_at), e = new Date(b.slots.ends_at);
      const cancelled = b.status === "cancelled";
      return el("div", { class: "bk" + (cancelled ? " cancelled" : "") },
        el("div", { class: "when", text: fDayShort.format(s) + " · " + fTime.format(s) + "–" + fTime.format(e) + (cancelled ? "  (storniert)" : "") }),
        el("div", { class: "who", text: b.name }),
        el("a", { href: "mailto:" + b.email, text: b.email }),
        el("div", { class: "meta", text: (b.services ? b.services.name : "–") + " · gebucht " + fStamp.format(new Date(b.created_at)) }),
        b.note ? el("div", { class: "note", text: b.note }) : null,
        cancelled ? null : el("div", { class: "actions" },
          el("button", { class: "sbtn danger", type: "button", text: "Stornieren", onclick: () => cancelBooking(b) }),
        ),
      );
    }));
  }

  async function cancelBooking(b) {
    const s = new Date(b.slots.starts_at);
    if (!confirm(`Buchung von ${b.name} am ${fDayShort.format(s)} um ${fTime.format(s)} stornieren?\n\nDer Slot wird wieder frei. ${b.name} wird NICHT automatisch benachrichtigt.`)) return;
    const { error } = await sb.from("bookings")
      .update({ status: "cancelled", cancelled_at: new Date().toISOString() })
      .eq("id", b.id).eq("status", "confirmed");
    if (error) return flash("Stornieren fehlgeschlagen: " + error.message);
    flash("Storniert – der Slot ist wieder frei.", true);
    loadBookings();
  }

  // ---------- Slots ----------
  async function loadSlots() {
    const box = $("slots-list");
    box.replaceChildren(el("p", { class: "loading", text: "Lade …" }));
    const from = new Date(Date.now() - 12 * 3600e3).toISOString();
    const to = new Date(Date.now() + 70 * 24 * 3600e3).toISOString();
    const { data, error } = await sb
      .from("slots")
      .select("id,starts_at,ends_at,blocked,bookings(id,status,name)")
      .gte("starts_at", from).lt("starts_at", to)
      .order("starts_at").limit(1000);
    if (error) { box.replaceChildren(el("p", { class: "empty", text: "Fehler: " + error.message })); return; }
    if (!data.length) { box.replaceChildren(el("p", { class: "empty", text: "Keine Slots angelegt. → Tab „Anlegen“" })); return; }

    const groups = new Map();
    for (const s of data) {
      const k = dayKey(new Date(s.starts_at));
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(s);
    }

    const frag = document.createDocumentFragment();
    for (const items of groups.values()) {
      const booked = items.filter((s) => s.bookings.some((b) => b.status === "confirmed")).length;
      const day = el("div", { class: "sday" },
        el("div", { class: "sday-title" },
          el("span", { text: fDay.format(new Date(items[0].starts_at)) }),
          el("small", { text: booked + "/" + items.length + " gebucht" })),
      );
      for (const s of items) {
        const conf = s.bookings.find((b) => b.status === "confirmed");
        const status = conf
          ? el("span", { class: "status booked", text: conf.name })
          : s.blocked
            ? el("span", { class: "status blocked", text: "gesperrt" })
            : el("span", { class: "status", text: "frei" });
        day.append(el("div", { class: "slot" },
          el("span", { class: "t", text: fTime.format(new Date(s.starts_at)) }),
          status,
          el("div", { class: "actions" },
            el("button", {
              class: "sbtn", type: "button", text: s.blocked ? "Freigeben" : "Sperren",
              disabled: !!conf, title: conf ? "Erst Buchung stornieren" : null,
              onclick: () => toggleBlock(s),
            }),
            el("button", {
              class: "sbtn danger", type: "button", text: "Löschen",
              disabled: !!conf, title: conf ? "Erst Buchung stornieren" : null,
              onclick: () => deleteSlot(s),
            }),
          ),
        ));
      }
      frag.append(day);
    }
    box.replaceChildren(frag);
  }

  async function toggleBlock(s) {
    const { error } = await sb.from("slots").update({ blocked: !s.blocked }).eq("id", s.id);
    if (error) return flash("Fehler: " + error.message);
    loadSlots();
  }

  async function deleteSlot(s) {
    const d = new Date(s.starts_at);
    if (!confirm(`Slot ${fDayShort.format(d)} ${fTime.format(d)} löschen?`)) return;
    // stornierte Buchungen hängen noch am Slot → zuerst entfernen
    let r = await sb.from("bookings").delete().eq("slot_id", s.id).eq("status", "cancelled");
    if (r.error) return flash("Fehler: " + r.error.message);
    r = await sb.from("slots").delete().eq("id", s.id);
    if (r.error) return flash(/foreign key/i.test(r.error.message) ? "Slot hat eine Buchung – erst stornieren." : "Fehler: " + r.error.message);
    flash("Slot gelöscht.", true);
    loadSlots();
  }

  // ---------- Anlegen ----------
  $("s-from").value = addDays(todayBerlin(), 1);
  $("e-date").value = addDays(todayBerlin(), 1);
  $("e-date").min = $("s-from").min = todayBerlin();

  function seriesInput() {
    const weekdays = [...document.querySelectorAll(".weekdays input:checked")].map((i) => Number(i.value));
    const from = $("s-from").value;
    const weeks = Number($("s-weeks").value);
    return {
      weekdays, from, weeks,
      to: from ? addDays(from, weeks * 7 - 1) : "",
      tfrom: $("s-tfrom").value, tto: $("s-tto").value, dur: Number($("s-dur").value),
    };
  }

  function updatePreview() {
    const s = seriesInput();
    const mins = (t) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
    if (!s.weekdays.length || !s.from || !s.tfrom || !s.tto || !s.dur || mins(s.tto) <= mins(s.tfrom)) {
      $("s-preview").textContent = "Bitte Wochentage, Datum und eine Endzeit nach der Startzeit wählen.";
      return;
    }
    const perDay = Math.floor((mins(s.tto) - mins(s.tfrom)) / s.dur);
    const last = mins(s.tfrom) + perDay * s.dur;
    const hh = (m) => String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0");
    $("s-preview").textContent =
      `≈ ${perDay * s.weekdays.length * s.weeks} Slots: ${perDay} pro Tag (${s.tfrom}–${hh(last)}), ` +
      `${s.weeks} Wochen bis ${new Date(s.to + "T12:00:00Z").toLocaleDateString("de-DE")}. ` +
      `Bereits belegte Zeiten werden übersprungen.`;
  }
  $("series-form").addEventListener("input", updatePreview);
  $("series-form").addEventListener("change", updatePreview);

  $("series-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const s = seriesInput();
    if (!s.weekdays.length) return flash("Bitte mindestens einen Wochentag wählen.");
    const { data, error } = await sb.rpc("create_slot_series", {
      p_weekdays: s.weekdays, p_date_from: s.from, p_date_to: s.to,
      p_time_from: s.tfrom, p_time_to: s.tto, p_slot_min: s.dur,
    });
    if (error) return flash("Fehler: " + error.message);
    flash(data === 0 ? "Keine neuen Slots – alle Zeiten gab es schon (oder lagen in der Vergangenheit)." : `${data} Slots angelegt.`, data > 0);
  });

  $("single-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const date = $("e-date").value, time = $("e-time").value, dur = Number($("e-dur").value);
    const [h, m] = time.split(":").map(Number);
    const endMin = h * 60 + m + dur;
    if (endMin >= 24 * 60) return flash("Der Slot muss vor Mitternacht enden.");
    const end = String(Math.floor(endMin / 60)).padStart(2, "0") + ":" + String(endMin % 60).padStart(2, "0");
    const isoDow = ((new Date(date + "T12:00:00Z").getUTCDay() + 6) % 7) + 1;
    // gleiche DB-Funktion wie die Serie → Zeitzone & Überschneidungen werden dort sauber behandelt
    const { data, error } = await sb.rpc("create_slot_series", {
      p_weekdays: [isoDow], p_date_from: date, p_date_to: date,
      p_time_from: time, p_time_to: end, p_slot_min: dur,
    });
    if (error) return flash("Fehler: " + error.message);
    flash(data ? "Slot angelegt." : "Nicht angelegt – überschneidet sich mit einem bestehenden Slot oder liegt in der Vergangenheit.", data > 0);
  });

  // ---------- Start ----------
  sb.auth.getSession().then(({ data }) => showForSession(data.session));
})();
