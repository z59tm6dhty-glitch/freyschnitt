(function () {
  "use strict";
  let b = null;
  try {
    b = JSON.parse(sessionStorage.getItem("frey_booking") || "null");
    sessionStorage.removeItem("frey_booking");
  } catch (e) { /* ignorieren */ }
  if (!b || !b.starts_at) return;

  const TZ = "Europe/Berlin";
  const day = new Intl.DateTimeFormat("de-DE", { timeZone: TZ, weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const time = new Intl.DateTimeFormat("de-DE", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
  const s = new Date(b.starts_at), e = new Date(b.ends_at);

  document.getElementById("when").textContent = "→ " + day.format(s) + " · " + time.format(s) + "–" + time.format(e);
  if (b.service) document.getElementById("details").textContent = "Leistung: " + b.service;
  if (b.email) document.getElementById("mailnote").textContent =
    "Die Bestätigung geht an " + b.email + ". Schau auch im Spam-Ordner nach, falls sie nicht ankommt.";
})();
