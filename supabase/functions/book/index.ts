// Supabase Edge Function "book"
// Einziger Weg, eine Buchung anzulegen. Prüft Honeypot, Turnstile und Rate-Limit,
// ruft dann die Datenbankfunktion book_slot() auf und verschickt die Mails.
//
// Secrets (Dashboard → Edge Functions → Secrets), alle optional bis auf die automatisch vorhandenen:
//   TURNSTILE_SECRET   Cloudflare Turnstile Secret Key   (gesetzt = Turnstile ist Pflicht)
//   RESEND_API_KEY     Resend API Key                    (fehlt = keine Mails)
//   MAIL_FROM          z. B. "Freyschnitt <termine@freyschnitt.de>"
//   ADMIN_EMAIL        deine Adresse für Benachrichtigungen
//   SLACK_WEBHOOK_URL  Slack Incoming Webhook            (fehlt = kein Slack)
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
    headers: { ...cors(origin), "content-type": "application/json; charset=utf-8" },
  });
}

function clientIp(req: Request): string {
  return (
    req.headers.get("cf-connecting-ip") ??
    req.headers.get("x-real-ip") ??
    (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() ??
    "unknown"
  ) || "unknown";
}

// IP nicht im Klartext speichern: HMAC mit geheimem Schlüssel + Tagesdatum
async function hashIp(ip: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env("SUPABASE_SERVICE_ROLE_KEY")),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const day = new Date().toISOString().slice(0, 10);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(ip + "|" + day));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function verifyTurnstile(token: string, ip: string): Promise<boolean> {
  const secret = env("TURNSTILE_SECRET");
  if (!secret) return true; // Turnstile nicht eingerichtet
  if (!token || token.length > 2048) return false;
  const form = new FormData();
  form.append("secret", secret);
  form.append("response", token);
  if (ip !== "unknown") form.append("remoteip", ip);
  try {
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form });
    const out = await r.json();
    return out.success === true;
  } catch {
    return false;
  }
}

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

function fmt(startIso: string, endIso: string) {
  const s = new Date(startIso), e = new Date(endIso);
  const day = new Intl.DateTimeFormat("de-DE", { timeZone: TZ, weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(s);
  const t = new Intl.DateTimeFormat("de-DE", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
  return { day, time: `${t.format(s)}–${t.format(e)} Uhr`, short: new Intl.DateTimeFormat("de-DE", { timeZone: TZ, weekday: "short", day: "2-digit", month: "2-digit" }).format(s) + " " + t.format(s) };
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

  const str = (v: unknown) => (typeof v === "string" ? v : "");

  // 1. Honeypot / zu schnell ausgefüllt → so tun, als hätte es geklappt (Bot merkt nichts)
  const elapsed = typeof body.elapsed_ms === "number" ? body.elapsed_ms : 0;
  if (str(body.website) !== "" || elapsed < 3000) {
    console.warn("Spam verworfen", { honeypot: str(body.website) !== "", elapsed });
    return json({ ok: true, starts_at: null, ends_at: null, service: null }, origin);
  }

  const ip = clientIp(req);

  // 2. Turnstile
  if (!(await verifyTurnstile(str(body.turnstile_token), ip))) {
    return json({ ok: false, error: "CAPTCHA" }, origin, 400);
  }

  // 3. Buchen (Rate-Limit, Validierung, Doppelbuchungsschutz passieren in der DB)
  const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await db.rpc("book_slot", {
    p_slot_id: str(body.slot_id),
    p_service_id: Number(body.service_id) || 0,
    p_name: str(body.name),
    p_email: str(body.email),
    p_note: str(body.note),
    p_consent: body.consent === true,
    p_ip_hash: await hashIp(ip),
  });

  if (error) {
    // z. B. ungültige UUID → nicht nach außen durchreichen
    console.error("book_slot-Fehler", error.message);
    const invalid = /uuid|invalid input/i.test(error.message);
    return json({ ok: false, error: invalid ? "SLOT_UNAVAILABLE" : "SERVER" }, origin, invalid ? 400 : 500);
  }
  if (!data?.ok) return json({ ok: false, error: data?.error ?? "SERVER" }, origin, 409);

  // 4. Benachrichtigungen – Fehler hier machen die Buchung NICHT rückgängig
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
    // Bewusst ohne E-Mail-Adresse und Notiz (Datensparsamkeit)
    tasks.push(fetch(env("SLACK_WEBHOOK_URL"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: `✂️ Neue Buchung: ${when.short} – ${data.service}` }),
    }).catch((e) => console.error("Slack-Fehler", e)));
  }

  await Promise.allSettled(tasks);

  return json({ ok: true, starts_at: data.starts_at, ends_at: data.ends_at, service: data.service }, origin);
});
