// Supabase Edge Function: gsc-stats
// Lee Google Search Console (Search Analytics) para el sub-tab Search Console
// del dashboard: totales + top búsquedas + top páginas de los últimos N días.
//
// Rediseño (ver mockup aprobado): además de lo de siempre, ahora también trae
// (1) los totales del período INMEDIATAMENTE ANTERIOR de igual longitud, para
// los deltas ▲▼ de los 4 KPIs (el único lugar de Analytics que no los tenía);
// (2) top búsquedas/páginas con rowLimit 100 en vez de 15 (tablas ordenables,
// ya no fijas a 15 filas — la oportunidad de CTR se calcula en el navegador
// con esas mismas 100 filas, sin IA ni llamada extra); (3) una consulta con
// dimensión combinada query×página (top 500 combinaciones del período) para
// detectar canibalización — 2+ páginas propias peleando la misma búsqueda —,
// agregada acá mismo para no mandarle 500 filas crudas al navegador.
//
// SEO pack (2026-07-27):
// (4) `days` ahora acepta 7–180 (antes tope 90) — el sub-tab tiene selector
//     7/28/90/180 con comparación contra el período anterior de IGUAL longitud
//     (2×180 = 360 días, cómodo dentro de los ~16 meses que guarda GSC).
//     OJO: el fix del off-by-one (auditoría 2026-07-14) se mantiene tal cual.
// (5) `prevPages`: top páginas del período anterior — para los deltas ▲▼ por
//     página del panel "📈 Top páginas".
// (6) {snapshot:true}: guarda en public.gsc_page_history (SQL 0116) un
//     snapshot por página de los últimos 7 días (clicks/impresiones/posición/
//     CTR) — lo dispara el cron 'viven-gsc-snapshot' (lunes 07:15 UTC) con
//     Authorization: Bearer CRON_SECRET (patrón vault 'cron_secret' de 0113).
//
// Deploy:   supabase functions deploy gsc-stats --no-verify-jwt
// Secrets:  GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN
//           (el MISMO refresh token del booking, pero autorizado con DOS scopes:
//            calendar + webmasters.readonly). GSC_SITE opcional (default sc-domain:viven.ch).
//           CRON_SECRET (ya seteado — mismo de los otros crons).

import { createClient } from "jsr:@supabase/supabase-js@2";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const ymd = (x: Date) => x.toISOString().slice(0, 10);

async function googleToken(): Promise<string> {
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
  if (!res.ok) throw new Error("google_token " + res.status + " " + (await res.text()).slice(0, 160));
  return (await res.json()).access_token;
}

// Propiedad: GSC_SITE si está seteado; si no, autodetectar entre las propiedades
// verificadas de la cuenta (dominio > www > apex) — así nunca 403 por property equivocada.
async function detectSite(token: string): Promise<string> {
  const fromEnv = Deno.env.get("GSC_SITE") || "";
  if (fromEnv) return fromEnv;
  const sres = await fetch("https://searchconsole.googleapis.com/webmasters/v3/sites", { headers: { Authorization: "Bearer " + token } });
  const entries = sres.ok ? ((await sres.json()).siteEntry ?? []) : [];
  const ok = entries.filter((e: { permissionLevel?: string }) => e.permissionLevel !== "siteUnverifiedUser").map((e: { siteUrl: string }) => e.siteUrl);
  const pref = ["sc-domain:viven.ch", "https://www.viven.ch/", "https://viven.ch/"];
  return pref.find((p) => ok.includes(p)) || ok[0] || "https://viven.ch/";
}

type GscRow = { keys?: string[]; clicks: number; impressions: number; ctr: number; position: number };

/* `pais` filtra por país (ISO-3 en minúscula: "che" = Suiza).
   Sin filtro, la POSICIÓN QUE DEVUELVE GOOGLE ES UN PROMEDIO MUNDIAL, y eso engaña con
   cara de dato: el 2 sep 2026 la tabla decía «corporate film production switzerland,
   posición 1,9» y Sebastián miró el buscador de verdad — no estaba ni en los diez
   primeros; aparecía solo en el pack de empresas. Los dos números pueden ser ciertos a la
   vez, porque promedian países distintos.
   Para una productora de Zúrich el único promedio que decide es el suizo. */
