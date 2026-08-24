// Supabase Edge Function: newsletter-unsub
// Baja de newsletter de UN click (GET ?l=<lead_id>&t=<token>), sin login.
// El token es un hash del lead — nadie puede dar de baja a otro adivinando IDs.
//
// Deploy:  supabase functions deploy newsletter-unsub --no-verify-jwt

import { createClient } from "jsr:@supabase/supabase-js@2";

const service = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const RESEND = Deno.env.get("RESEND_API_KEY")!;

async function unsubToken(id: string): Promise<string> {
  const data = new TextEncoder().encode(String(id) + "|" + RESEND.slice(0, 24));
  const h = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 24);
}

const page = (msg: string) => new Response(
  `<!doctype html><meta charset="utf-8"><title>VIVEN</title><body style="font-family:sans-serif;background:#0f1826;color:#f4f6fb;display:grid;place-items:center;min-height:100vh;text-align:center"><div><p style="font-size:40px;margin:0">👋</p><h1 style="font-size:22px">${msg}</h1><p style="color:#9aa6bd"><a href="https://www.viven.ch" style="color:#ddf98f">viven.ch</a></p></div>`,
  { headers: { "Content-Type": "text/html; charset=utf-8" } });

Deno.serve(async (req) => {
  try {
    const u = new URL(req.url);
    const l = u.searchParams.get("l"), t = u.searchParams.get("t");
    if (!l || !t || t !== await unsubToken(l)) return page("Link inválido / Invalid link");
    const { error } = await service.from("leads").update({ unsubscribed: true }).eq("id", l);
    if (error) return page("Error — escribinos a info@viven.ch");
    return page("Done — you won't receive our newsletter anymore. / Erledigt. / Listo, no recibís más.");
  } catch {
    return page("Error — escribinos a info@viven.ch");
  }
});
