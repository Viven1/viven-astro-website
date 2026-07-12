// Supabase Edge Function: review-request
// Cron diario: deals GANADOS hace ~14 días → email al cliente pidiendo la
// reseña de Google (el motor silencioso del ranking local). Un solo pedido
// por persona, nunca a emails internos/test, y queda registrado como nota.
//
// Deploy:   supabase functions deploy review-request --no-verify-jwt
// Schedule: SQL 0033. Secrets: RESEND_API_KEY (ya seteado).
// Opcional: REVIEW_LINK (link directo de reseña de Google Business Profile);
//           sin setear usa la búsqueda del perfil en Maps.

import { createClient } from "jsr:@supabase/supabase-js@2";

const service = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const REVIEW_LINK = Deno.env.get("REVIEW_LINK") || "https://www.google.com/maps/search/?api=1&query=Viven+AG+Zeughausstrasse+31+Z%C3%BCrich";
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } });

const MAIL = {
  en: {
    subject: "How was working with Viven? 🌟",
    html: (name: string) => `<p>Hi ${name},</p><p>It was a pleasure producing your video — we hope it's already working hard for you.</p><p>If you have 60 seconds, a short Google review would mean a lot to our small team (and helps other companies find us):</p><p><a href="${REVIEW_LINK}" style="display:inline-block;background:#ddf98f;color:#1c2508;font-weight:700;padding:12px 22px;border-radius:100px;text-decoration:none">⭐ Leave a quick review</a></p><p>Thank you — and see you on the next project!<br>Sebastian &amp; the Viven team</p>`,
  },
  de: {
    subject: "Wie war die Zusammenarbeit mit Viven? 🌟",
    html: (name: string) => `<p>Guten Tag ${name},</p><p>Es war uns eine Freude, Ihr Video zu produzieren — wir hoffen, es arbeitet bereits fleissig für Sie.</p><p>Wenn Sie 60 Sekunden haben: Eine kurze Google-Bewertung würde unserem kleinen Team enorm helfen (und anderen Unternehmen, uns zu finden):</p><p><a href="${REVIEW_LINK}" style="display:inline-block;background:#ddf98f;color:#1c2508;font-weight:700;padding:12px 22px;border-radius:100px;text-decoration:none">⭐ Kurze Bewertung schreiben</a></p><p>Herzlichen Dank — bis zum nächsten Projekt!<br>Sebastian &amp; das Viven-Team</p>`,
  },
  es: {
    subject: "¿Cómo fue trabajar con Viven? 🌟",
    html: (name: string) => `<p>Hola ${name}:</p><p>Fue un placer producir tu video — esperamos que ya esté trabajando duro para vos.</p><p>Si tenés 60 segundos, una reseña corta en Google ayuda muchísimo a nuestro equipo (y a que otras empresas nos encuentren):</p><p><a href="${REVIEW_LINK}" style="display:inline-block;background:#ddf98f;color:#1c2508;font-weight:700;padding:12px 22px;border-radius:100px;text-decoration:none">⭐ Dejar una reseña</a></p><p>¡Gracias — y hasta el próximo proyecto!<br>Sebastian y el equipo de Viven</p>`,
  },
};

Deno.serve(async (_req) => {
  try {
    if (!RESEND_API_KEY) return json({ error: "falta RESEND_API_KEY" }, 500);
    const from = new Date(Date.now() - 15 * 864e5).toISOString();
    const to = new Date(Date.now() - 13 * 864e5).toISOString();
    const { data: deals, error } = await service.from("deals")
      .select("id,lead_id,title,won_at").eq("stage", "ganado").gte("won_at", from).lte("won_at", to).limit(20);
    if (error) return json({ error: error.message }, 500);

    let sent = 0;
    for (const d of deals ?? []) {
      const { data: lead } = await service.from("leads").select("id,name,email,lang").eq("id", d.lead_id).maybeSingle();
      if (!lead || !lead.email) continue;
      const em = String(lead.email).toLowerCase();
      if (/@viven\.ch$|@entropia|@example\.|test/.test(em)) continue;                       // internos/test jamás
      // un pedido por persona: buscamos la nota-marcador
      const { data: prev } = await service.from("lead_notes").select("id").eq("lead_id", String(lead.id)).ilike("body", "%⭐ Pedido de reseña enviado%").limit(1);
      if (prev && prev.length) continue;
      const lang = (["en", "de", "es"].includes(lead.lang) ? lead.lang : "en") as "en" | "de" | "es";
      const first = (lead.name || "").split(/\s+/)[0] || "";
      const r = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: "Sebastian de Viven <info@viven.ch>",
          reply_to: "sebastian@viven.ch",
          to: [lead.email],
          subject: MAIL[lang].subject,
          html: MAIL[lang].html(first || (lang === "de" ? "" : lang === "es" ? "" : "there")),
        }),
      });
      if (!r.ok) continue;
      await service.from("lead_notes").insert({ lead_id: String(lead.id), author: "Sistema", body: "⭐ Pedido de reseña enviado (14 días post-won" + (d.title ? " · " + d.title : "") + ")" });
      sent++;
    }
    return json({ ok: true, candidates: (deals ?? []).length, sent });
  } catch (e) {
    console.error("FUNCTION_ERROR", String(e));
    return json({ error: String(e) }, 500);
  }
});
