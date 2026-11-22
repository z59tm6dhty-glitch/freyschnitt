// Supabase Edge Function "book"
// Einziger öffentlicher Zugang zur Datenbank. Jede Anfrage braucht das Freundes-Passwort.
//
//   { action: "slots", code }                → freie Termine + Leistungen
//   { action: "book",  code, slot_id, ... }  → Termin buchen + Mails verschicken
//
// Secrets (Dashboard → Edge Functions → Secrets):
//   FRIEND_CODE        das Passwort für deine Kumpels   (fehlt = Seite ist komplett gesperrt)
//   RESEND_API_KEY     Resend API Key                   (fehlt = keine Mails)
//   MAIL_FROM          z. B. "Freyschnitt <termine@freyschnitt.de>"
//   ADMIN_EMAIL        deine Adresse für Benachrichtigungen
//   SLACK_WEBHOOK_URL  Slack Incoming Webhook (optional)
// Automatisch vorhanden: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import { createClient } from "npm:@supabase/supabase-js@2.49.4";

const ALLOWED_ORIGINS = [
  "https://freyschnitt.de",
  "https://www.freyschnitt.de",
  "https://z59tm6dhty-glitch.github.io",
  "http://localhost:8000",
];

const TZ = "Europe/Berlin";
const env = (k: string) => Deno.env.get(k) ?? "";
const str = (v: unknown) => (typeof v === "string" ? v : "");

function cors(origin: string | null): HeadersInit {
  const allowed = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "apikey, content-type, authorization, x-client-info",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

function json(body: unknown, origin: string | null, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors(origin), "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function clientIp(req: Request): string {
  return (
    req.headers.get("cf-connecting-ip") ??
    req.headers.get("x-real-ip") ??
    (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim()
  ) || "unknown";
}

const enc = new TextEncoder();

// IP nicht im Klartext speichern: HMAC mit geheimem Schlüssel + Tagesdatum
async function hashIp(ip: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(env("SUPABASE_SERVICE_ROLE_KEY")), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const day = new Date().toISOString().slice(0, 10);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(ip + "|" + day));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Passwort vergleichen: Groß/Klein und Leerzeichen am Rand egal (Handy-Tastaturen!)
const normCode = (s: string) => s.normalize("NFC").trim().toLowerCase();
async function codeMatches(input: string): Promise<boolean> {
  const expected = env("FRIEND_CODE");
  if (!expected) {
    console.error("FRIEND_CODE ist nicht gesetzt – Seite bleibt gesperrt.");
    return false;
  }
  if (!input || input.length > 200) return false;
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(normCode(input))),
    crypto.subtle.digest("SHA-256", enc.encode(normCode(expected))),
  ]);
  const x = new Uint8Array(a), y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i]; // zeitkonstanter Vergleich
  return diff === 0;
}

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

