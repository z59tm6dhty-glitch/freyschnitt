// Freyschnitt – öffentliche Buchungsseite (ohne Framework, ohne Bibliothek)
// Alle Daten kommen über die Edge Function "book", die das Freundes-Passwort prüft.
// Ablauf: 0 Passwort → 1 Tag → 2 Uhrzeit → 3 Buchen → 4 Ticket
(function () {
  "use strict";

  const C = window.FREY_CONFIG;
  const TZ = "Europe/Berlin";
  const CODE_KEY = "frey_code";
  const LOCATION = "Penthouse";
  const $ = (id) => document.getElementById(id);

  let code = "";
  let days = [];                // [{ date, items: [slot] }]
  let currentDay = null;
  let selected = null;          // { id, starts_at, ends_at }
  let booked = null;            // { starts_at, ends_at, name, email }
  let serviceId = 0;            // es gibt nur eine Leistung (Haarschnitt) → wird automatisch gesetzt
  let formShownAt = Date.now();
  let step = -1;

  // ---------- Passwort merken (nur auf diesem Gerät) ----------
  const store = {
    get() { try { return localStorage.getItem(CODE_KEY) || ""; } catch (e) { return ""; } },
    set(v) { try { localStorage.setItem(CODE_KEY, v); } catch (e) { /* privates Surfen */ } },
    clear() { try { localStorage.removeItem(CODE_KEY); } catch (e) { /* egal */ } },
  };

  // ---------- Formatierung (immer deutsche Zeit) ----------
  const F = (o) => new Intl.DateTimeFormat("de-DE", Object.assign({ timeZone: TZ }, o));
  const fmtWeekday = F({ weekday: "long" });
  const fmtDate = F({ day: "numeric", month: "long" });
  const fmtDayHead = F({ weekday: "long", day: "numeric", month: "short" });
  const fmtShort = F({ weekday: "short", day: "2-digit", month: "2-digit" });
  const fmtTicket = F({ weekday: "short", day: "numeric", month: "short" });
  const fmtTime = F({ hour: "2-digit", minute: "2-digit" });
  const dayKey = (d) => new Intl.DateTimeFormat("sv-SE", { timeZone: TZ }).format(d); // YYYY-MM-DD

  // ---------- Schritte ----------
  function show(n, push) {
    if (n === 2 && !currentDay) n = 1;
    if (n === 3 && !selected) n = 1;
    if (n === 4 && !booked) n = 1;
    if (n > 0 && n < 4 && !code) n = 0;
    // Richtung für die Animation: vorwärts von rechts, zurück von links
    document.querySelector("main").dataset.dir = n < step ? "back" : "fwd";
    for (let i = 0; i <= 4; i++) $("s" + i).hidden = i !== n;
    const prog = $("progress");
    prog.classList.toggle("hide", n === 0);
    prog.querySelectorAll("i").forEach((x, i) => x.classList.toggle("done", i < Math.min(n, 3)));
    const no = $("step-no"), label = n === 0 ? "" : n === 4 ? "✓" : n + " / 3";
    if (no.textContent !== label) { no.textContent = label; no.classList.remove("tick"); void no.offsetWidth; no.classList.add("tick"); }
    if (push && n !== step) history.pushState({ s: n }, "");
    step = n;
    window.scrollTo(0, 0);
    if (n === 0) setTimeout(() => $("code").focus(), 50);
  }
  window.addEventListener("popstate", (ev) => {
    const n = ev.state && typeof ev.state.s === "number" ? ev.state.s : (code ? 1 : 0);
    if (step === 4) { booked = null; selected = null; loadSlots(); }   // nach dem Buchen zurück = neu anfangen
    show(n, false);
  });
  document.querySelectorAll("[data-go]").forEach((b) => b.addEventListener("click", () => show(+b.dataset.go, true)));

  // ---------- Edge Function ----------
  async function call(payload) {
    const res = await fetch(C.SUPABASE_URL + "/functions/v1/book", {
      method: "POST",
      headers: { apikey: C.SUPABASE_KEY, "content-type": "application/json" },
      body: JSON.stringify(Object.assign({ code }, payload)),
    });
    return res.json().catch(() => ({ ok: false, error: "SERVER" }));
  }

  function p(text, cls) {
    const el = document.createElement("p");
    el.className = cls;
    el.textContent = text;
    return el;
  }

  // ---------- Passwort-Abfrage ----------
  function showGate(message) {
    $("gate-msg").textContent = message || "";
    history.replaceState({ s: 0 }, "");
    show(0, false);
  }

  $("gate-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const v = $("code").value.trim();
    if (!v) return;
    code = v;
    const btn = $("gate-btn");
    btn.disabled = true;
    btn.firstElementChild.textContent = "Prüfe …";
    const ok = await loadSlots();
    btn.disabled = false;
    btn.firstElementChild.textContent = "Los";
    if (ok) { store.set(code); $("code").value = ""; show(1, true); }
  });

  // ---------- Termine laden ----------
  // Rückgabe: true = Passwort ok und Daten geladen
  async function loadSlots() {
    $("days").replaceChildren(p("Lade Termine …", "loading"));
    let out;
    try {
      out = await call({ action: "slots", days: C.DAYS_AHEAD });
    } catch (e) {
      out = { ok: false, error: "NETWORK" };
    }

    if (!out.ok) {
      if (out.error === "WRONG_CODE") { const had = !!code; store.clear(); code = ""; showGate(had ? "Das Passwort stimmt nicht." : ""); return false; }
      if (out.error === "RATE_LIMIT") { code = ""; showGate("Zu viele Versuche. Bitte warte eine Stunde."); return false; }
      if (step === 0) { $("gate-msg").textContent = "Gerade keine Verbindung. Bitte versuch es gleich nochmal."; return false; }
      $("days").replaceChildren(p("Termine konnten gerade nicht geladen werden. Bitte versuch es gleich nochmal.", "empty"));
      return false;
    }

    $("gate-msg").textContent = "";
    serviceId = out.services && out.services.length ? out.services[0].id : 0;
    groupSlots(out.slots || []);
    renderDays();
    return true;
  }

  function groupSlots(slots) {
    const groups = new Map();
    for (const s of slots) {
      const d = new Date(s.starts_at);
      const k = dayKey(d);
      if (!groups.has(k)) groups.set(k, { key: k, date: d, items: [] });
      groups.get(k).items.push(s);
    }
    days = [...groups.values()];
    if (currentDay) currentDay = days.find((d) => d.key === currentDay.key) || null;
  }

  // ---------- Schritt 1: Tage ----------
  function renderDays() {
    const box = $("days");
    if (!days.length) {
      box.replaceChildren(p("Gerade sind keine Termine frei. Schau bald wieder rein!", "empty"));
      return;
    }
    const frag = document.createDocumentFragment();
    for (const day of days) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "opt";
      const left = document.createElement("span");
      const wd = document.createElement("b"); wd.textContent = fmtWeekday.format(day.date);
      const dt = document.createElement("small"); dt.textContent = fmtDate.format(day.date);
      left.append(wd, document.createElement("br"), dt);
      const n = document.createElement("span");
      n.className = "n";
      n.textContent = day.items.length + " frei";
      b.append(left, n);
      b.addEventListener("click", () => openDay(day));
      frag.append(b);
    }
    box.replaceChildren(frag);
  }

  // ---------- Schritt 2: Uhrzeiten ----------
  function openDay(day) {
    currentDay = day;
    $("slots-msg").textContent = "";
    $("day-h").textContent = fmtDayHead.format(day.date);
    const frag = document.createDocumentFragment();
    for (const s of day.items) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "opt";
      b.textContent = fmtTime.format(new Date(s.starts_at));
      b.setAttribute("aria-label", fmtDayHead.format(day.date) + ", " + b.textContent + " Uhr");
      b.addEventListener("click", () => pick(s));
      frag.append(b);
    }
    $("times").replaceChildren(frag);
    show(2, true);
  }

  // ---------- Schritt 3: Buchen ----------
  function pick(slot) {
    if (!selected || selected.id !== slot.id) formShownAt = Date.now();
    selected = slot;
    const s = new Date(slot.starts_at), e = new Date(slot.ends_at);
    $("picked-text").textContent = "→ " + fmtShort.format(s) + " · " + fmtTime.format(s) + "–" + fmtTime.format(e);
    $("msg").textContent = "";
    show(3, true);
    setTimeout(() => { if (!$("name").value) $("name").focus({ preventScroll: true }); }, 350);
  }

  const ERRORS = {
    SLOT_UNAVAILABLE: "Dieser Termin ist leider gerade weggegangen. Such dir bitte einen anderen aus.",
    RATE_LIMIT: "Zu viele Versuche. Bitte warte eine Stunde und versuch es dann nochmal.",
    TOO_MANY_BOOKINGS: "Du hast schon zwei offene Termine. Mehr gehen gleichzeitig nicht.",
    INVALID_NAME: "Bitte gib deinen Namen an (mind. 2 Zeichen).",
    INVALID_EMAIL: "Bitte prüf deine E-Mail-Adresse.",
    INVALID_NOTE: "Die Notiz ist zu lang (max. 500 Zeichen).",
    INVALID_SERVICE: "Da ist etwas schiefgelaufen. Bitte lade die Seite neu.",
  };

  $("form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    $("msg").textContent = "";

    const data = {
      action: "book",
      slot_id: selected && selected.id,
      service_id: serviceId,
      name: $("name").value.trim(),
      email: $("email").value.trim(),
      note: $("note").value.trim(),
      consent: true,                             // Server erwartet das Feld; private Seite ohne Datenschutzerklärung
      website: $("website").value,               // Honeypot
      elapsed_ms: Date.now() - formShownAt,      // Bots sind schneller als Menschen
    };

    // Schnelle Prüfung im Browser (die echte Prüfung macht der Server)
    if (!data.slot_id) return show(1, true);
    if (data.name.length < 2) return showError(ERRORS.INVALID_NAME, "name");
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(data.email)) return showError(ERRORS.INVALID_EMAIL, "email");
    if (!data.service_id) return showError(ERRORS.INVALID_SERVICE);

    const btn = $("submit");
    btn.disabled = true;
    btn.firstElementChild.textContent = "Wird gebucht …";
    try {
      const out = await call(data);
      if (out.ok) {
        booked = {
          starts_at: out.starts_at || selected.starts_at,
          ends_at: out.ends_at || selected.ends_at,
          id: selected.id, name: data.name, email: data.email,
        };
        renderTicket();
        $("form").reset();
        history.replaceState({ s: 4 }, "");
        show(4, false);
        return;
      }
      if (out.error === "WRONG_CODE") { store.clear(); code = ""; showGate("Das Passwort hat sich geändert. Bitte neu eingeben."); return; }
      if (out.error === "SLOT_UNAVAILABLE") {
        selected = null;
        await loadSlots();
        $("slots-msg").textContent = ERRORS.SLOT_UNAVAILABLE;
        show(1, true);
        return;
      }
      showError(ERRORS[out.error] || "Da ist etwas schiefgelaufen. Bitte versuch es nochmal.");
    } catch (e) {
      showError("Keine Verbindung. Bitte prüf dein Internet und versuch es nochmal.");
    } finally {
      btn.disabled = false;
      btn.firstElementChild.textContent = "Termin buchen";
    }
  });

  function showError(text, focusId) {
    $("msg").textContent = text;
    if (focusId) $(focusId).focus();
  }

  // ---------- Schritt 4: Ticket ----------
  function renderTicket() {
    const s = new Date(booked.starts_at), e = new Date(booked.ends_at);
    $("tk-day").textContent = fmtTicket.format(s);
    $("tk-time").textContent = fmtTime.format(s);
    $("tk-dur").textContent = Math.round((e - s) / 60000) + " Min";
    $("tk-name").textContent = booked.name;
    $("mailnote").textContent = "Die Bestätigung (mit Kalender-Einladung im Anhang) geht an " + booked.email + ". Schau auch im Spam-Ordner nach, falls sie nicht ankommt.";
    renderCalendarLinks();
  }

  // ---------- Kalender ----------
  // Bewusst echte Links statt Skript-Download: iPhone-Safari, Android und
  // In-App-Browser (WhatsApp, Instagram …) behandeln einen Tipp auf einen Link
  // zuverlässiger als ein per JavaScript ausgelöstes click()/location.href.
  // Die .ics ist dieselbe Einladung wie im Mail-Anhang.
  const CAL_TITLE = "Friseur " + LOCATION;
  const CAL_TEXT = "Du kannst doch nicht? Schreib mir.";
  const icsDate = (d) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const icsText = (t) => String(t).replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
  function buildIcs() {
    return [
      "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Freyschnitt//Termine//DE", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
      "BEGIN:VEVENT",
      "UID:" + booked.id + "@freyschnitt.de",
      "DTSTAMP:" + icsDate(new Date()),
      "DTSTART:" + icsDate(new Date(booked.starts_at)),
      "DTEND:" + icsDate(new Date(booked.ends_at)),
      "SUMMARY:" + icsText(CAL_TITLE),
      "DESCRIPTION:" + icsText(CAL_TEXT),
      "LOCATION:" + icsText(LOCATION),
      "STATUS:CONFIRMED",
      "BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:" + icsText(CAL_TITLE), "TRIGGER:-PT1H", "END:VALARM",
      "END:VEVENT", "END:VCALENDAR", "",
    ].join("\r\n");
  }

  function renderCalendarLinks() {
    const s = new Date(booked.starts_at), e = new Date(booked.ends_at);
    // data:-URL statt blob:-URL: bleibt gültig, funktioniert auch in WebViews
    $("cal-ics").href = "data:text/calendar;charset=utf-8," + encodeURIComponent(buildIcs());
    $("cal-google").href = "https://calendar.google.com/calendar/render?" + new URLSearchParams({
      action: "TEMPLATE", text: CAL_TITLE, dates: icsDate(s) + "/" + icsDate(e), details: CAL_TEXT, location: LOCATION,
    });
    $("cal-outlook").href = "https://outlook.live.com/calendar/0/deeplink/compose?" + new URLSearchParams({
      path: "/calendar/action/compose", rru: "addevent", subject: CAL_TITLE,
      startdt: s.toISOString(), enddt: e.toISOString(), body: CAL_TEXT, location: LOCATION,
    });
    $("cal-opts").hidden = true;
    $("cal").setAttribute("aria-expanded", "false");
  }

  $("cal").addEventListener("click", () => {
    if (!booked) return;
    const open = $("cal-opts").hidden;
    $("cal-opts").hidden = !open;
    $("cal").setAttribute("aria-expanded", String(open));
  });

  // ---------- Start ----------
  code = store.get();
  if (code) {
    history.replaceState({ s: 1 }, "");
    show(1, false);
    loadSlots();
  } else {
    showGate();
  }
})();
