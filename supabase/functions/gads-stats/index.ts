// Supabase Edge Function: gads-stats
// DATOS OFICIALES DE GOOGLE ADS para el tab 🎯: gasto, clicks, impresiones y CPC
// por campaña (últimos 30 días) vía la Google Ads API. Mientras el developer
// token esté pendiente de Basic access, responde { pending: true } y el
// dashboard lo muestra como "esperando aprobación de Google" — se enciende solo.
//
// Deploy:   supabase functions deploy gads-stats --no-verify-jwt
// Secrets:  GOOGLE_ADS_DEV_TOKEN, GOOGLE_ADS_MANAGER_ID (login-customer-id),
//           GOOGLE_ADS_CUSTOMER_ID (cuenta operativa), GOOGLE_REFRESH_TOKEN
//           (scope adwords incluido). Opcional: GOOGLE_ADS_API_VERSION.

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
    const devToken = Deno.env.get("GOOGLE_ADS_DEV_TOKEN") || "";
    const cid = (Deno.env.get("GOOGLE_ADS_CUSTOMER_ID") || "").replace(/-/g, "");
    const mgr = (Deno.env.get("GOOGLE_ADS_MANAGER_ID") || "").replace(/-/g, "");
    if (!devToken || !cid) return json({ pending: true, reason: "faltan secrets GOOGLE_ADS_*" });

    const token = await googleToken();
    const ver = Deno.env.get("GOOGLE_ADS_API_VERSION") || "v21";
    const body = await req.json().catch(() => ({}));
    const days = Math.min(365, Math.max(7, +body.days || 30));
    const query = `
      SELECT campaign.id, campaign.name, campaign.status,
             metrics.cost_micros, metrics.clicks, metrics.impressions, metrics.conversions
      FROM campaign
      WHERE segments.date BETWEEN '${new Date(Date.now() - days * 864e5).toISOString().slice(0, 10)}' AND '${new Date().toISOString().slice(0, 10)}'
        AND campaign.status IN ('ENABLED', 'PAUSED')`;

    const res = await fetch(`https://googleads.googleapis.com/${ver}/customers/${cid}/googleAds:searchStream`, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        "developer-token": devToken,
        ...(mgr ? { "login-customer-id": mgr } : {}),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query }),
    });
    const text = await res.text();
    if (!res.ok) {
      // token en modo test / cuenta sin vincular / versión API caduca → estado "pendiente" legible
      const soft = /DEVELOPER_TOKEN_NOT_APPROVED|DEVELOPER_TOKEN_PROHIBITED|NOT_ADS_USER|CUSTOMER_NOT_ENABLED|USER_PERMISSION_DENIED|UNSUPPORTED_VERSION/i;
      console.error("GADS_ERROR", res.status, text.slice(0, 400));
      if (soft.test(text)) return json({ pending: true, reason: (text.match(soft) || ["pendiente"])[0], status: res.status });
      return json({ error: "GoogleAds " + res.status + ": " + text.slice(0, 300) }, 502);
    }
    const chunks = JSON.parse(text);
    const campaigns: { name: string; status: string; cost: number; clicks: number; impressions: number; conversions: number }[] = [];
    for (const ch of Array.isArray(chunks) ? chunks : [chunks]) {
      for (const r of ch.results ?? []) {
        campaigns.push({
          name: r.campaign?.name ?? "(sin nombre)",
          status: r.campaign?.status ?? "",
          cost: Math.round((+(r.metrics?.costMicros ?? 0)) / 1e4) / 100,
          clicks: +(r.metrics?.clicks ?? 0),
          impressions: +(r.metrics?.impressions ?? 0),
          conversions: +(r.metrics?.conversions ?? 0),
        });
      }
    }
    campaigns.sort((a, b) => b.cost - a.cost);
    const total = campaigns.reduce((a, c) => ({ cost: a.cost + c.cost, clicks: a.clicks + c.clicks, impressions: a.impressions + c.impressions, conversions: a.conversions + c.conversions }), { cost: 0, clicks: 0, impressions: 0, conversions: 0 });
    return json({ ok: true, days, campaigns, total });
  } catch (e) {
    console.error("FUNCTION_ERROR", String(e));
    return json({ error: String(e) }, 500);
  }
});