function fmt(startIso: string, endIso: string) {
  const s = new Date(startIso), e = new Date(endIso);
  const t = new Intl.DateTimeFormat("de-DE", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
  return {
    day: new Intl.DateTimeFormat("de-DE", { timeZone: TZ, weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(s),
    time: `${t.format(s)}–${t.format(e)} Uhr`,
    short: new Intl.DateTimeFormat("de-DE", { timeZone: TZ, weekday: "short", day: "2-digit", month: "2-digit" }).format(s) + " " + t.format(s),
    ticketDay: new Intl.DateTimeFormat("de-DE", { timeZone: TZ, weekday: "short", day: "numeric", month: "short" }).format(s),
    start: t.format(s),
    dur: Math.round((e.getTime() - s.getTime()) / 60000) + " Min",
  };
}

// ---------- Kalendereinladung (.ics) ----------
const LOCATION = "Penthouse";

// Text für ICS escapen (RFC 5545)
const icsText = (s: string) =>
  s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");

// Zeilen > 75 Bytes umbrechen (Fortsetzung beginnt mit Leerzeichen)
function icsFold(line: string): string {
  const out: string[] = [];
  let cur = "", bytes = 0;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    if (bytes + n > (out.length ? 74 : 75)) { out.push(cur); cur = ""; bytes = 0; }
    cur += ch; bytes += n;
  }
  out.push(cur);
  return out.join("\r\n ");
}

const icsDate = (iso: string) => new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

function buildIcs(o: { uid: string; start: string; end: string; summary: string; description: string }): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Freyschnitt//Termine//DE",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${o.uid}`,
    `DTSTAMP:${icsDate(new Date().toISOString())}`,
    `DTSTART:${icsDate(o.start)}`,
    `DTEND:${icsDate(o.end)}`,
    `SUMMARY:${icsText(o.summary)}`,
    `DESCRIPTION:${icsText(o.description)}`,
    `LOCATION:${icsText(LOCATION)}`,
    "STATUS:CONFIRMED",
    "BEGIN:VALARM",
    "ACTION:DISPLAY",
    `DESCRIPTION:${icsText(o.summary)}`,
    "TRIGGER:-PT1H",
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return lines.map(icsFold).join("\r\n") + "\r\n";
}

const b64 = (s: string) => btoa(Array.from(enc.encode(s), (b) => String.fromCharCode(b)).join(""));

type Attachment = { filename: string; content: string; content_type: string };
const icsAttachment = (ics: string): Attachment => ({
  filename: "termin.ics",
  content: b64(ics),
  content_type: "text/calendar; charset=utf-8; method=PUBLISH",
});

async function sendMail(
  to: string, subject: string, html: string, text: string, replyTo?: string, attachments?: Attachment[],
) {
  const key = env("RESEND_API_KEY");
  const from = env("MAIL_FROM");
  if (!key || !from) return;
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      from, to: [to], subject, html, text,
      ...(replyTo ? { reply_to: replyTo } : {}),
      ...(attachments?.length ? { attachments } : {}),
    }),
  });
  if (!r.ok) console.error("Resend-Fehler", r.status, await r.text());
}

// ---------- Mail-Design (wie die Buchungsseite: Schritt für Schritt + Ticket) ----------
// Mail-tauglich: nur Tabellen + Inline-Styles, keine Masken/Transforms (Gmail, Outlook, Apple Mail).
const C = { bg: "#efece4", ink: "#121212", muted: "#74716a", card: "#fbfaf6", accent: "#d4ff3a", orange: "#ff5b2e" };
const SANS = "-apple-system,BlinkMacSystemFont,'SF Pro Display','Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const MONO = "ui-monospace,'SF Mono',Menlo,Consolas,monospace";

