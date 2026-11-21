// Freyschnitt – öffentliche Buchungsseite (ohne Framework, ohne Bibliothek)
// Alle Daten kommen über die Edge Function "book", die das Freundes-Passwort prüft.
(function () {
  "use strict";

  const C = window.FREY_CONFIG;
  const TZ = "Europe/Berlin";
  const CODE_KEY = "frey_code";
  const $ = (id) => document.getElementById(id);

  const els = {
    gate: $("gate"), gateForm: $("gate-form"), gateMsg: $("gate-msg"), gateBtn: $("gate-btn"), code: $("code"),
    termine: $("termine"), slots: $("slots"), slotsMsg: $("slots-msg"),
    section: $("buchen"), form: $("form"), picked: $("picked-text"),
    change: $("change"), msg: $("msg"), submit: $("submit"),
  };

  let code = "";
  let selected = null;          // { id, starts_at, ends_at }
  let serviceId = 0;            // es gibt nur eine Leistung (Haarschnitt) → wird automatisch gesetzt
  let formShownAt = Date.now();

  // ---------- Passwort merken (nur auf diesem Gerät) ----------
  const store = {
    get() { try { return localStorage.getItem(CODE_KEY) || ""; } catch (e) { return ""; } },
    set(v) { try { localStorage.setItem(CODE_KEY, v); } catch (e) { /* privates Surfen */ } },
    clear() { try { localStorage.removeItem(CODE_KEY); } catch (e) { /* egal */ } },
  };

  // ---------- Formatierung (immer deutsche Zeit) ----------
  const fmtDay = new Intl.DateTimeFormat("de-DE", { timeZone: TZ, weekday: "long", day: "numeric", month: "long" });
  const fmtShort = new Intl.DateTimeFormat("de-DE", { timeZone: TZ, weekday: "short", day: "2-digit", month: "2-digit" });
  const fmtTime = new Intl.DateTimeFormat("de-DE", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
  const dayKey = (d) => new Intl.DateTimeFormat("sv-SE", { timeZone: TZ }).format(d); // YYYY-MM-DD

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
    els.gate.hidden = false;
    els.termine.hidden = true;
    els.section.hidden = true;
    els.gateMsg.textContent = message || "";
    setTimeout(() => els.code.focus(), 50);
  }

  els.gateForm.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const v = els.code.value.trim();
    if (!v) return;
    code = v;
    els.gateBtn.disabled = true;
    els.gateBtn.textContent = "Prüfe …";
    const ok = await loadSlots();
    els.gateBtn.disabled = false;
    els.gateBtn.textContent = "Los";
    if (ok) { store.set(code); els.code.value = ""; }
  });

  // ---------- Termine laden & anzeigen ----------
  // Rückgabe: true = Passwort ok und Daten geladen
  async function loadSlots() {
    els.slots.replaceChildren(p("Lade Termine …", "loading"));
    let out;
    try {
      out = await call({ action: "slots", days: C.DAYS_AHEAD });
    } catch (e) {
      out = { ok: false, error: "NETWORK" };
    }

    if (!out.ok) {
      if (out.error === "WRONG_CODE") { store.clear(); showGate(code ? "Das Passwort stimmt nicht." : ""); return false; }
      if (out.error === "RATE_LIMIT") { showGate("Zu viele Versuche. Bitte warte eine Stunde."); return false; }
      if (!els.gate.hidden) { els.gateMsg.textContent = "Gerade keine Verbindung. Bitte versuch es gleich nochmal."; return false; }
      els.termine.hidden = false;
      els.slots.replaceChildren(p("Termine konnten gerade nicht geladen werden. Bitte versuch es gleich nochmal.", "empty"));
      return false;
    }

    els.gate.hidden = true;
    els.termine.hidden = false;
    serviceId = out.services && out.services.length ? out.services[0].id : 0;
    renderSlots(out.slots || []);
    return true;
  }

  function renderSlots(slots) {
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

  function pick(slot, btn) {
    selected = slot;
    els.slots.querySelectorAll(".chip").forEach((c) => c.setAttribute("aria-pressed", "false"));
    btn.setAttribute("aria-pressed", "true");
    const s = new Date(slot.starts_at), e = new Date(slot.ends_at);
    els.picked.textContent = "→ " + fmtShort.format(s) + " · " + fmtTime.format(s) + "–" + fmtTime.format(e);
    if (els.section.hidden) formShownAt = Date.now();
    els.section.hidden = false;
    els.msg.textContent = "";
    els.slotsMsg.textContent = "";
    els.section.scrollIntoView({ block: "start" });
    setTimeout(() => $("name").focus({ preventScroll: true }), 350);
  }

  els.change.addEventListener("click", () => els.termine.scrollIntoView({ block: "start" }));

  // ---------- Absenden ----------
  const ERRORS = {
    SLOT_UNAVAILABLE: "Dieser Termin ist leider gerade weggegangen. Such dir bitte einen anderen aus.",
    RATE_LIMIT: "Zu viele Versuche. Bitte warte eine Stunde und versuch es dann nochmal.",
    TOO_MANY_BOOKINGS: "Du hast schon zwei offene Termine. Mehr gehen gleichzeitig nicht.",
    INVALID_NAME: "Bitte gib deinen Namen an (mind. 2 Zeichen).",
    INVALID_EMAIL: "Bitte prüf deine E-Mail-Adresse.",
    INVALID_NOTE: "Die Notiz ist zu lang (max. 500 Zeichen).",
    INVALID_SERVICE: "Da ist etwas schiefgelaufen. Bitte lade die Seite neu.",
    NO_CONSENT: "Bitte bestätige die Datenschutzerklärung.",
  };

  els.form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    els.msg.textContent = "";

    const data = {
      action: "book",
      slot_id: selected && selected.id,
      service_id: serviceId,
      name: $("name").value.trim(),
      email: $("email").value.trim(),
      note: $("note").value.trim(),
      consent: $("consent").checked,
      website: $("website").value,               // Honeypot
      elapsed_ms: Date.now() - formShownAt,      // Bots sind schneller als Menschen
    };

    // Schnelle Prüfung im Browser (die echte Prüfung macht der Server)
    if (!data.slot_id) return showError("Bitte wähl zuerst einen Termin aus.");
    if (data.name.length < 2) return showError(ERRORS.INVALID_NAME, "name");
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(data.email)) return showError(ERRORS.INVALID_EMAIL, "email");
    if (!data.service_id) return showError(ERRORS.INVALID_SERVICE);
    if (!data.consent) return showError(ERRORS.NO_CONSENT, "consent");

    els.submit.disabled = true;
    els.submit.textContent = "Wird gebucht …";
    try {
      const out = await call(data);
      if (out.ok) {
        try {
          sessionStorage.setItem("frey_booking", JSON.stringify({
            starts_at: out.starts_at, ends_at: out.ends_at, service: out.service, email: data.email,
          }));
        } catch (e) { /* privates Surfen: danke.html zeigt dann einen allgemeinen Text */ }
        location.href = "danke.html";
        return;
      }
      if (out.error === "WRONG_CODE") { store.clear(); showGate("Das Passwort hat sich geändert. Bitte neu eingeben."); return; }
      if (out.error === "SLOT_UNAVAILABLE") {
        selected = null;
        els.section.hidden = true;
        els.slotsMsg.textContent = ERRORS.SLOT_UNAVAILABLE;
        els.termine.scrollIntoView({ block: "start" });
        loadSlots();
        return;
      }
      showError(ERRORS[out.error] || "Da ist etwas schiefgelaufen. Bitte versuch es nochmal.");
    } catch (e) {
      showError("Keine Verbindung. Bitte prüf dein Internet und versuch es nochmal.");
    } finally {
      els.submit.disabled = false;
      els.submit.textContent = "Termin buchen";
    }
  });

  function showError(text, focusId) {
    els.msg.textContent = text;
    if (focusId) $(focusId).focus();
  }

  // ---------- Start ----------
  code = store.get();
  if (code) loadSlots(); else showGate();
})();
