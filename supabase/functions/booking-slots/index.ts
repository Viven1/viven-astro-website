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

export async function googleToken(refreshToken?: string): Promise<string> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: Deno.env.get("GOOGLE_CLIENT_ID")!,
      client_secret: Deno.env.get("GOOGLE_CLIENT_SECRET")!,
      refresh_token: refreshToken || Deno.env.get("GOOGLE_REFRESH_TOKEN")!,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) throw new Error("google_token " + res.status + " " + (await res.text()).slice(0, 200));
  return (await res.json()).access_token;
}

// Google por host: cada persona con SU propia cuenta conectada (refresh token dedicado).
// Si el host tiene su secret → usa su token + su calendario "primary". Si no → FALLBACK al
// par compartido de siempre (GOOGLE_REFRESH_TOKEN/GCAL_ID) — así deployar esto NO rompe nada
// aunque falten secrets, y el /book/ default (sin host) sigue igual.
export function hostGoogle(hostEmail: string): { refresh?: string; calId: string } {
  const SECRET: Record<string, string> = {
    "sofia@viven.ch": "GOOGLE_REFRESH_TOKEN_SOFIA",
    "sebastian@viven.ch": "GOOGLE_REFRESH_TOKEN_SEBASTIAN",
  };
  const key = SECRET[(hostEmail || "").toLowerCase()];
  const dedicated = key ? Deno.env.get(key) : undefined;
  if (dedicated) return { refresh: dedicated, calId: "primary" };                    // su propia agenda
  return { refresh: Deno.env.get("GOOGLE_REFRESH_TOKEN"), calId: Deno.env.get("GCAL_ID") || "primary" };
}

// hora local de Zúrich para un instante dado (sin libs)
const zurich = (d: Date) => {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Zurich", hour12: false, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(d);
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  return { wd: g("weekday"), h: parseInt(g("hour")), m: parseInt(g("minute")), ymd: `${g("year")}-${g("month")}-${g("day")}` };
};

import { createClient } from "jsr:@supabase/supabase-js@2";
const service = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const DEFAULTS = { active: true, work_start: 540, work_end: 1050, days: [1, 2, 3, 4, 5], notice_hours: 4, horizon_days: 28, buffer_min: 0, durations: [15, 30], host_name: "Sebastian Cepeda", host_role: "Founder — Viven AG, Zürich", msg_en: null, msg_de: null, msg_es: null };
export async function bookingSettings() {
  try { const { data } = await service.from("booking_settings").select("*").eq("id", 1).maybeSingle(); return { ...DEFAULTS, ...(data || {}) }; }
  catch (_e) { return DEFAULTS; }
}

