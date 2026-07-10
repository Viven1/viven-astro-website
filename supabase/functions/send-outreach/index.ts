// Supabase Edge Function: send-outreach
// Envía al LEAD el email de follow-up ya aprobado (desde el dashboard) vía Resend.
// La llama el usuario logueado del dashboard. NO usa Anthropic (solo Resend).
//
// Deploy:  supabase functions deploy send-outreach --no-verify-jwt
// Secret:  RESEND_API_KEY (ya seteado)

import { createClient } from "jsr:@supabase/supabase-js@2";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
// Email humano al lead: sale desde info@viven.ch (buzón real y monitoreado → las respuestas caen ahí).
const FROM = "Sofia Treviño · Viven <info@viven.ch>";
const REPLY_TO = "info@viven.ch";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const esc = (t: string) => t.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]!));
// texto plano → HTML simple: escapa, autolinkea URLs, saltos de línea → <br>
const toHtml = (text: string) =>
  esc(text)
    .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" style="color:#2b6cff">$1</a>')
    .replace(/\n/g, "<br>");

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const auth = req.headers.get("Authorization") ?? "";
    const supabase = createClient(SB_URL, SB_ANON, { global: { headers: { Authorization: auth } } });
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return json({ error: "unauthorized" }, 401);

    const { to, subject, body, lead_id, mark_contacted } = await req.json();
    if (!to || !subject || !body) return json({ error: "faltan campos (to, subject, body)" }, 400);

    const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.6;color:#1a2230">${toHtml(body)}</div>`;
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: FROM, to: [to], reply_to: REPLY_TO, subject, html, text: body }),
    });
    if (!res.ok) {
      const t = await res.text();
      console.error("RESEND_ERROR", res.status, t);
      return json({ error: `Resend ${res.status}: ${t.slice(0, 300)}` });
    }

    // marca el lead como contactado (el trigger programa el próximo follow-up) usando el service role
    if (lead_id && mark_contacted) {
      const admin = createClient(SB_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
      await admin.from("leads").update({ status: "contactado", last_outreach_at: new Date().toISOString() }).eq("id", lead_id);
    }
    return json({ ok: true });
  } catch (e) {
    console.error("FUNCTION_ERROR", String(e));
    return json({ error: String(e) });
  }
});
