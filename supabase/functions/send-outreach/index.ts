// Supabase Edge Function: send-outreach
// Envía al LEAD el email de follow-up ya aprobado (desde el dashboard) vía Resend.
// La llama el usuario logueado del dashboard. NO usa Anthropic (solo Resend).
//
// Deploy:  supabase functions deploy send-outreach --no-verify-jwt
// Secret:  RESEND_API_KEY (ya seteado)

import { cartaViven } from "../_shared/email-viven.ts";
import { autolink } from "../_shared/autolink.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
// Email humano al lead: sale desde info@viven.ch (buzón real y monitoreado → las respuestas caen ahí).
// El nombre visible del remitente lo elige el dashboard (Sofia o Sebastian) y llega en fromName.
const DEFAULT_FROM_NAME = "Sofia Treviño";
const REPLY_TO = "info@viven.ch";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const esc = (t: string) => t.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]!));
/* texto plano → HTML simple: escapa, enlaza y saltos de línea → <br>.
   Enlazaba SOLO "https://…", así que un "viven.ch/book/" escrito a mano salía como texto
   muerto. Y este es justo el camino de los emails que Sebastián escribe él mismo desde la
   ficha del contacto, o sea el que más importa. Ahora usa el autolink compartido. */
const toHtml = (text: string) => autolink(esc(text), "#2b6cff").replace(/\n/g, "<br>");

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const auth = req.headers.get("Authorization") ?? "";
    const supabase = createClient(SB_URL, SB_ANON, { global: { headers: { Authorization: auth } } });
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return json({ error: "unauthorized" }, 401);

    const { to, subject, body, lead_id, mark_contacted, fromName } = await req.json();
    if (!to || !subject || !body) return json({ error: "faltan campos (to, subject, body)" }, 400);
    const FROM = `${(fromName || DEFAULT_FROM_NAME).replace(/[<>"]/g, "")} <info@viven.ch>`;

    /* Formato CARTA, no el layout de marca completo: esto es un email uno a uno de venta
       o de seguimiento, y un header oscuro con el logo grande lo convierte en un flyer.
       Un flyer no se contesta. La marca va en la firma —logo chico, nombre, cargo— que es
       lo que hace que se reconozca sin gritar.
       (Sebastián, 26 ago 2026: "importante la presencia que damos, el branding tiene que
       ser consistente".) */
    const FIRMAS: Record<string, { nombre: string; cargo: string }> = {
      sofia: { nombre: "Sofia Treviño", cargo: "Producer, VIVEN AG" },
      sebastian: { nombre: "Sebastian Cepeda", cargo: "Director, VIVEN AG" },
    };
    const clave = String(fromName || DEFAULT_FROM_NAME).toLowerCase().split(/\s+/)[0];
    const html = cartaViven({
      texto: toHtml(body),
      /* Solo si el texto NO trae ya su propia despedida: los borradores de outreach la
         escriben adentro, y dos firmas seguidas se leen como un error. */
      firma: /\n\s*(saludos|liebe gr|best regards|kind regards|abrazo|un saludo)/i.test(String(body))
        ? undefined : (FIRMAS[clave] ?? { nombre: String(fromName || DEFAULT_FROM_NAME), cargo: "VIVEN AG" }),
    });
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

    // marca el lead como contactado (el trigger programa el próximo follow-up) y logea el email
    // para que la ficha del contacto muestre el hilo completo, mande quien mande
    const admin = createClient(SB_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    if (lead_id && mark_contacted) {
      await admin.from("leads").update({ status: "contactado", last_outreach_at: new Date().toISOString() }).eq("id", lead_id);
    }
    if (lead_id) {
      await admin.from("email_log").insert({ lead_id: String(lead_id), to_addr: to, subject, body, sender_label: fromName || DEFAULT_FROM_NAME, source: "outreach" }).then(() => {}, () => {});
    }
    return json({ ok: true });
  } catch (e) {
    console.error("FUNCTION_ERROR", String(e));
    return json({ error: String(e) });
  }
});
