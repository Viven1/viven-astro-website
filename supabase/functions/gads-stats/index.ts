// Supabase Edge Function: gads-stats
// DATOS OFICIALES DE GOOGLE ADS para el tab 🎯: gasto, clicks, impresiones y CPC
// por campaña (últimos N días) vía la Google Ads API. Mientras el developer
// token esté pendiente de Basic access, responde { pending: true } y el
// dashboard lo muestra como "esperando aprobación de Google" — se enciende solo.
//
// Rediseño: además del reporte por campaña de siempre, este mismo endpoint
// puede devolver (todo opt-in vía flags en el body, para no gastar cuota de la
// API en las llamadas que no lo necesitan — p. ej. Home solo pide {days}):
//   month:true          → gasto mes-a-la-fecha (para el pacing de presupuesto)
//   budget:true         → presupuestos activos (campaign_budget) + pacing
//   search_terms:true   → search_term_view (clicks/costo por término real)
// Las 3 son best-effort: si fallan no tumban la respuesta principal, quedan
// como null/omitidas + un "warnings[]" legible.
//
// Deploy:   supabase functions deploy gads-stats --no-verify-jwt
// Secrets:  GOOGLE_ADS_DEV_TOKEN, GOOGLE_ADS_MANAGER_ID (login-customer-id),
//           GOOGLE_ADS_CUSTOMER_ID (cuenta operativa), GOOGLE_REFRESH_TOKEN
//           (scope adwords incluido). Opcional: GOOGLE_ADS_API_VERSION.
//
// fix (auditoría 2026-07-14): invocable sin auth por cualquiera — filtraba gasto/
// performance real de Google Ads. A diferencia de content-engine, ningún cron llama
// a esta función (solo el tab 🎯 del dashboard) → exige SIEMPRE un usuario real logueado,
// sin bypass de CRON_SECRET.

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

const SOFT_ERR = /DEVELOPER_TOKEN_NOT_APPROVED|DEVELOPER_TOKEN_PROHIBITED|NOT_ADS_USER|CUSTOMER_NOT_ENABLED|USER_PERMISSION_DENIED|UNSUPPORTED_VERSION/i;