// slug = primera palabra del nombre, minúsculas, sin acentos ("Sofía Treviño" → sofia).
// Debe coincidir con el backfill de la migración 0080 y con el front (/book/[persona]).
export function slugify(name: string): string {
  return String(name || "").trim().split(/\s+/)[0].normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

// Resuelve un host (slug o email) a su fila de settings + identidad visible.
// Sin host, o host no resoluble → EXACTO comportamiento actual (fila id=1 default).
export async function resolveHost(spec: string): Promise<{ cfg: typeof DEFAULTS; host: { name: string; role: string; email: string | null } }> {
  const def = await bookingSettings();
  const fallback = { cfg: def, host: { name: String(def.host_name), role: String(def.host_role), email: null as string | null } };
  if (!spec) return fallback;
  try {
    const { data: profs } = await service.from("team_profiles").select("email,name,role,slug");
    const low = spec.toLowerCase();
    const tp = (profs || []).find((p) =>
      spec.includes("@") ? String(p.email || "").toLowerCase() === low : (p.slug || slugify(p.name)) === low);
    if (!tp) return fallback;
    const email = String(tp.email || "").toLowerCase();
    let cfg = def;
    const { data: bs } = await service.from("booking_settings").select("*").eq("email", email).maybeSingle();
    if (bs) cfg = { ...DEFAULTS, ...bs };
    return { cfg, host: { name: String(tp.name || def.host_name), role: String(tp.role || def.host_role), email } };
  } catch (_e) { return fallback; }
}

// ?hosts=1 → lista de hosts visibles (team_profiles.book_visible) con sus duraciones
// y horario (de su fila de booking_settings; fallback al default id=1). Powers el selector.
async function listHosts(): Promise<Response> {
  try {
    const def = await bookingSettings();
    const { data: profs } = await service.from("team_profiles").select("email,name,role,avatar_url,slug").eq("book_visible", true);
    const { data: allBs } = await service.from("booking_settings").select("email,durations,work_start,work_end,days");
    const byEmail = new Map<string, Record<string, unknown>>();
    for (const s of allBs || []) if (s.email) byEmail.set(String(s.email).toLowerCase(), s);
    const hosts = (profs || []).filter((p) => p.name).map((p) => {
      const email = String(p.email || "").toLowerCase();
      const bs = byEmail.get(email) || {};
      return {
        slug: p.slug || slugify(p.name),
        email,
        name: p.name,
        role: p.role || null,
        avatar_url: p.avatar_url || null,
        durations: Array.isArray(bs.durations) && (bs.durations as unknown[]).length ? bs.durations : def.durations,
        work_start: bs.work_start ?? def.work_start,
        work_end: bs.work_end ?? def.work_end,
        days: Array.isArray(bs.days) && (bs.days as unknown[]).length ? bs.days : def.days,
      };
    });
    // Orden (pedido del dueño): Sofia SIEMPRE primero, el resto por nombre.
    // Robusto: se ancla por slug 'sofia' o email sofia@…; si no existe, queda el orden por nombre.
    const first = (h: { slug: string; email: string }) => (h.slug === "sofia" || h.email.startsWith("sofia@")) ? 0 : 1;
    hosts.sort((a, b) => first(a) - first(b) || String(a.name).localeCompare(String(b.name)));
    return json({ ok: true, hosts });
  } catch (e) {
    return json({ ok: false, error: String(e), hosts: [] });
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const u = new URL(req.url);
    // MODO selector: ?hosts=1 → lista de hosts visibles (sin tocar Google Calendar).
    if (u.searchParams.get("hosts") === "1") return await listHosts();
    // Host opcional (slug o email): usa SU fila de settings + identidad. Sin host → default id=1.
    const { cfg, host } = await resolveHost((u.searchParams.get("host") || "").trim());
    const meta = { host: { name: host.name, role: host.role }, durations: cfg.durations, msgs: { en: cfg.msg_en, de: cfg.msg_de, es: cfg.msg_es } };
    if (!cfg.active) return json({ ok: false, error: "booking_off", meta });
    const dur = cfg.durations.includes(parseInt(u.searchParams.get("dur") || "0")) ? parseInt(u.searchParams.get("dur")!) : cfg.durations[0];
    const days = Math.max(1, Math.min(60, parseInt(u.searchParams.get("days") || String(cfg.horizon_days))));
    const now = Date.now();
    const timeMin = new Date(now).toISOString();
    const timeMax = new Date(now + days * 864e5).toISOString();

    // free/busy contra el calendario DEL HOST (su token+agenda si tiene secret; si no, el compartido)
    const { refresh, calId } = hostGoogle(host.email || "");
    const token = await googleToken(refresh);
    const fb = await fetch("https://www.googleapis.com/calendar/v3/freeBusy", {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({ timeMin, timeMax, timeZone: "UTC", items: [{ id: calId }] }),
    });
    if (!fb.ok) return json({ error: "freebusy " + fb.status + " " + (await fb.text()).slice(0, 200) }, 502);
    const busy: { start: string; end: string }[] = (await fb.json()).calendars?.[calId]?.busy ?? [];
    const isBusy = (s: number, e: number) => busy.some((b) => Date.parse(b.start) < e && Date.parse(b.end) > s);

    // grilla según SETTINGS (hora Zúrich, días ISO, aviso mínimo, buffer)
    // all=1 → devuelve TODA la grilla con {t, free} (la página muestra los ocupados en gris)
    const all = u.searchParams.get("all") === "1";
    const ISO: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
    const minStart = now + cfg.notice_hours * 3600e3;
    const buf = (cfg.buffer_min || 0) * 60e3;
    const step = dur >= 30 ? 30 : 15;                 // grilla cada 30 para calls de 30+
    const slots: string[] = [];
    const grid: { t: string; free: boolean }[] = [];
    for (let t = Math.ceil(minStart / 900e3) * 900e3; t < now + days * 864e5; t += 900e3) {
      const d = new Date(t);
      const z = zurich(d);
      if (!cfg.days.includes(ISO[z.wd])) continue;
      const mins = z.h * 60 + z.m;
      if (mins < cfg.work_start || mins + dur > cfg.work_end) continue;
      if (mins % step !== 0) continue;
      const free = !isBusy(t - buf, t + dur * 60e3 + buf);
      if (all) { grid.push({ t: d.toISOString(), free }); if (grid.length >= 1500) break; }
      else if (free) { slots.push(d.toISOString()); if (slots.length >= 400) break; }
    }
    return json(all ? { ok: true, dur, grid, meta } : { ok: true, dur, slots, meta });
  } catch (e) {
    console.error("FUNCTION_ERROR", String(e));
    return json({ error: String(e) }, 500);
  }
});
