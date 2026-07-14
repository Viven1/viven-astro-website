// Supabase Edge Function: ads-conversions-sync
// GOOGLE ADS 100% AUTOMÁTICO: mantiene un Google Sheet con TODAS las conversiones
// offline (cada lead con gclid; los ganados con su valor CHF) en el formato oficial
// de importación de Google Ads. En Google Ads se programa UNA VEZ una importación
// diaria desde ese Sheet → circuito cerrado sin tocar nada más:
// click → lead (gclid) → ganado en el CRM → cron actualiza el Sheet → Ads lo importa
// → el algoritmo optimiza por CLIENTES, no por formularios.
//
// Rediseño del tab 🎯: esta misma corrida diaria (NO se toca el cron — SQL 0035
// sigue igual) ahora TAMBIÉN persiste un snapshot diario por campaña en
// public.ads_daily (mismo patrón GAQL que gads-stats, con segments.date agregado
// y agrupado día a día) para poder dibujar la tendencia de gasto/leads sin
// re-consultar la API de Google en cada vista del dashboard. Y deja constancia
// legible del propio sync (last_sync_at/leads/won/error) en ads_settings para
// el botón "Sync ahora" del tab. Todo esto es best-effort: si el developer
// token de Ads sigue pendiente de aprobación, se salta en silencio — el Sheet
// (la parte que SÍ funciona hoy) se sigue actualizando igual.
//
// Deploy:   supabase functions deploy ads-conversions-sync --no-verify-jwt
// Requiere: GOOGLE_REFRESH_TOKEN con scope spreadsheets (además de calendar+webmasters)
//           ADS_SHEET_ID (el spreadsheet destino; se crea con {"create_sheet":true})
//           Opcional para el snapshot diario: GOOGLE_ADS_DEV_TOKEN, GOOGLE_ADS_CUSTOMER_ID,
//           GOOGLE_ADS_MANAGER_ID, GOOGLE_ADS_API_VERSION (los mismos secrets de gads-stats)
// Cron:     SQL 0035 (diario 06:50 UTC, antes de que Google Ads importe)

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