// una query GAQL cruda → filas ya "aplanadas" (googleAds:searchStream devuelve chunks)
async function gaql(query: string, ctx: { ver: string; cid: string; mgr: string; devToken: string; token: string }) {
  const res = await fetch(`https://googleads.googleapis.com/${ctx.ver}/customers/${ctx.cid}/googleAds:searchStream`, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + ctx.token,
      "developer-token": ctx.devToken,
      ...(ctx.mgr ? { "login-customer-id": ctx.mgr } : {}),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query }),
  });
  const text = await res.text();
  if (!res.ok) {
    console.error("GADS_ERROR", res.status, text.slice(0, 400));
    if (SOFT_ERR.test(text)) { const e = new Error("pending:" + (text.match(SOFT_ERR) || ["pendiente"])[0]); throw e; }
    throw new Error("GoogleAds " + res.status + ": " + text.slice(0, 300));
  }
  const chunks = JSON.parse(text);
  const rows: Record<string, unknown>[] = [];
  for (const ch of Array.isArray(chunks) ? chunks : [chunks]) for (const r of ch.results ?? []) rows.push(r);
  return rows;
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
function monthRange() {
  const now = new Date();
  const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const lastDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  return { from: iso(first), to: iso(now), daysElapsed: now.getUTCDate(), daysInMonth: lastDay };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const supabaseAuth = createClient(SB_URL, SB_ANON, { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } });
  const { data: { user } } = await supabaseAuth.auth.getUser();
  if (!user) return json({ error: "unauthorized" }, 401);
  try {
    const devToken = Deno.env.get("GOOGLE_ADS_DEV_TOKEN") || "";
    const cid = (Deno.env.get("GOOGLE_ADS_CUSTOMER_ID") || "").replace(/-/g, "");
    const mgr = (Deno.env.get("GOOGLE_ADS_MANAGER_ID") || "").replace(/-/g, "");
    if (!devToken || !cid) return json({ pending: true, reason: "faltan secrets GOOGLE_ADS_*" });

    const body = await req.json().catch(() => ({}));
    const token = await googleToken();
    const ver = Deno.env.get("GOOGLE_ADS_API_VERSION") || "v21";
    const ctx = { ver, cid, mgr, devToken, token };
    const days = Math.min(365, Math.max(7, +body.days || 30));
    const from = iso(new Date(Date.now() - days * 864e5)), to = iso(new Date());

    let rawCampaigns: Record<string, unknown>[];
    try {
      rawCampaigns = await gaql(
        `SELECT campaign.id, campaign.name, campaign.status,
                metrics.cost_micros, metrics.clicks, metrics.impressions, metrics.conversions
         FROM campaign
         WHERE segments.date BETWEEN '${from}' AND '${to}'
           AND campaign.status IN ('ENABLED', 'PAUSED')`,
        ctx,
      );
    } catch (e) {
      const msg = String((e as Error).message || e);
      if (msg.startsWith("pending:")) return json({ pending: true, reason: msg.slice(8) });
      return json({ error: msg }, 502);
    }

    const campaigns: { id: string; name: string; status: string; cost: number; clicks: number; impressions: number; conversions: number }[] = [];
    for (const r of rawCampaigns) {
      const c = r as { campaign?: { id?: string; name?: string; status?: string }; metrics?: { costMicros?: string; clicks?: string; impressions?: string; conversions?: string } };
      campaigns.push({
        id: String(c.campaign?.id ?? ""),
        name: c.campaign?.name ?? "(sin nombre)",
        status: c.campaign?.status ?? "",
        cost: Math.round((+(c.metrics?.costMicros ?? 0)) / 1e4) / 100,
        clicks: +(c.metrics?.clicks ?? 0),
        impressions: +(c.metrics?.impressions ?? 0),
        conversions: +(c.metrics?.conversions ?? 0),
      });
    }
    campaigns.sort((a, b) => b.cost - a.cost);
    const total = campaigns.reduce((a, c) => ({ cost: a.cost + c.cost, clicks: a.clicks + c.clicks, impressions: a.impressions + c.impressions, conversions: a.conversions + c.conversions }), { cost: 0, clicks: 0, impressions: 0, conversions: 0 });

    const out: Record<string, unknown> = { ok: true, days, campaigns, total };
    const warnings: string[] = [];

    // gasto mes-a-la-fecha (para el pacing) — best-effort, no tumba la respuesta principal
    if (body.month) {
      try {
        const mr = monthRange();
        const rows = await gaql(
          `SELECT metrics.cost_micros, metrics.clicks
           FROM campaign
           WHERE segments.date BETWEEN '${mr.from}' AND '${mr.to}'
             AND campaign.status IN ('ENABLED', 'PAUSED')`,
          ctx,
        );
        const m = rows.reduce((a: { cost: number; clicks: number }, r) => {
          const met = (r as { metrics?: { costMicros?: string; clicks?: string } }).metrics;
          return { cost: a.cost + (+(met?.costMicros ?? 0)) / 1e6, clicks: a.clicks + (+(met?.clicks ?? 0)) };
        }, { cost: 0, clicks: 0 });
        out.month = { ...m, daysElapsed: mr.daysElapsed, daysInMonth: mr.daysInMonth };
      } catch (e) { warnings.push("month: " + String((e as Error).message || e)); }
    }

    // presupuestos activos → daily total (para comparar contra el gasto del mes)
    if (body.budget) {
      try {
        const rows = await gaql(
          `SELECT campaign_budget.id, campaign_budget.amount_micros, campaign_budget.period, campaign.status
           FROM campaign_budget
           WHERE campaign_budget.status = 'ENABLED'`,
          ctx,
        );
        let dailyTotal = 0;
        const budgets = rows.map((r) => {
          const b = (r as { campaignBudget?: { amountMicros?: string; period?: string } }).campaignBudget;
          const amount = (+(b?.amountMicros ?? 0)) / 1e6;
          if ((b?.period || "DAILY") === "DAILY") dailyTotal += amount;
          return { amount, period: b?.period || "DAILY" };
        });
        out.budget = { daily_total: Math.round(dailyTotal * 100) / 100, campaigns: budgets };
      } catch (e) { warnings.push("budget: " + String((e as Error).message || e)); }
    }

    // search terms reales de los últimos `days` — para detectar negativas obvias
    if (body.search_terms) {
      try {
        const rows = await gaql(
          `SELECT campaign.id, search_term_view.search_term, metrics.clicks, metrics.cost_micros
           FROM search_term_view
           WHERE segments.date BETWEEN '${from}' AND '${to}'
           ORDER BY metrics.clicks DESC
           LIMIT 200`,
          ctx,
        );
        out.search_terms = rows.map((r) => {
          const row = r as { campaign?: { id?: string }; searchTermView?: { searchTerm?: string }; metrics?: { clicks?: string; costMicros?: string } };
          return {
            campaign_id: row.campaign?.id ?? "",
            term: row.searchTermView?.searchTerm ?? "",
            clicks: +(row.metrics?.clicks ?? 0),
            cost: Math.round((+(row.metrics?.costMicros ?? 0)) / 1e4) / 100,
          };
        });
      } catch (e) { warnings.push("search_terms: " + String((e as Error).message || e)); }
    }

    if (warnings.length) out.warnings = warnings;
    return json(out);
  } catch (e) {
    console.error("FUNCTION_ERROR", String(e));
    return json({ error: String(e) }, 500);
  }
});
