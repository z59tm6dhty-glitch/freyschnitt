// Öffentliche Konfiguration – diese Werte DÜRFEN öffentlich sein.
// Niemals hier eintragen: Secret key, service_role key, Datenbank-Passwort, Resend-/Slack-Keys,
// und auch NICHT das Freundes-Passwort (das liegt nur als Secret in Supabase).
window.FREY_CONFIG = {
  SUPABASE_URL: "https://uxvnlxhuhxcaexeznhck.supabase.co",
  SUPABASE_KEY: "sb_publishable_NJqJWGru7KBCqA4TKh774A_TIJzay1F",

  // Wie viele Tage im Voraus Termine angezeigt werden
  DAYS_AHEAD: 35,
};