// snapshot diario por campaña (ads_daily) — mismo recurso `campaign` que gads-stats,
// segmentado por segments.date. Ventana de 3 días (hoy + 2 atrás) porque Google a
// veces revisa las métricas de ayer/anteayer un rato después de la medianoche.
// Best-effort total: cualquier fallo (token pendiente, secrets faltantes, etc.)
// se traga acá y no rompe el sync del Sheet, que es la responsabilidad principal.
async function syncDailySnapshot(gToken: string): Promise<{ ok: boolean; days?: number; reason?: string }> {
  const devToken = Deno.env.get("GOOGLE_ADS_DEV_TOKEN") || "";
  const cid = (Deno.env.get("GOOGLE_ADS_CUSTOMER_ID") || "").replace(/-/g, "");
  const mgr = (Deno.env.get("GOOGLE_ADS_MANAGER_ID") || "").replace(/-/g, "");
  if (!devToken || !cid) return { ok: false, reason: "faltan secrets GOOGLE_ADS_* (Ads API pendiente)" };
  const ver = Deno.env.get("GOOGLE_ADS_API_VERSION") || "v21";
  const to = new Date(), from = new Date(Date.now() - 2 * 864e5);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const query = `
    SELECT campaign.id, campaign.name, segments.date,
           metrics.cost_micros, metrics.clicks, metrics.impressions, metrics.conversions
    FROM campaign
    WHERE segments.date BETWEEN '${iso(from)}' AND '${iso(to)}'
      AND campaign.status IN ('ENABLED', 'PAUSED')`;
  const res = await fetch(`https://googleads.googleapis.com/${ver}/customers/${cid}/googleAds:searchStream`, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + gToken,
      "developer-token": devToken,
      ...(mgr ? { "login-customer-id": mgr } : {}),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query }),
  });
  const text = await res.text();
  if (!res.ok) {
    const soft = /DEVELOPER_TOKEN_NOT_APPROVED|DEVELOPER_TOKEN_PROHIBITED|NOT_ADS_USER|CUSTOMER_NOT_ENABLED|USER_PERMISSION_DENIED|UNSUPPORTED_VERSION/i;
    return { ok: false, reason: soft.test(text) ? "Ads API pendiente de aprobación" : ("GoogleAds " + res.status) };
  }
  const chunks = JSON.parse(text);
  const rows: { date: string; campaign_id: string; campaign_name: string; spend: number; clicks: number; impressions: number; conversions: number; updated_at: string }[] = [];
  const now = new Date().toISOString();
  for (const ch of Array.isArray(chunks) ? chunks : [chunks]) {
    for (const r of ch.results ?? []) {
      const c = r as { campaign?: { id?: string; name?: string }; segments?: { date?: string }; metrics?: { costMicros?: string; clicks?: string; impressions?: string; conversions?: string } };
      if (!c.campaign?.id || !c.segments?.date) continue;
      rows.push({
        date: c.segments.date,
        campaign_id: String(c.campaign.id),
        campaign_name: c.campaign.name ?? "(sin nombre)",
        spend: Math.round((+(c.metrics?.costMicros ?? 0)) / 1e4) / 100,
        clicks: +(c.metrics?.clicks ?? 0),
        impressions: +(c.metrics?.impressions ?? 0),
        conversions: +(c.metrics?.conversions ?? 0),
        updated_at: now,
      });
    }
  }
  if (rows.length) {
    const { error } = await service.from("ads_daily").upsert(rows, { onConflict: "date,campaign_id" });
    if (error) return { ok: false, reason: "ads_daily: " + error.message };
  }
  return { ok: true, days: 3 };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const body = await req.json().catch(() => ({}));
    const token = await googleToken();
    const gh = { Authorization: "Bearer " + token, "Content-Type": "application/json" };

    // modo setup: crear el spreadsheet una sola vez → devuelve el ID para ADS_SHEET_ID
    if (body.create_sheet) {
      const r = await fetch("https://sheets.googleapis.com/v4/spreadsheets", {
        method: "POST",
        headers: gh,
        body: JSON.stringify({ properties: { title: "VIVEN — Google Ads conversiones offline (auto)" } }),
      });
      if (!r.ok) return json({ error: "sheets_create " + r.status + ": " + (await r.text()).slice(0, 300) }, 500);
      const j = await r.json();
      return json({ ok: true, spreadsheetId: j.spreadsheetId, url: j.spreadsheetUrl });
    }

    const sheetId = body.sheet_id || Deno.env.get("ADS_SHEET_ID") || "";
    if (!sheetId) return json({ error: "Falta ADS_SHEET_ID (creá el sheet con {\"create_sheet\":true} y setealo como secret)." }, 400);

    // todas las conversiones: lead (form) y lead ganado (con valor) — Google Ads
    // ignora duplicados exactos, así que el snapshot completo diario es seguro.
    let q = await service.from("leads").select("gclid,email,deal_value,status,created_at,won_at,last_stage_at,ads_exclude").not("gclid", "is", null);
    if (q.error && /column/.test(q.error.message || "")) q = await service.from("leads").select("gclid,email,deal_value,status,created_at,won_at,last_stage_at").not("gclid", "is", null);
    const { data, error } = q;
    if (error) return json({ error: error.message }, 500);
    // nunca reportar spam/tests: exclusión manual (ads_exclude), emails de prueba y estados descartados
    const ADS_TEST = /@viven\.ch$|@entropia|@example\.|test/i;
    const clean = (data ?? []).filter((r) => !(r as { ads_exclude?: boolean }).ads_exclude && !ADS_TEST.test((r as { email?: string }).email || "") && !/spam|descartado|perdido-spam/i.test(r.status || ""));
    const isWon = (r: { status?: string }) => /ganado|won|cerrado/i.test(r.status || "");
    // hora LOCAL de Zúrich con offset explícito (+01:00/+02:00 según DST) — el Data
    // Manager de Google Ads lee la fila 1 como encabezados, así que la vieja línea
    // "Parameters:TimeZone=…" ya no va: la zona viaja dentro de cada timestamp.
    const fmt = (iso: string) => {
      const d = new Date(iso);
      const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Zurich", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).formatToParts(d).map((p) => [p.type, p.value]));
      const off = (new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Zurich", timeZoneName: "longOffset" }).formatToParts(d).find((p) => p.type === "timeZoneName")?.value || "GMT+01:00").replace("GMT", "");
      return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}${off}`;
    };
    const rows = clean.flatMap((r) => {
      const out: string[][] = [[r.gclid, "Lead (CRM)", fmt(r.created_at), "0", "CHF"]];
      if (isWon(r)) out.push([r.gclid, "Lead ganado (CRM)", fmt((r as { won_at?: string; last_stage_at?: string }).won_at || (r as { last_stage_at?: string }).last_stage_at || r.created_at), String(+(r as { deal_value?: number }).deal_value! || 0), "CHF"]);
      return out;
    });
    const values = [
      ["Google Click ID", "Conversion Name", "Conversion Time", "Conversion Value", "Conversion Currency"],
      ...rows,
    ];

    const base = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values`;
    const cl = await fetch(`${base}/A1:Z100000:clear`, { method: "POST", headers: gh, body: "{}" });
    if (!cl.ok) return json({ error: "sheets_clear " + cl.status + ": " + (await cl.text()).slice(0, 200) }, 500);
    const up = await fetch(`${base}/A1?valueInputOption=RAW`, { method: "PUT", headers: gh, body: JSON.stringify({ range: "A1", majorDimension: "ROWS", values }) });
    if (!up.ok) return json({ error: "sheets_update " + up.status + ": " + (await up.text()).slice(0, 300) }, 500);

    const won = rows.filter((r) => r[1] === "Lead ganado (CRM)").length;
    console.log("ADS_SYNC", { leads: rows.length - won, won });

    // snapshot diario (ads_daily) + estado del sync — best-effort, nunca tumba el
    // resultado principal (el Sheet, arriba, ya se actualizó bien igual).
    let dailyInfo: { ok: boolean; reason?: string } = { ok: false, reason: "no intentado" };
    try { dailyInfo = await syncDailySnapshot(token); } catch (e) { dailyInfo = { ok: false, reason: String(e) }; }
    try {
      await service.from("ads_settings").upsert({
        id: 1,
        last_sync_at: new Date().toISOString(),
        last_sync_leads: rows.length - won,
        last_sync_won: won,
        last_sync_error: dailyInfo.ok ? null : (dailyInfo.reason || null),
      }, { onConflict: "id" });
    } catch (e) { console.error("ADS_SETTINGS_UPDATE_ERROR", String(e)); }

    return json({ ok: true, sheet: sheetId, lead_rows: rows.length - won, won_rows: won, daily_snapshot: dailyInfo });
  } catch (e) {
    console.error("FUNCTION_ERROR", String(e));
    return json({ error: String(e) }, 500);
  }
});
