// Supabase Edge Function: send-offer
// Envía la oferta al CLIENTE por email (HTML con la tabla de posiciones embebida),
// desde info@viven.ch vía Resend. Solo usuarios logueados del dashboard.
//
// Deploy:  supabase functions deploy send-offer --no-verify-jwt
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const auth = req.headers.get("Authorization") ?? "";
    const supabase = createClient(SB_URL, SB_ANON, { global: { headers: { Authorization: auth } } });
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return json({ error: "unauthorized" }, 401);

    const { to, subject, html, text, reply_to } = await req.json();
    if (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(to))) return json({ error: "email del cliente inválido" }, 400);
    if (!subject || !html) return json({ error: "faltan subject/html" }, 400);

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "VIVEN AG <info@viven.ch>",
        to: [to],
        reply_to: reply_to && /@viven\.ch$/i.test(reply_to) ? reply_to : "info@viven.ch",
        subject, html, text: text || "",
      }),
    });
    if (!res.ok) { const t = await res.text(); console.error("RESEND_ERROR", res.status, t); return json({ error: `Resend ${res.status}: ${t.slice(0, 200)}` }); }
    return json({ ok: true });
  } catch (e) {
    console.error("FUNCTION_ERROR", String(e));
    return json({ error: String(e) }, 500);
  }
});
