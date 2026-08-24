// Supabase Edge Function: site-health-check
// 🩺 Chequea que NUESTRO PROPIO sitemap nunca tenga una URL rota — la causa
// raíz de la mayoría de los 404 reales que encontramos en Search Console el
// 2026-07-26 (posts/preguntas viejas de HubSpot sin redirect, apex-domain sin
// www) sin que nadie lo hubiera notado. Google no expone por API qué está
// indexado o no (Coverage es solo UI, exportable a mano) — esto es lo único
// que SÍ podemos controlar 100% nosotros, corriendo el chequeo nosotros mismos.
//
// (1) Lee sitemap-index.xml, sigue cada sub-sitemap, junta todas las <loc>.
// (2) Chequea cada URL en batches concurrentes (HEAD, redirect:'manual';
//     si HEAD falla probamos GET — algunos hosts/CDNs no responden bien a
//     HEAD) y clasifica: ok (200 directo) / redirect (3xx — el sitemap
//     debería apuntar SIEMPRE a la URL canónica, un 3xx acá es señal de
//     sitemap desactualizado) / broken (404/5xx o error de red).
// (3) Guarda la corrida en site_health_runs (SQL 0117) y compara contra la
//     corrida anterior: si aparecen URLs rotas NUEVAS (que no estaban rotas
//     la vez pasada), dispara un push. Si no hay novedad (0 rotas, o el mismo
//     set ya conocido) no manda nada — nada de ruido semana a semana con lo
//     mismo.
//
// Deploy:   supabase functions deploy site-health-check --no-verify-jwt
// Schedule: SQL 0117 (cron lunes 09:30 UTC, vault cron_secret)
// Probar:   curl -X POST .../functions/v1/site-health-check \
//             -H "Authorization: Bearer $CRON_SECRET"
//           (siempre corre entero y guarda la fila — no tiene dry_run: leer
//           470 HEAD requests no cuesta nada ni escribe nada fuera de esta
//           tabla, así que no hace falta separar "probar" de "correr")

import { createClient } from "jsr:@supabase/supabase-js@2";

const service = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

const SITEMAP_INDEX = "https://www.viven.ch/sitemap-index.xml";
const BATCH_SIZE = 18;          // ~18 fetches concurrentes a la vez, no 470 de golpe
const FETCH_TIMEOUT_MS = 12000;

type Verdict = { url: string; status: "ok" | "redirect" | "broken"; code: number; location?: string };

function extractLocs(xml: string): string[] {
  const out: string[] = [];
  const re = /<loc>\s*([^<\s][^<]*?)\s*<\/loc>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) out.push(m[1].trim());
  return out;
}

