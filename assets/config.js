// Öffentliche Konfiguration – diese Werte DÜRFEN öffentlich sein.
// Niemals hier eintragen: Secret key, service_role key, Datenbank-Passwort, Resend-/Slack-Keys.
window.FREY_CONFIG = {
  SUPABASE_URL: "https://uxvnlxhuhxcaexeznhck.supabase.co",
  SUPABASE_KEY: "sb_publishable_NJqJWGru7KBCqA4TKh774A_TIJzay1F",

  // Cloudflare Turnstile "Site Key" (öffentlich). Leer lassen = Turnstile aus.
  TURNSTILE_SITE_KEY: "",

  // Wie viele Tage im Voraus Termine angezeigt werden
  DAYS_AHEAD: 35,
};