function mailLayout(inner: string, preheader = "") {
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light only"></head>
<body style="margin:0;padding:0;background:${C.bg};color:${C.ink};font-family:${SANS};-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${preheader}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.bg}">
<tr><td align="center" style="padding:28px 16px 40px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:460px">
<tr><td style="font-family:${MONO};font-size:13px;letter-spacing:.14em;text-transform:uppercase;color:${C.ink};padding:0 0 30px">FREY<span style="color:${C.orange}">/</span>SCHNITT</td></tr>
${inner}
</table>
</td></tr></table></body></html>`;
}

const hl = (s: string) =>
  `<span style="background:${C.accent};padding:0 .1em;border-radius:.1em">${s}</span>`;

function mailTitle(html: string) {
  return `<tr><td style="font-family:${SANS};font-size:44px;line-height:.95;letter-spacing:-.05em;font-weight:800;color:${C.ink};padding:0 0 12px">${html}</td></tr>`;
}

function mailText(html: string, pad = "0 0 12px") {
  return `<tr><td style="font-family:${SANS};font-size:16px;line-height:1.5;color:${C.muted};padding:${pad}">${html}</td></tr>`;
}

function ticketCell(label: string, value: string, full = false) {
  return `<td ${full ? 'colspan="2"' : 'width="50%"'} valign="top" style="padding:0 10px 16px 0">
<div style="font-family:${MONO};font-size:11px;letter-spacing:.12em;color:#8f8d87">${label}</div>
<div style="font-family:${SANS};font-size:18px;font-weight:700;color:${C.bg};word-break:break-word">${value}</div></td>`;
}

// Ticket: oben Leuchtgelb mit Datum, Perforation mit Kerben, unten dunkel mit Details
function mailTicket(o: { tag: string; day: string; rows: [string, string][] }) {
  const rows: string[] = [];
  for (let i = 0; i < o.rows.length; i += 2) {
    const a = o.rows[i], b = o.rows[i + 1];
    rows.push(`<tr>${ticketCell(a[0], a[1], !b)}${b ? ticketCell(b[0], b[1]) : ""}</tr>`);
  }
  return `<tr><td style="padding:14px 0 26px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate">
<tr><td colspan="3" style="background:${C.accent};border-radius:26px 26px 0 0;padding:22px 22px 26px">
<div style="font-family:${MONO};font-size:12px;letter-spacing:.12em;color:${C.ink}">FREY/SCHNITT · ${o.tag}</div>
<div style="font-family:${SANS};font-size:34px;line-height:1;letter-spacing:-.03em;font-weight:800;color:${C.ink};padding-top:8px">${o.day}</div>
</td></tr>
<tr>
<td width="12" style="width:12px;height:24px;background:${C.ink};font-size:0;line-height:0"><div style="width:12px;height:24px;background:${C.bg};border-radius:0 12px 12px 0"></div></td>
<td style="background:${C.ink};padding:0 10px;font-size:0;line-height:0"><div style="border-top:2px dashed #4a4945;height:0"></div></td>
<td width="12" style="width:12px;height:24px;background:${C.ink};font-size:0;line-height:0"><div style="width:12px;height:24px;background:${C.bg};border-radius:12px 0 0 12px"></div></td>
</tr>
<tr><td colspan="3" style="background:${C.ink};border-radius:0 0 26px 26px;padding:18px 22px 20px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rows.join("")}</table>
<div style="font-family:${MONO};font-size:11px;letter-spacing:.5em;color:#6b6a66;padding-top:4px">||| | || ||| | ||| || |</div>
</td></tr>
</table></td></tr>`;
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });
  if (req.method !== "POST") return json({ ok: false, error: "BAD_REQUEST" }, origin, 405);

  let body: Record<string, unknown>;
  try {
    const raw = await req.text();
    if (raw.length > 5000) return json({ ok: false, error: "BAD_REQUEST" }, origin, 413);
    body = JSON.parse(raw);
  } catch {
    return json({ ok: false, error: "BAD_REQUEST" }, origin, 400);
  }

  const action = str(body.action) || "book";
  if (action !== "slots" && action !== "book") return json({ ok: false, error: "BAD_REQUEST" }, origin, 400);

  // Honeypot / zu schnell ausgefüllt → so tun, als hätte es geklappt (Bot merkt nichts)
  if (action === "book") {
    const elapsed = typeof body.elapsed_ms === "number" ? body.elapsed_ms : 0;
    if (str(body.website) !== "" || elapsed < 3000) {
      console.warn("Spam verworfen", { honeypot: str(body.website) !== "", elapsed });
      return json({ ok: true, starts_at: null, ends_at: null, service: null }, origin);
    }
  }

  const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const ipHash = await hashIp(clientIp(req));

  // Freundes-Passwort prüfen (Fehlversuche werden pro IP gezählt)
  const codeOk = await codeMatches(str(body.code));
  const gate = await db.rpc("code_gate", { p_ip_hash: ipHash, p_ok: codeOk });
  if (gate.error) {
    console.error("code_gate-Fehler", gate.error.message);
    return json({ ok: false, error: "SERVER" }, origin, 500);
  }
  if (gate.data === "BLOCKED") return json({ ok: false, error: "RATE_LIMIT" }, origin, 429);
  if (gate.data !== "OK") return json({ ok: false, error: "WRONG_CODE" }, origin, 401);

  // ---------- Termine + Leistungen ----------
  if (action === "slots") {
    const days = Math.min(Math.max(Number(body.days) || 35, 1), 90);
    const [slots, services] = await Promise.all([
      db.rpc("get_free_slots", { p_days: days }),
      db.from("services").select("id,name").eq("active", true).order("sort"),
    ]);
    if (slots.error || services.error) {
      console.error("Ladefehler", slots.error?.message, services.error?.message);
      return json({ ok: false, error: "SERVER" }, origin, 500);
    }
    return json({ ok: true, slots: slots.data, services: services.data }, origin);
  }

  // ---------- Buchen ----------
  const { data, error } = await db.rpc("book_slot", {
    p_slot_id: str(body.slot_id),
    p_service_id: Number(body.service_id) || 0,
    p_name: str(body.name),
    p_email: str(body.email),
    p_note: str(body.note),
    p_consent: body.consent === true,
    p_ip_hash: ipHash,
  });

  if (error) {
    console.error("book_slot-Fehler", error.message);
    const invalid = /uuid|invalid input/i.test(error.message);
    return json({ ok: false, error: invalid ? "SLOT_UNAVAILABLE" : "SERVER" }, origin, invalid ? 400 : 500);
  }
  if (!data?.ok) return json({ ok: false, error: data?.error ?? "SERVER" }, origin, 409);

  // Benachrichtigungen – Fehler hier machen die Buchung NICHT rückgängig
  const when = fmt(data.starts_at, data.ends_at);
  const name = esc(data.name);
  const note = data.note ? esc(data.note) : "";
  const tasks: Promise<unknown>[] = [];
  const uid = `${str(body.slot_id)}@freyschnitt.de`;

  const icsKunde = buildIcs({
    uid, start: data.starts_at, end: data.ends_at,
    summary: "Friseur Penthouse",
    description: "Du kannst doch nicht? Schreib mir.",
  });
  const icsAdmin = buildIcs({
    uid, start: data.starts_at, end: data.ends_at,
    summary: `Schnitt ${data.name}`,
    description: `${data.name} <${data.email}>${data.note ? "\nNotiz: " + data.note : ""}`,
  });

  tasks.push(sendMail(
    data.email,
    `Haarschnitt ${when.short}`,
    mailLayout(
      mailTitle(`Dein ${hl("Termin")}`) +
      mailText(`Hey ${name}, ist eingetragen.`, "0 0 6px") +
      mailTicket({
        tag: "GEBUCHT",
        day: esc(when.ticketDay),
        rows: [["UHRZEIT", esc(when.start)], ["DAUER", esc(when.dur)], ["ORT", esc(LOCATION)], ["NAME", name]],
      }) +
      mailText("Der Termin hängt als Kalendereintrag an (termin.ics).") +
      mailText("Du kannst doch nicht? Sag mir einfach kurz Bescheid, dann gebe ich den Slot wieder frei.", "0"),
      `${when.day}, ${when.time} · ${LOCATION}`,
    ),
    `Hey ${data.name}, dein Termin steht.\n\n${when.day}\n${when.time}\nOrt: ${LOCATION}\n\nDu kannst doch nicht? Schreib mir.`,
    env("ADMIN_EMAIL") || undefined,
    [icsAttachment(icsKunde)],
  ));

  if (env("ADMIN_EMAIL")) {
    tasks.push(sendMail(
      env("ADMIN_EMAIL"),
      `Neue Buchung: ${when.short} – ${data.name}`,
      mailLayout(
        mailTitle(`Neue ${hl("Buchung")}`) +
        mailTicket({
          tag: "NEU",
          day: esc(when.ticketDay),
          rows: [
            ["UHRZEIT", esc(when.start)], ["DAUER", esc(when.dur)],
            ["NAME", name], ["ORT", esc(LOCATION)],
            ["E-MAIL", `<a style="color:${C.bg};text-decoration:underline" href="mailto:${esc(data.email)}">${esc(data.email)}</a>`],
          ],
        }) +
        (note ? mailText(`<b style="color:${C.ink}">Notiz:</b> ${note}`, "0") : ""),
        `${when.short} – ${name}`,
      ),
      `Neue Buchung\n${when.day}, ${when.time}\n${data.name} <${data.email}>${data.note ? "\nNotiz: " + data.note : ""}`,
      data.email,
      [icsAttachment(icsAdmin)],
    ));
  }

  if (env("SLACK_WEBHOOK_URL")) {
    // Bewusst ohne Name, E-Mail und Notiz (Datensparsamkeit)
    tasks.push(fetch(env("SLACK_WEBHOOK_URL"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: `✂️ Neue Buchung: ${when.short} – ${data.service}` }),
    }).catch((e) => console.error("Slack-Fehler", e)));
  }

  await Promise.allSettled(tasks);
  return json({ ok: true, starts_at: data.starts_at, ends_at: data.ends_at, service: data.service }, origin);
});