async function gscQuery(token: string, site: string, s: Date, e: Date, dimensions: string[] | null, rowLimit = 15, pais?: string): Promise<GscRow[]> {
  const res = await fetch(`https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site)}/searchAnalytics/query`, {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ startDate: ymd(s), endDate: ymd(e), ...(dimensions ? { dimensions } : {}), rowLimit,
      ...(pais ? { dimensionFilterGroups: [{ filters: [{ dimension: "country", operator: "equals", expression: pais }] }] } : {}) }),
  });
  if (!res.ok) throw new Error("gsc " + res.status + " " + (await res.text()).slice(0, 200));
  return (await res.json()).rows ?? [];
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const auth = req.headers.get("Authorization") ?? "";
    // service-role bypass (mismo patrón que push-send): permite acciones
    // server-to-server como submit_sitemap sin sesión de dashboard.
    const isService = auth === "Bearer " + (Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "");
    // cron bypass (mismo patrón que reactivation-engine): el cron del snapshot
    // semanal (SQL 0116) llama con Bearer CRON_SECRET resuelto desde el vault.
    const isCron = !!CRON_SECRET && auth === "Bearer " + CRON_SECRET;
    if (!isService && !isCron) {
      const supabase = createClient(SB_URL, SB_ANON, { global: { headers: { Authorization: auth } } });
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return json({ error: "unauthorized" }, 401);
    }

    const body0 = await req.json().catch(() => ({}));
    // Registrar el sitemap en Search Console vía API (una vez tras migrar a
    // sitemap-index.xml, o cuando haga falta re-avisar). Requiere que el
    // refresh token tenga el scope webmasters completo — si es readonly,
    // Google responde 403 y lo reportamos tal cual.
    if (body0.submit_sitemap) {
      const token = await googleToken();
      const site = await detectSite(token);
      const feed = String(body0.submit_sitemap) === "true" || body0.submit_sitemap === true ? "https://www.viven.ch/sitemap-index.xml" : String(body0.submit_sitemap);
      const sub = await fetch(`https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site)}/sitemaps/${encodeURIComponent(feed)}`, {
        method: "PUT", headers: { Authorization: "Bearer " + token },
      });
      return json({ ok: sub.ok, status: sub.status, site, feed, detail: sub.ok ? "submitted" : (await sub.text()).slice(0, 300) });
    }

    // 📸 Snapshot semanal a gsc_page_history (SQL 0116): clicks/impresiones/
    // posición/CTR por página de los últimos 7 días. Idempotente por (page,date)
    // — reintentar el mismo día solo pisa con datos frescos, nunca duplica.
    if (body0.snapshot) {
      const token = await googleToken();
      const site = await detectSite(token);
      const end = new Date(Date.now() - 2 * 864e5);          // mismo lag de ~2 días de GSC
      const start = new Date(end.getTime() - 6 * 864e5);     // 7 días inclusive (ambos bordes)
      const rows = await gscQuery(token, site, start, end, ["page"], 100);
      const date = ymd(end);
      const recs = rows
        .map((r) => ({ page: r.keys?.[0] ?? "", date, clicks: r.clicks || 0, impressions: r.impressions || 0, position: r.position ?? null, ctr: r.ctr ?? null }))
        .filter((r) => r.page);
      if (recs.length) {
        const svc = createClient(SB_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
        const { error } = await svc.from("gsc_page_history").upsert(recs, { onConflict: "page,date" });
        if (error) return json({ error: "gsc_page_history: " + error.message + " — ¿corriste el SQL 0116?" }, 500);
      }
      return json({ ok: true, snapshot: true, site, date, from: ymd(start), to: ymd(end), saved: recs.length });
    }
    if (isService || isCron) return json({ error: "solo submit_sitemap / snapshot disponibles sin sesión de dashboard" }, 400);

    const { days = 28 } = body0;
    // 7–180 días (selector del sub-tab). Con comparación de igual longitud son
    // hasta 360 días hacia atrás — dentro de los ~16 meses que retiene GSC.
    const d = Math.max(7, Math.min(180, Number(days) || 28));
    const end = new Date(Date.now() - 2 * 864e5);         // GSC llega con ~2 días de lag
    // fix (auditoría 2026-07-14): startDate/endDate de GSC son AMBOS inclusive —
    // `end - d días` daba un período de d+1 días (start incluido de más), mientras
    // que el período anterior sí quedaba en d días exactos. Esa asimetría sesgaba
    // el delta ▲▼ sistemáticamente a favor de "mejoró" (~1/d, ~3.6% con d=28).
    const start = new Date(end.getTime() - (d - 1) * 864e5);
    const token = await googleToken();
    const site = await detectSite(token);

    // período INMEDIATAMENTE ANTERIOR de igual longitud (para los deltas ▲▼)
    const prevEnd = new Date(start.getTime() - 864e5);
    const prevStart = new Date(prevEnd.getTime() - d * 864e5 + 864e5);

    const query = (dimensions: string[] | null, rowLimit = 15) => gscQuery(token, site, start, end, dimensions, rowLimit);

    const [tot, prevTot, queries, pages, prevPages, combos, queriesCH, combosCH] = await Promise.all([
      query(null, 1),
      gscQuery(token, site, prevStart, prevEnd, null, 1),
      query(["query"], 100),
      query(["page"], 100),
      gscQuery(token, site, prevStart, prevEnd, ["page"], 100), // deltas por página (📈 Top páginas)
      query(["query", "page"], 500), // canibalización: agregada abajo
      /* La misma foto, solo Suiza. Es la que vale para decidir: un promedio mundial mezcla
         países donde no vendemos y esconde dónde estamos de verdad frente a la competencia
         local. */
      gscQuery(token, site, start, end, ["query"], 100, "che"),
      gscQuery(token, site, start, end, ["query", "page"], 300, "che"),
    ]);
    const t = tot[0] ?? { clicks: 0, impressions: 0, ctr: 0, position: 0 };
    const pt = prevTot[0] ?? { clicks: 0, impressions: 0, ctr: 0, position: 0 };

    // canibalización + página dominante por query: agrupar los combos query×página.
    // La página dominante (más impresiones) se le pega a cada fila de `queries` más
    // abajo — así la tabla de oportunidades de CTR puede linkear a la página real
    // sin una llamada extra a Google.
    const byQuery = new Map<string, { page: string; clicks: number; impressions: number; position: number }[]>();
    for (const r of combos as { keys: string[]; clicks: number; impressions: number; position: number }[]) {
      const [q, p] = r.keys;
      if (!byQuery.has(q)) byQuery.set(q, []);
      byQuery.get(q)!.push({ page: p, clicks: r.clicks, impressions: r.impressions, position: r.position });
    }
    const topPageByQuery = new Map<string, string>();
    for (const [q, pgs] of byQuery) {
      const best = pgs.slice().sort((a, b) => b.impressions - a.impressions)[0];
      if (best) topPageByQuery.set(q, best.page);
    }
    const cannibalization = [...byQuery.entries()]
      .map(([q, pgs]) => ({ query: q, pages: pgs.filter((p) => p.impressions >= 5).sort((a, b) => b.impressions - a.impressions) }))
      .filter((c) => c.pages.length >= 2)
      .map((c) => ({ ...c, totalImpressions: c.pages.reduce((a, p) => a + p.impressions, 0) }))
      .sort((a, b) => b.totalImpressions - a.totalImpressions)
      .slice(0, 15);

    const shape = (r: GscRow) => {
      const key = r.keys?.[0] ?? "";
      return { key, clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position, page: topPageByQuery.get(key) || "" };
    };
    /* La página dominante suiza puede no ser la misma que la mundial: por eso su propio mapa. */
    const pageCH = new Map<string, { page: string; impressions: number }>();
    for (const r of combosCH as { keys: string[]; impressions: number }[]) {
      const [q, p] = r.keys;
      const prev = pageCH.get(q);
      if (!prev || r.impressions > prev.impressions) pageCH.set(q, { page: p, impressions: r.impressions });
    }
    const shapeCH = (r: GscRow) => {
      const key = r.keys?.[0] ?? "";
      return { key, clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position,
               page: pageCH.get(key)?.page || "" };
    };

    return json({
      ok: true, site, from: ymd(start), to: ymd(end), days: d,
      prevFrom: ymd(prevStart), prevTo: ymd(prevEnd),
      totals: { clicks: t.clicks, impressions: t.impressions, ctr: t.ctr, position: t.position },
      prevTotals: { clicks: pt.clicks, impressions: pt.impressions, ctr: pt.ctr, position: pt.position },
      queries: queries.map(shape), pages: pages.map(shape), prevPages: prevPages.map(shape),
      cannibalization,
      /* La misma lista, solo Suiza, con SU página dominante. Que vayan las dos permite ver
         la brecha: una búsqueda puede estar 2ª en el promedio mundial y fuera de los diez
         primeros acá, y hasta hoy eso no se podía distinguir. */
      queriesCH: queriesCH.map(shapeCH),
    });
  } catch (e) {
    console.error("FUNCTION_ERROR", String(e));
    return json({ error: String(e) }, 500);
  }
});
