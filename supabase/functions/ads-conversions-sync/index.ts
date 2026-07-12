// Supabase Edge Function: ads-conversions-sync
// GOOGLE ADS 100% AUTOMÁTICO: mantiene un Google Sheet con TODAS las conversiones
// offline (cada lead con gclid; los ganados con su valor CHF) en el formato oficial
// de importación de Google Ads. En Google Ads se programa UNA VEZ una importación
// diaria desde ese Sheet → circuito cerrado sin tocar nada más:
// click → lead (gclid) → ganado en el CRM → cron actualiza el Sheet → Ads lo importa
// → el algoritmo optimiza por CLIENTES, no por formularios.
//
// Deploy:   supabase functions deploy ads-conversions-sync --no-verify-jwt
// Requiere: GOOGLE_REFRESH_TOKEN con scope spreadsheets (además de calendar+webmasters)
//           ADS_SHEET_ID (el spreadsheet destino; se crea con {"create_sheet":true})
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
    const p2 = (n: number) => String(n).padStart(2, "0");
    const fmt = (iso: string) => { const d = new Date(iso); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`; };
    const rows = clean.flatMap((r) => {
      const out: string[][] = [[r.gclid, "Lead (CRM)", fmt(r.created_at), "0", "CHF"]];
      if (isWon(r)) out.push([r.gclid, "Lead ganado (CRM)", fmt((r as { won_at?: string; last_stage_at?: string }).won_at || (r as { last_stage_at?: string }).last_stage_at || r.created_at), String(+(r as { deal_value?: number }).deal_value! || 0), "CHF"]);
      return out;
    });
    const values = [
      ["Parameters:TimeZone=Europe/Zurich"],
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
    return json({ ok: true, sheet: sheetId, lead_rows: rows.length - won, won_rows: won });
  } catch (e) {
    console.error("FUNCTION_ERROR", String(e));
    return json({ error: String(e) }, 500);
  }
});
