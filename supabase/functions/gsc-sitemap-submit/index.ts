// Supabase Edge Function: gsc-sitemap-submit
// Re-envía sitemap.xml y video-sitemap.xml a Google Search Console vía API —
// el reemplazo del viejo ping de Google (muerto en 2023). Corre por cron diario
// (SQL 0031, NO se toca el cron): Google siempre sabe que hay contenido nuevo.
//
// Rediseño del sub-tab Search Console: esta misma corrida diaria ahora TAMBIÉN
// (1) deja constancia legible del propio resultado en public.gsc_status (id=1)
// — hoy el sitemap se reenvía a ciegas, nadie ve si funcionó; (2) hace un
// spot-check best-effort con la URL Inspection API de los 4 home por idioma
// (necesita el mismo scope webmasters completo que ya tiene esta función —
// si el spot-check falla por lo que sea, no tumba el resto, solo queda sin
// datos esa parte); (3) guarda un snapshot diario de las ~50 queries con más
// impresiones en public.gsc_daily, para poder dibujar tendencias por keyword
// sin volver a pegarle a la API de Google en cada vista del dashboard (hoy:
// cero historia, 3 llamadas en vivo por vista). Todo best-effort: si algo de
// esto falla, el resubmit de sitemaps (la parte de siempre) sigue igual.
//
// Deploy:   supabase functions deploy gsc-sitemap-submit --no-verify-jwt
// Requiere: GOOGLE_REFRESH_TOKEN autorizado con scope webmasters COMPLETO
//           (https://www.googleapis.com/auth/webmasters — no el .readonly).
// Cron:     SQL 0031 (diario ~07:10 UTC / 09:10 Zürich)

import { createClient } from "jsr:@supabase/supabase-js@2";

const service = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
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
    const token = await googleToken();
    // propiedad: GSC_SITE o autodetección (dominio > www > apex), igual que gsc-stats
    let site = Deno.env.get("GSC_SITE") || "";
    if (!site) {
      const sres = await fetch("https://searchconsole.googleapis.com/webmasters/v3/sites", { headers: { Authorization: "Bearer " + token } });
      const entries = sres.ok ? ((await sres.json()).siteEntry ?? []) : [];
      const ok = entries.filter((e: { permissionLevel?: string }) => e.permissionLevel !== "siteUnverifiedUser").map((e: { siteUrl: string }) => e.siteUrl);
      const pref = ["sc-domain:viven.ch", "https://www.viven.ch/", "https://viven.ch/"];
      site = pref.find((p) => ok.includes(p)) || ok[0] || "https://viven.ch/";
    }
    // el feedpath debe vivir BAJO la propiedad (cross-host = 403): con propiedad
    // url-prefix usamos su mismo prefijo; con dominio (sc-domain) usamos www.
    const prefix = site.startsWith("sc-domain:") ? "https://www.viven.ch/" : site;
    const feeds = [prefix + "sitemap.xml", prefix + "video-sitemap.xml"];
    const results: Record<string, number> = {};
    for (const f of feeds) {
      const r = await fetch(`https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site)}/sitemaps/${encodeURIComponent(f)}`, {
        method: "PUT",
        headers: { Authorization: "Bearer " + token },
      });
      results[f] = r.status;   // 200/204 = resubmitted; 403 = falta el scope webmasters completo
    }

    // --- desde acá: todo best-effort, nunca tumba el resubmit de arriba ---

    // (1) constancia del resubmit en gsc_status
    try {
      await service.from("gsc_status").upsert({
        id: 1, last_sitemap_at: new Date().toISOString(), last_sitemap_results: results, updated_at: new Date().toISOString(),
      });
    } catch (e) { console.error("gsc_status sitemap write failed", String(e)); }

    // (2) spot-check con URL Inspection API — los 4 home por idioma alcanzan
    // para saber si Google sigue indexando sin adivinar slugs de contenido.
    try {
      const keyUrls = [prefix, prefix + "en/", prefix + "de/", prefix + "es/"];
      const checks: { url: string; verdict: string; coverageState: string | null }[] = [];
      for (const u of keyUrls) {
        const r = await fetch("https://searchconsole.googleapis.com/v1/urlInspection/index:inspect", {
          method: "POST",
          headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
          body: JSON.stringify({ inspectionUrl: u, siteUrl: site }),
        });
        if (!r.ok) { checks.push({ url: u, verdict: "HTTP_" + r.status, coverageState: null }); continue; }
        const data = await r.json();
        const idx = data?.inspectionResult?.indexStatusResult || {};
        checks.push({ url: u, verdict: idx.verdict || "UNKNOWN", coverageState: idx.coverageState || null });
      }
      await service.from("gsc_status").upsert({
        id: 1, last_urlcheck_at: new Date().toISOString(), last_urlcheck_results: checks, updated_at: new Date().toISOString(),
      });
    } catch (e) { console.error("gsc_status urlcheck failed", String(e)); }

    // (3) snapshot diario de las ~50 queries con más impresiones → gsc_daily
    try {
      const end = new Date(Date.now() - 2 * 864e5); // mismo lag de ~2 días que gsc-stats
      const ymd = end.toISOString().slice(0, 10);
      const qres = await fetch(`https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site)}/searchAnalytics/query`, {
        method: "POST",
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
        body: JSON.stringify({ startDate: ymd, endDate: ymd, dimensions: ["query"], rowLimit: 50 }),
      });
      if (qres.ok) {
        const rows = ((await qres.json()).rows ?? []) as { keys: string[]; clicks: number; impressions: number; position: number }[];
        if (rows.length) {
          const daily = rows.map((r) => ({ date: ymd, query: r.keys[0], clicks: r.clicks, impressions: r.impressions, position: r.position, updated_at: new Date().toISOString() }));
          const { error } = await service.from("gsc_daily").upsert(daily, { onConflict: "date,query" });
          if (error) console.error("gsc_daily upsert failed", error.message);
        }
      }
    } catch (e) { console.error("gsc_daily snapshot failed", String(e)); }

    return json({ ok: true, site, results });
  } catch (e) {
    console.error("FUNCTION_ERROR", String(e));
    return json({ error: String(e) }, 500);
  }
});
