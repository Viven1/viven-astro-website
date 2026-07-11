// Supabase Edge Function: gsc-stats
// Lee Google Search Console (Search Analytics) para el tab SEO del dashboard:
// totales + top búsquedas + top páginas de los últimos N días.
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
    const start = new Date(end.getTime() - d * 864e5);
    const ymd = (x: Date) => x.toISOString().slice(0, 10);
    const site = Deno.env.get("GSC_SITE") || "sc-domain:viven.ch";
    const token = await googleToken();

    const query = async (dimensions: string[] | null, rowLimit = 15) => {
      const res = await fetch(`https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site)}/searchAnalytics/query`, {
        method: "POST",
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
        body: JSON.stringify({ startDate: ymd(start), endDate: ymd(end), ...(dimensions ? { dimensions } : {}), rowLimit }),
      });
      if (!res.ok) throw new Error("gsc " + res.status + " " + (await res.text()).slice(0, 200));
      return (await res.json()).rows ?? [];
    };

    const [tot, queries, pages] = await Promise.all([query(null, 1), query(["query"]), query(["page"])]);
    const shape = (r: { keys?: string[]; clicks: number; impressions: number; ctr: number; position: number }) =>
      ({ key: r.keys?.[0] ?? "", clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position });
    const t = tot[0] ?? { clicks: 0, impressions: 0, ctr: 0, position: 0 };
    return json({
      ok: true, site, from: ymd(start), to: ymd(end),
      totals: { clicks: t.clicks, impressions: t.impressions, ctr: t.ctr, position: t.position },
      queries: queries.map(shape), pages: pages.map(shape),
    });
  } catch (e) {
    console.error("FUNCTION_ERROR", String(e));
    return json({ error: String(e) }, 500);
  }
});
