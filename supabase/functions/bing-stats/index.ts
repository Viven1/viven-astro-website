// Supabase Edge Function: bing-stats
// Trae las consultas de búsqueda de Bing y las guarda en public.bing_daily,
// para que el dashboard muestre Bing al lado de Google en la misma pantalla.
//
// POR QUÉ: hasta el 24 ago 2026 solo mirábamos Google Search Console. Bing
// tiene datos reales de viven.ch — 2.064 consultas la primera vez que medimos —
// y un buscador puede estar subiendo mientras el otro no se mueve. Eso solo se
// ve comparando, y hasta ahora había que entrar a otra herramienta.
//
// LA TRAMPA DEL DATO: Bing devuelve la MISMA consulta repetida, una fila por
// fecha, y la fecha viene como "/Date(1755734400000)/" (milisegundos). La
// primera versión de esto ignoraba la fecha y guardaba el total como si fuera
// de hoy: 469 días de Bing contra 41 de Google, que hacía ver a Bing diez veces
// mejor de lo que es. Se guarda por (fecha, consulta), igual que gsc_daily, y
// así los dos buscadores se comparan sobre el mismo período.
//
// Deploy:   supabase functions deploy bing-stats --no-verify-jwt
// Secrets:  BING_API_KEY (de Bing Webmaster Tools → Settings → API access)
//           CRON_SECRET (el mismo de los otros crons)
// SQL:      supabase/migrations/0133_bing_stats.sql

import { createClient } from "jsr:@supabase/supabase-js@2";

const service = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";
const BING_API_KEY = Deno.env.get("BING_API_KEY") ?? "";
const SITIO = Deno.env.get("BING_SITE") ?? "https://viven.ch/";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const token = (req.headers.get("Authorization") || "").replace("Bearer ", "").trim();
  if (!CRON_SECRET || token !== CRON_SECRET) return json({ error: "no autorizado" }, 401);
  if (!BING_API_KEY) return json({ error: "FALTA_BING_API_KEY" }, 500);

  const url = `https://ssl.bing.com/webmaster/api.svc/json/GetQueryStats?siteUrl=${encodeURIComponent(SITIO)}&apikey=${BING_API_KEY}`;
  const r = await fetch(url);
  if (!r.ok) return json({ error: "BING_FALLO", status: r.status, cuerpo: (await r.text()).slice(0, 300) }, 502);

  const cuerpo = await r.json().catch(() => null);
  const filas = Array.isArray(cuerpo?.d) ? cuerpo.d : [];
  if (!filas.length) return json({ ok: true, consultas: 0, nota: "Bing no devolvió consultas" });

  // "/Date(1755734400000)/" → 2025-08-21
  const aFecha = (v: unknown) => {
    const m = /\/Date\((\d+)/.exec(String(v ?? ""));
    return m ? new Date(Number(m[1])).toISOString().slice(0, 10) : null;
  };

  const juntas = new Map<string, { date: string; query: string; clicks: number; impressions: number; pos: number[] }>();
  let sinFecha = 0;
  for (const f of filas) {
    const q = String(f?.Query ?? "").trim();
    const fecha = aFecha(f?.Date);
    if (!q) continue;
    if (!fecha) { sinFecha++; continue; }   // sin fecha no entra: inventarla arruina la comparación
    const k = fecha + "|" + q;
    const a = juntas.get(k) ?? { date: fecha, query: q, clicks: 0, impressions: 0, pos: [] };
    a.clicks += Number(f?.Clicks ?? 0);
    a.impressions += Number(f?.Impressions ?? 0);
    const p = Number(f?.AvgImpressionPosition ?? 0);
    if (p > 0) a.pos.push(p);
    juntas.set(k, a);
  }

  const registros = [...juntas.values()].map((a) => ({
    date: a.date,
    query: a.query,
    clicks: a.clicks,
    impressions: a.impressions,
    position: a.pos.length ? Number((a.pos.reduce((s, x) => s + x, 0) / a.pos.length).toFixed(1)) : null,
  }));

  const { error } = await service.from("bing_daily").upsert(registros, { onConflict: "date,query" });
  if (error) return json({ error: "NO_GUARDO", detalle: error.message }, 500);

  const fechas = registros.map((r) => r.date).sort();
  return json({
    ok: true,
    filas: registros.length,
    desde: fechas[0] ?? null,
    hasta: fechas[fechas.length - 1] ?? null,
    descartadas_sin_fecha: sinFecha,
    impresiones: registros.reduce((s, x) => s + x.impressions, 0),
    clicks: registros.reduce((s, x) => s + x.clicks, 0),
  });
});
