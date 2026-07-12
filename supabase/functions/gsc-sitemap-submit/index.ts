// Supabase Edge Function: gsc-sitemap-submit
// Re-envía sitemap.xml y video-sitemap.xml a Google Search Console vía API —
// el reemplazo del viejo ping de Google (muerto en 2023). Corre por cron diario
// (SQL 0031): Google siempre sabe que hay contenido nuevo, sin tocar nada a mano.
//
// Deploy:   supabase functions deploy gsc-sitemap-submit --no-verify-jwt
// Requiere: GOOGLE_REFRESH_TOKEN autorizado con scope webmasters COMPLETO
//           (https://www.googleapis.com/auth/webmasters — no el .readonly).

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
    const feeds = ["https://www.viven.ch/sitemap.xml", "https://www.viven.ch/video-sitemap.xml"];
    const results: Record<string, number> = {};
    for (const f of feeds) {
      const r = await fetch(`https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site)}/sitemaps/${encodeURIComponent(f)}`, {
        method: "PUT",
        headers: { Authorization: "Bearer " + token },
      });
      results[f] = r.status;   // 200/204 = resubmitted; 403 = falta el scope webmasters completo
    }
    return json({ ok: true, site, results });
  } catch (e) {
    console.error("FUNCTION_ERROR", String(e));
    return json({ error: String(e) }, 500);
  }
});
