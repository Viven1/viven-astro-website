// Supabase Edge Function: notify-user
// Avisa por email a un miembro del team (mención en una nota, o task asignada).
// La llama el dashboard (usuario logueado). Solo manda a direcciones @viven.ch (seguridad).
//
// Deploy:  supabase functions deploy notify-user --no-verify-jwt
// Secret:  RESEND_API_KEY (ya seteado)

import { createClient } from "jsr:@supabase/supabase-js@2";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_ANON = Deno.env.get("SUPABASE_ANON_KEY")!;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const esc = (t: string) => String(t).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]!));

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const auth = req.headers.get("Authorization") ?? "";
    const supabase = createClient(SB_URL, SB_ANON, { global: { headers: { Authorization: auth } } });
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return json({ error: "unauthorized" }, 401);

    const { to, subject, body, lead_url } = await req.json();
    if (!to || !subject || !body) return json({ error: "faltan campos (to, subject, body)" }, 400);
    // seguridad: solo notificamos a direcciones del propio dominio
    if (!/@viven\.ch$/i.test(String(to))) return json({ error: "destinatario no permitido" }, 400);

    const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.6;color:#1a2230">${esc(body).replace(/\n/g, "<br>")}${lead_url ? `<br><br><a href="${esc(lead_url)}" style="color:#2b6cff">Abrir en el dashboard →</a>` : ""}</div>`;
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: "Viven Dashboard <leads@viven.ch>", to: [to], subject, html, text: body }),
    });
    if (!res.ok) { const t = await res.text(); console.error("RESEND_ERROR", res.status, t); return json({ error: `Resend ${res.status}: ${t.slice(0, 200)}` }); }
    return json({ ok: true });
  } catch (e) {
    console.error("FUNCTION_ERROR", String(e));
    return json({ error: String(e) });
  }
});
