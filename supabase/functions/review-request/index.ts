// Supabase Edge Function: review-request
// DOS modos — el cliente NUNCA recibe nada en automático:
// · CRON (body {}): deals ganados hace ~14 días → crea una TASK "⭐ ¿Pedimos
//   reseña?" en el contacto + push al team. VOS decidís cuándo (proyecto entregado).
// · BOTÓN (body {lead_id}, requiere sesión): manda el email de reseña AHORA a esa
//   persona, en su idioma, y lo registra como nota. Un solo envío por persona.
//
// Deploy:   supabase functions deploy review-request --no-verify-jwt
// Schedule: SQL 0033. Secrets: RESEND_API_KEY. Opcional: REVIEW_LINK (link directo GBP).

import { createClient } from "jsr:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const service = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const REVIEW_LINK = Deno.env.get("REVIEW_LINK") || "https://www.google.com/maps/search/?api=1&query=Viven+AG+Zeughausstrasse+31+Z%C3%BCrich";
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Content-Type": "application/json" } });

const MAIL = {
  en: { subject: "How was working with Viven? 🌟", html: (n: string) => `<p>Hi ${n},</p><p>It was a pleasure producing your video — we hope it's already working hard for you.</p><p>If you have 60 seconds, a short Google review would mean a lot to our small team (and helps other companies find us):</p><p><a href="${REVIEW_LINK}" style="display:inline-block;background:#ddf98f;color:#1c2508;font-weight:700;padding:12px 22px;border-radius:100px;text-decoration:none">⭐ Leave a quick review</a></p><p>Thank you — and see you on the next project!<br>Sebastian &amp; the Viven team</p>` },
  de: { subject: "Wie war die Zusammenarbeit mit Viven? 🌟", html: (n: string) => `<p>Guten Tag ${n},</p><p>Es war uns eine Freude, Ihr Video zu produzieren — wir hoffen, es arbeitet bereits fleissig für Sie.</p><p>Wenn Sie 60 Sekunden haben: Eine kurze Google-Bewertung würde unserem kleinen Team enorm helfen:</p><p><a href="${REVIEW_LINK}" style="display:inline-block;background:#ddf98f;color:#1c2508;font-weight:700;padding:12px 22px;border-radius:100px;text-decoration:none">⭐ Kurze Bewertung schreiben</a></p><p>Herzlichen Dank — bis zum nächsten Projekt!<br>Sebastian &amp; das Viven-Team</p>` },
  es: { subject: "¿Cómo fue trabajar con Viven? 🌟", html: (n: string) => `<p>Hola ${n}:</p><p>Fue un placer producir tu video — esperamos que ya esté trabajando duro para vos.</p><p>Si tenés 60 segundos, una reseña corta en Google ayuda muchísimo a nuestro equipo:</p><p><a href="${REVIEW_LINK}" style="display:inline-block;background:#ddf98f;color:#1c2508;font-weight:700;padding:12px 22px;border-radius:100px;text-decoration:none">⭐ Dejar una reseña</a></p><p>¡Gracias — y hasta el próximo proyecto!<br>Sebastian y el equipo de Viven</p>` },
};
const isInternal = (em: string) => /@viven\.ch$|@entropia|@example\.|test/.test(em.toLowerCase());

