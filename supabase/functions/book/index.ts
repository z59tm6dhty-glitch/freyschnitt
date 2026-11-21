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
  };
}

async function sendMail(to: string, subject: string, html: string, text: string, replyTo?: string) {
  const key = env("RESEND_API_KEY");
  const from = env("MAIL_FROM");
  if (!key || !from) return;
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ from, to: [to], subject, html, text, ...(replyTo ? { reply_to: replyTo } : {}) }),
  });
  if (!r.ok) console.error("Resend-Fehler", r.status, await r.text());
}

function mailLayout(inner: string) {
  return `<!doctype html><html lang="de"><body style="margin:0;background:#0d0d0e;padding:24px 12px;font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#f2f2f0">
<div style="max-width:480px;margin:0 auto;background:#17171a;border:1px solid #2a2a2f;border-radius:20px;padding:24px">
<div style="font-family:ui-monospace,Menlo,monospace;font-size:13px;letter-spacing:.12em;text-transform:uppercase;margin-bottom:20px">FREY<span style="color:#d4ff3a">/</span>SCHNITT</div>
${inner}
</div></body></html>`;
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

  tasks.push(sendMail(
    data.email,
    `Termin bestätigt: ${when.short}`,
    mailLayout(`<h1 style="font-size:24px;margin:0 0 12px">Hey ${name}, dein Termin steht.</h1>
<p style="margin:0 0 4px;color:#d4ff3a;font-family:ui-monospace,Menlo,monospace">${esc(when.day)}</p>
<p style="margin:0 0 16px;color:#d4ff3a;font-family:ui-monospace,Menlo,monospace">${esc(when.time)}</p>
<p style="margin:0 0 16px;color:#b5b5b0">Leistung: ${esc(data.service)}</p>
<p style="margin:0;color:#b5b5b0">Du kannst doch nicht? Antworte einfach auf diese Mail, dann gebe ich den Slot wieder frei.</p>`),
    `Hey ${data.name}, dein Termin steht.\n\n${when.day}\n${when.time}\nLeistung: ${data.service}\n\nDu kannst doch nicht? Antworte einfach auf diese Mail.`,
    env("ADMIN_EMAIL") || undefined,
  ));

  if (env("ADMIN_EMAIL")) {
    tasks.push(sendMail(
      env("ADMIN_EMAIL"),
      `Neue Buchung: ${when.short} – ${data.name}`,
      mailLayout(`<h1 style="font-size:22px;margin:0 0 12px">Neue Buchung</h1>
<p style="margin:0 0 12px;color:#d4ff3a;font-family:ui-monospace,Menlo,monospace">${esc(when.day)}<br>${esc(when.time)}</p>
<p style="margin:0 0 4px">${name} · <a style="color:#f2f2f0" href="mailto:${esc(data.email)}">${esc(data.email)}</a></p>
<p style="margin:0 0 4px;color:#b5b5b0">${esc(data.service)}</p>
${note ? `<p style="margin:12px 0 0;color:#b5b5b0">Notiz: ${note}</p>` : ""}`),
      `Neue Buchung\n${when.day}, ${when.time}\n${data.name} <${data.email}>\n${data.service}${data.note ? "\nNotiz: " + data.note : ""}`,
      data.email,
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
