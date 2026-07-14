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
// Deploy:   supabase functions deploy gsc-stats --no-verify-jwt
// Secrets:  GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN
//           (el MISMO refresh token del booking, pero autorizado con DOS scopes:
//            calendar + webmasters.readonly). GSC_SITE opcional (default sc-domain:viven.ch).

import { createClient } from "jsr:@supabase/supabase-js@2";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const auth = req.headers.get("Authorization") ?? "";
    const supabase = createClient(SB_URL, SB_ANON, { global: { headers: { Authorization: auth } } });
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return json({ error: "unauthorized" }, 401);

    const { days = 28 } = await req.json().catch(() => ({}));
    const d = Math.max(7, Math.min(90, Number(days) || 28));
    const end = new Date(Date.now() - 2 * 864e5);         // GSC llega con ~2 días de lag
    // fix (auditoría 2026-07-14): startDate/endDate de GSC son AMBOS inclusive —
    // `end - d días` daba un período de d+1 días (start incluido de más), mientras
    // que el período anterior sí quedaba en d días exactos. Esa asimetría sesgaba
    // el delta ▲▼ sistemáticamente a favor de "mejoró" (~1/d, ~3.6% con d=28).
    const start = new Date(end.getTime() - (d - 1) * 864e5);
    const ymd = (x: Date) => x.toISOString().slice(0, 10);
    const token = await googleToken();
    // Propiedad: GSC_SITE si está seteado; si no, autodetectar entre las propiedades
    // verificadas de la cuenta (dominio > www > apex) — así nunca 403 por property equivocada.
    let site = Deno.env.get("GSC_SITE") || "";
    if (!site) {
      const sres = await fetch("https://searchconsole.googleapis.com/webmasters/v3/sites", { headers: { Authorization: "Bearer " + token } });
      const entries = sres.ok ? ((await sres.json()).siteEntry ?? []) : [];
      const ok = entries.filter((e: { permissionLevel?: string }) => e.permissionLevel !== "siteUnverifiedUser").map((e: { siteUrl: string }) => e.siteUrl);
      const pref = ["sc-domain:viven.ch", "https://www.viven.ch/", "https://viven.ch/"];
      site = pref.find((p) => ok.includes(p)) || ok[0] || "https://viven.ch/";
    }

    // período INMEDIATAMENTE ANTERIOR de igual longitud (para los deltas ▲▼)
    const prevEnd = new Date(start.getTime() - 864e5);
    const prevStart = new Date(prevEnd.getTime() - d * 864e5 + 864e5);

    const queryRange = async (s: Date, e: Date, dimensions: string[] | null, rowLimit = 15) => {
      const res = await fetch(`https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site)}/searchAnalytics/query`, {
        method: "POST",
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
        body: JSON.stringify({ startDate: ymd(s), endDate: ymd(e), ...(dimensions ? { dimensions } : {}), rowLimit }),
      });
      if (!res.ok) throw new Error("gsc " + res.status + " " + (await res.text()).slice(0, 200));
      return (await res.json()).rows ?? [];
    };
    const query = (dimensions: string[] | null, rowLimit = 15) => queryRange(start, end, dimensions, rowLimit);

    const [tot, prevTot, queries, pages, combos] = await Promise.all([
      query(null, 1),
      queryRange(prevStart, prevEnd, null, 1),
      query(["query"], 100),
      query(["page"], 100),
      query(["query", "page"], 500), // canibalización: agregada abajo
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

    const shape = (r: { keys?: string[]; clicks: number; impressions: number; ctr: number; position: number }) => {
      const key = r.keys?.[0] ?? "";
      return { key, clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position, page: topPageByQuery.get(key) || "" };
    };

    return json({
      ok: true, site, from: ymd(start), to: ymd(end), days: d,
      prevFrom: ymd(prevStart), prevTo: ymd(prevEnd),
      totals: { clicks: t.clicks, impressions: t.impressions, ctr: t.ctr, position: t.position },
      prevTotals: { clicks: pt.clicks, impressions: pt.impressions, ctr: pt.ctr, position: pt.position },
      queries: queries.map(shape), pages: pages.map(shape),
      cannibalization,
    });
  } catch (e) {
    console.error("FUNCTION_ERROR", String(e));
    return json({ error: String(e) }, 500);
  }
});