async function pushAll(title: string, body: string, url: string) {
  const pub = Deno.env.get("VAPID_PUBLIC_KEY"), priv = Deno.env.get("VAPID_PRIVATE_KEY");
  if (!pub || !priv) return;
  webpush.setVapidDetails("mailto:info@viven.ch", pub, priv);
  const { data: subs } = await service.from("push_subscriptions").select("*");
  const payload = JSON.stringify({ title, body, url });
  for (const s of subs ?? []) {
    try { await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload); }
    catch (e) { const c = (e as { statusCode?: number }).statusCode; if (c === 404 || c === 410) await service.from("push_subscriptions").delete().eq("id", s.id); }
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" } });
  try {
    const body = await req.json().catch(() => ({}));

    // ---------- MODO BOTÓN: enviar AHORA a un lead (requiere usuario logueado) ----------
    if (body.lead_id) {
      const auth = req.headers.get("Authorization") ?? "";
      const supa = createClient(SB_URL, SB_ANON, { global: { headers: { Authorization: auth } } });
      const { data: { user } } = await supa.auth.getUser();
      if (!user) return json({ error: "unauthorized" }, 401);
      if (!RESEND_API_KEY) return json({ error: "falta RESEND_API_KEY" }, 500);
      const { data: lead } = await service.from("leads").select("id,name,email,lang").eq("id", body.lead_id).maybeSingle();
      if (!lead || !lead.email) return json({ error: "lead sin email" }, 400);
      if (isInternal(lead.email)) return json({ error: "email interno/test — no se envía" }, 400);
      const { data: prev } = await service.from("lead_notes").select("id").eq("lead_id", String(lead.id)).ilike("body", "%⭐ Pedido de reseña ENVIADO%").limit(1);
      if (prev && prev.length && !body.force) return json({ error: "ya se le pidió reseña a esta persona (mandá force:true para repetir)" }, 409);
      const lang = (["en", "de", "es"].includes(lead.lang) ? lead.lang : "en") as "en" | "de" | "es";
      const first = (lead.name || "").split(/\s+/)[0] || (lang === "en" ? "there" : "");
      const r = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: "Sebastian de Viven <info@viven.ch>", reply_to: "sebastian@viven.ch", to: [lead.email], subject: MAIL[lang].subject, html: MAIL[lang].html(first) }),
      });
      if (!r.ok) return json({ error: "Resend " + r.status }, 500);
      await service.from("lead_notes").insert({ lead_id: String(lead.id), author: "Sistema", body: "⭐ Pedido de reseña ENVIADO a " + lead.email });
      return json({ ok: true, sent_to: lead.email, lang });
    }

    // ---------- MODO CRON: recordarnos a NOSOTROS (task + push), jamás al cliente ----------
    const from = new Date(Date.now() - 15 * 864e5).toISOString();
    const to = new Date(Date.now() - 13 * 864e5).toISOString();
    const { data: deals, error } = await service.from("deals")
      .select("id,lead_id,title,won_at").eq("stage", "ganado").gte("won_at", from).lte("won_at", to).limit(20);
    if (error) return json({ error: error.message }, 500);
    let created = 0;
    const today = new Date().toLocaleString("sv-SE", { timeZone: "Europe/Zurich" }).slice(0, 10);
    for (const d of deals ?? []) {
      const { data: lead } = await service.from("leads").select("id,name,email").eq("id", d.lead_id).maybeSingle();
      if (!lead || !lead.email || isInternal(lead.email)) continue;
      const { data: prevT } = await service.from("lead_tasks").select("id").eq("lead_id", String(lead.id)).ilike("title", "%⭐ ¿Pedimos reseña%").limit(1);
      if (prevT && prevT.length) continue;
      const who = lead.name || lead.email;
      await service.from("lead_tasks").insert({
        lead_id: lead.id,
        title: "⭐ ¿Pedimos reseña a " + who + "? (ganado hace 2 semanas — mandala desde su ficha cuando el proyecto esté ENTREGADO)",
        due_date: today, done: false, reminded: true,
      });
      await pushAll("⭐ ¿Pedimos reseña a " + who + "?", "El deal se ganó hace 2 semanas. Si el proyecto ya se entregó, mandá el pedido desde su ficha — botón ⭐.", "/dashboard/?lead=" + lead.id);
      created++;
    }
    return json({ ok: true, candidates: (deals ?? []).length, reminders: created });
  } catch (e) {
    console.error("FUNCTION_ERROR", String(e));
    return json({ error: String(e) }, 500);
  }
});
