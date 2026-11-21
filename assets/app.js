// Freyschnitt – öffentliche Buchungsseite (ohne Framework, ohne Bibliothek)
(function () {
  "use strict";

  const C = window.FREY_CONFIG;
  const TZ = "Europe/Berlin";
  const $ = (id) => document.getElementById(id);

  const els = {
    slots: $("slots"), section: $("buchen"), form: $("form"), picked: $("picked-text"),
    change: $("change"), service: $("service"), msg: $("msg"), submit: $("submit"),
  };

  let selected = null;          // { id, starts_at, ends_at }
  let turnstileId = null;
  const formShownAt = Date.now();

  // ---------- Formatierung (immer deutsche Zeit) ----------
  const fmtDay = new Intl.DateTimeFormat("de-DE", { timeZone: TZ, weekday: "long", day: "numeric", month: "long" });
  const fmtShort = new Intl.DateTimeFormat("de-DE", { timeZone: TZ, weekday: "short", day: "2-digit", month: "2-digit" });
  const fmtTime = new Intl.DateTimeFormat("de-DE", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
  const dayKey = (d) => new Intl.DateTimeFormat("sv-SE", { timeZone: TZ }).format(d); // YYYY-MM-DD

  // ---------- Supabase-REST (nur öffentlicher Key) ----------
  async function api(path, body) {
    const res = await fetch(C.SUPABASE_URL + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { apikey: C.SUPABASE_KEY, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res.json();
  }

  // ---------- Termine laden & anzeigen ----------
  async function loadSlots() {
    els.slots.replaceChildren(p("Lade Termine …", "loading"));
    let slots;
    try {
      slots = await api("/rest/v1/rpc/get_free_slots", { p_days: C.DAYS_AHEAD });
    } catch (e) {
      els.slots.replaceChildren(p("Termine konnten gerade nicht geladen werden. Bitte versuch es gleich nochmal.", "empty"));
      return;
    }
    if (!slots.length) {
      els.slots.replaceChildren(p("Gerade sind keine Termine frei. Schau bald wieder rein!", "empty"));
      return;
    }

    const groups = new Map();
    for (const s of slots) {
      const d = new Date(s.starts_at);
      const k = dayKey(d);
      if (!groups.has(k)) groups.set(k, { date: d, items: [] });
      groups.get(k).items.push(s);
    }

    const frag = document.createDocumentFragment();
    for (const { date, items } of groups.values()) {
      const day = document.createElement("div");
      day.className = "day";
      const title = document.createElement("div");
      title.className = "day-title";
      title.textContent = fmtDay.format(date);
      const chips = document.createElement("div");
      chips.className = "chips";
      for (const s of items) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "chip";
        b.textContent = fmtTime.format(new Date(s.starts_at));
        b.setAttribute("aria-pressed", selected && selected.id === s.id ? "true" : "false");
        b.setAttribute("aria-label", fmtDay.format(date) + ", " + b.textContent + " Uhr");
        b.addEventListener("click", () => pick(s, b));
        chips.append(b);
      }
      day.append(title, chips);
      frag.append(day);
    }
    els.slots.replaceChildren(frag);
  }

  function p(text, cls) {
    const el = document.createElement("p");
    el.className = cls;
    el.textContent = text;
    return el;
  }

  function pick(slot, btn) {
    selected = slot;
    els.slots.querySelectorAll(".chip").forEach((c) => c.setAttribute("aria-pressed", "false"));
    btn.setAttribute("aria-pressed", "true");
    const s = new Date(slot.starts_at), e = new Date(slot.ends_at);
    els.picked.textContent = "→ " + fmtShort.format(s) + " · " + fmtTime.format(s) + "–" + fmtTime.format(e);
    els.section.hidden = false;
    els.msg.textContent = "";
    $("slots-msg").textContent = "";
    els.section.scrollIntoView({ block: "start" });
    setTimeout(() => $("name").focus({ preventScroll: true }), 350);
  }

  els.change.addEventListener("click", () => $("termine").scrollIntoView({ block: "start" }));

  // ---------- Leistungen ----------
  async function loadServices() {
    try {
      const list = await api("/rest/v1/services?select=id,name&order=sort");
      els.service.replaceChildren(...list.map((s) => {
        const o = document.createElement("option");
        o.value = s.id;
        o.textContent = s.name;
        return o;
      }));
    } catch (e) {
      const o = document.createElement("option");
      o.textContent = "Konnte nicht geladen werden";
      o.value = "";
      els.service.replaceChildren(o);
    }
  }

  // ---------- Cloudflare Turnstile (optional) ----------
  function initTurnstile() {
    if (!C.TURNSTILE_SITE_KEY) return;
    window.onTurnstileLoad = function () {
      turnstileId = window.turnstile.render("#turnstile", { sitekey: C.TURNSTILE_SITE_KEY, theme: "dark", language: "de" });
    };
    const s = document.createElement("script");
    s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=onTurnstileLoad";
    s.async = true;
    document.head.append(s);
  }

  // ---------- Absenden ----------
  const ERRORS = {
    SLOT_UNAVAILABLE: "Dieser Termin ist leider gerade weggegangen. Such dir bitte einen anderen aus.",
    RATE_LIMIT: "Zu viele Versuche. Bitte warte eine Stunde und versuch es dann nochmal.",
    TOO_MANY_BOOKINGS: "Du hast schon zwei offene Termine. Mehr gehen gleichzeitig nicht.",
    INVALID_NAME: "Bitte gib deinen Namen an (mind. 2 Zeichen).",
    INVALID_EMAIL: "Bitte prüf deine E-Mail-Adresse.",
    INVALID_NOTE: "Die Notiz ist zu lang (max. 500 Zeichen).",
    INVALID_SERVICE: "Bitte wähl eine Leistung aus.",
    NO_CONSENT: "Bitte bestätige die Datenschutzerklärung.",
    CAPTCHA: "Die Sicherheitsprüfung ist fehlgeschlagen. Bitte lade die Seite neu.",
  };

  els.form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    els.msg.textContent = "";

    const data = {
      slot_id: selected && selected.id,
      service_id: Number(els.service.value),
      name: $("name").value.trim(),
      email: $("email").value.trim(),
      note: $("note").value.trim(),
      consent: $("consent").checked,
      website: $("website").value,               // Honeypot
      elapsed_ms: Date.now() - formShownAt,      // Bots sind schneller als Menschen
      turnstile_token: turnstileId !== null ? window.turnstile.getResponse(turnstileId) : "",
    };

    // Schnelle Prüfung im Browser (die echte Prüfung macht der Server)
    if (!data.slot_id) return showError("Bitte wähl zuerst einen Termin aus.");
    if (data.name.length < 2) return showError(ERRORS.INVALID_NAME, "name");
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(data.email)) return showError(ERRORS.INVALID_EMAIL, "email");
    if (!data.service_id) return showError(ERRORS.INVALID_SERVICE, "service");
    if (!data.consent) return showError(ERRORS.NO_CONSENT, "consent");
    if (C.TURNSTILE_SITE_KEY && !data.turnstile_token) return showError("Bitte warte kurz, bis die Sicherheitsprüfung fertig ist.");

    els.submit.disabled = true;
    els.submit.textContent = "Wird gebucht …";
    try {
      const res = await fetch(C.SUPABASE_URL + "/functions/v1/book", {
        method: "POST",
        headers: { apikey: C.SUPABASE_KEY, "content-type": "application/json" },
        body: JSON.stringify(data),
      });
      const out = await res.json().catch(() => ({}));
      if (out.ok) {
        try {
          sessionStorage.setItem("frey_booking", JSON.stringify({
            starts_at: out.starts_at, ends_at: out.ends_at, service: out.service, email: data.email,
          }));
        } catch (e) { /* privates Surfen: egal, danke.html zeigt dann einen allgemeinen Text */ }
        location.href = "danke.html";
        return;
      }
      if (out.error === "SLOT_UNAVAILABLE") {
        selected = null;
        els.section.hidden = true;
        $("slots-msg").textContent = ERRORS.SLOT_UNAVAILABLE;
        $("termine").scrollIntoView({ block: "start" });
        loadSlots();
        return;
      }
      showError(ERRORS[out.error] || "Da ist etwas schiefgelaufen. Bitte versuch es nochmal.");
    } catch (e) {
      showError("Keine Verbindung. Bitte prüf dein Internet und versuch es nochmal.");
    } finally {
      els.submit.disabled = false;
      els.submit.textContent = "Termin buchen";
      if (turnstileId !== null) window.turnstile.reset(turnstileId);
    }
  });

  function showError(text, focusId) {
    els.msg.textContent = text;
    if (focusId) $(focusId).focus();
  }

  loadSlots();
  loadServices();
  initTurnstile();
})();