async function fetchWithTimeout(url: string, opts: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

// baja el sitemap-index, sigue cada sub-sitemap listado y junta todas las <loc>
// de páginas reales (no cuenta las <loc> del propio index como páginas).
async function collectSitemapUrls(): Promise<string[]> {
  const idxRes = await fetchWithTimeout(SITEMAP_INDEX, { method: "GET" });
  if (!idxRes.ok) throw new Error(`sitemap-index.xml HTTP ${idxRes.status}`);
  const idxXml = await idxRes.text();
  const subSitemaps = extractLocs(idxXml);
  // el índice puede en teoría ser directamente un urlset (sin sub-sitemaps) —
  // si no encontramos <sitemap><loc> pero sí hay <url><loc>, usamos el index tal cual
  const isUrlset = /<urlset[\s>]/i.test(idxXml);
  const targets = subSitemaps.length ? subSitemaps : (isUrlset ? [SITEMAP_INDEX] : []);
  if (!targets.length) throw new Error("sitemap-index.xml sin sub-sitemaps ni URLs");

  const urls: string[] = [];
  for (const sm of targets) {
    if (sm === SITEMAP_INDEX && isUrlset) { urls.push(...extractLocs(idxXml)); continue; }
    try {
      const r = await fetchWithTimeout(sm, { method: "GET" });
      if (!r.ok) { console.error("SUBSITEMAP_FETCH_FAIL", sm, r.status); continue; }
      const xml = await r.text();
      urls.push(...extractLocs(xml));
    } catch (e) { console.error("SUBSITEMAP_FETCH_ERROR", sm, String(e)); }
  }
  return [...new Set(urls)];
}

async function checkOne(url: string): Promise<Verdict> {
  const classify = (code: number, location: string | null): Verdict => {
    if (code >= 200 && code < 300) return { url, status: "ok", code };
    if (code >= 300 && code < 400) return { url, status: "redirect", code, location: location || undefined };
    return { url, status: "broken", code };
  };
  try {
    const r = await fetchWithTimeout(url, { method: "HEAD", redirect: "manual" });
    // algunos hosts/CDNs no implementan bien HEAD (405 Method Not Allowed, 501) — reintentamos con GET
    if (r.status === 405 || r.status === 501) {
      const g = await fetchWithTimeout(url, { method: "GET", redirect: "manual" });
      return classify(g.status, g.headers.get("location"));
    }
    return classify(r.status, r.headers.get("location"));
  } catch (e1) {
    // red inestable con HEAD: un segundo intento con GET antes de declarar rota
    try {
      const g = await fetchWithTimeout(url, { method: "GET", redirect: "manual" });
      return classify(g.status, g.headers.get("location"));
    } catch (e2) {
      return { url, status: "broken", code: 0 };
    }
  }
}

async function checkAll(urls: string[]): Promise<Verdict[]> {
  const out: Verdict[] = [];
  for (let i = 0; i < urls.length; i += BATCH_SIZE) {
    const batch = urls.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(batch.map((u) => checkOne(u)));
    out.push(...results);
  }
  return out;
}

function pushBrokenAlert(nNew: number, examples: { url: string; status: number }[]) {
  const lines = examples.slice(0, 5).map((e) => `${e.url} (${e.status || "sin respuesta"})`).join("\n");
  fetch(`${SB_URL}/functions/v1/push-send`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") },
    body: JSON.stringify({
      title: `🩺 ${nNew} URL${nNew === 1 ? "" : "s"} rota${nNew === 1 ? "" : "s"} nueva${nNew === 1 ? "" : "s"} en el sitemap`,
      body: lines || "Revisá el detalle en el dashboard.",
      url: "/dashboard/?tab=contenido&sub=seo",
    }),
  }).catch(() => {});
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  // auth: cron con secret compartido O usuario logueado del dashboard (mismo patrón reactivation-engine)
  const authHdr = req.headers.get("Authorization") ?? "";
  const isCron = !!CRON_SECRET && authHdr === `Bearer ${CRON_SECRET}`;
  if (!isCron) {
    const supabaseAuth = createClient(SB_URL, SB_ANON, { global: { headers: { Authorization: authHdr } } });
    const { data: { user } } = await supabaseAuth.auth.getUser();
    if (!user) return json({ error: "unauthorized" }, 401);
  }
  try {
    const urls = await collectSitemapUrls();
    if (!urls.length) return json({ error: "no se pudo leer ninguna URL del sitemap" }, 500);

    const results = await checkAll(urls);
    const broken = results.filter((r) => r.status === "broken").map((r) => ({ url: r.url, status: r.code }));
    const redirects = results.filter((r) => r.status === "redirect").map((r) => ({ url: r.url, status: r.code, location: r.location || null }));
    const ok = results.length - broken.length - redirects.length;

    // ---- comparación con la corrida anterior (idempotencia de aviso: solo lo NUEVO) ----
    const { data: prevRun } = await service.from("site_health_runs")
      .select("broken").order("created_at", { ascending: false }).limit(1).maybeSingle();
    const prevBrokenUrls = new Set(((prevRun?.broken ?? []) as { url: string }[]).map((b) => b.url));
    const newlyBroken = broken.filter((b) => !prevBrokenUrls.has(b.url));

    const { data: inserted, error: insErr } = await service.from("site_health_runs").insert({
      total: results.length, ok, redirect_count: redirects.length, broken_count: broken.length,
      broken, redirects,
    }).select("id,created_at").single();
    if (insErr) return json({ error: insErr.message + " — ¿corriste la migración 0117?" }, 500);

    if (newlyBroken.length) pushBrokenAlert(newlyBroken.length, newlyBroken);

    return json({
      ok: true,
      run_id: inserted.id,
      created_at: inserted.created_at,
      total: results.length,
      ok_count: ok,
      redirect_count: redirects.length,
      broken_count: broken.length,
      broken,
      redirects,
      newly_broken: newlyBroken,
      pushed: newlyBroken.length > 0,
    });
  } catch (e) {
    console.error("FUNCTION_ERROR", String(e));
    return json({ error: String(e) }, 500);
  }
});
