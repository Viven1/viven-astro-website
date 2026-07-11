// Supabase Edge Function: booking-slots (PÚBLICA)
// Devuelve los horarios libres para agendar una call, leyendo el Google Calendar
// de Viven (free/busy). Reemplaza al meeting link de HubSpot.
//
// Deploy:   supabase functions deploy booking-slots --no-verify-jwt
// Secrets:  GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN  (OAuth de sofia@viven.ch)
//           GCAL_ID (opcional, default "primary")
//
// Reglas: Lu–Vi 09:00–17:30 (Europe/Zurich), grilla de 15 min, aviso mínimo 4 h,
// máximo 30 días hacia adelante.

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

export async function googleToken(): Promise<string> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: Deno.env.get("GOOGLE_CLIENT_ID")!,
      client_secret: Deno.env.get("GOOGLE_CLIENT_SECRET")!,
      refresh_token: Deno.env.get("GOOGLE_REFRESH_TOKEN")!,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) throw new Error("google_token " + res.status + " " + (await res.text()).slice(0, 200));
  return (await res.json()).access_token;
}

// hora local de Zúrich para un instante dado (sin libs)
const zurich = (d: Date) => {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Zurich", hour12: false, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(d);
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  return { wd: g("weekday"), h: parseInt(g("hour")), m: parseInt(g("minute")), ymd: `${g("year")}-${g("month")}-${g("day")}` };
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const u = new URL(req.url);
    const dur = Math.max(15, Math.min(60, parseInt(u.searchParams.get("dur") || "15")));
    const days = Math.max(1, Math.min(30, parseInt(u.searchParams.get("days") || "14")));
    const now = Date.now();
    const timeMin = new Date(now).toISOString();
    const timeMax = new Date(now + days * 864e5).toISOString();

    const token = await googleToken();
    const calId = Deno.env.get("GCAL_ID") || "primary";
    const fb = await fetch("https://www.googleapis.com/calendar/v3/freeBusy", {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({ timeMin, timeMax, timeZone: "UTC", items: [{ id: calId }] }),
    });
    if (!fb.ok) return json({ error: "freebusy " + fb.status + " " + (await fb.text()).slice(0, 200) }, 502);
    const busy: { start: string; end: string }[] = (await fb.json()).calendars?.[calId]?.busy ?? [];
    const isBusy = (s: number, e: number) => busy.some((b) => Date.parse(b.start) < e && Date.parse(b.end) > s);

    // grilla de 15 min: Lu–Vi 09:00–17:30 Zúrich, min. now + 4 h
    const minStart = now + 4 * 3600e3;
    const slots: string[] = [];
    for (let t = Math.ceil(minStart / 900e3) * 900e3; t < now + days * 864e5; t += 900e3) {
      const d = new Date(t);
      const z = zurich(d);
      if (["Sat", "Sun"].includes(z.wd)) continue;
      const mins = z.h * 60 + z.m;
      if (mins < 9 * 60 || mins + dur > 17 * 60 + 30) continue;
      if (isBusy(t, t + dur * 60e3)) continue;
      slots.push(d.toISOString());
      if (slots.length >= 400) break;
    }
    return json({ ok: true, dur, slots });
  } catch (e) {
    console.error("FUNCTION_ERROR", String(e));
    return json({ error: String(e) }, 500);
  }
});
