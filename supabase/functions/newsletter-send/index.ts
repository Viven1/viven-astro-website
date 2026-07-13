// Supabase Edge Function: newsletter-send
// Envía una campaña de newsletter al segmento elegido (estado × idioma) vía
// Resend. Reglas duras: nunca a dados de baja, nunca a emails de test, dedupe
// por email. Modo test: { id, test_to } manda SOLO a esa dirección.
//
// Deploy:  supabase functions deploy newsletter-send --no-verify-jwt
// Usa:     RESEND_API_KEY (ya seteado), SERVICE_ROLE para leer leads.

import { createClient } from "jsr:@supabase/supabase-js@2";

const service = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const RESEND = Deno.env.get("RESEND_API_KEY")!;
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

async function unsubToken(id: string | number): Promise<string> {
  const data = new TextEncoder().encode(String(id) + "|" + RESEND.slice(0, 24));
  const h = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 24);
}

const esc = (x: string) => String(x || "").replace(/&/g, "&amp;").replace(/</g, "&lt;");
function bodyHtml(text: string): string {
  return String(text || "").trim().split(/\n{2,}/).map((par) => {
    const withLinks = esc(par).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" style="color:#5b7cfa">$1</a>').replace(/\n/g, "<br>");
    return `<p style="margin:0 0 16px;font-size:15px;line-height:1.65;color:#222">${withLinks}</p>`;
  }).join("");
}

const UNSUB_LABEL: Record<string, string> = { en: "Unsubscribe", de: "Abmelden", es: "Darse de baja" };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const auth = req.headers.get("Authorization") ?? "";
    const supabase = createClient(SB_URL, SB_ANON, { global: { headers: { Authorization: auth } } });
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return json({ error: "unauthorized" }, 401);

    const { id, test_to, mark_sent } = await req.json();
    if (!id) return json({ error: "falta id" }, 400);
    const { data: nl } = await service.from("newsletters").select("*").eq("id", id).maybeSingle();
    if (!nl) return json({ error: "newsletter no encontrada" }, 404);
    if (nl.status === "sent" && !test_to) return json({ error: "esta campaña ya fue enviada" }, 400);
    // envío real a UNA persona (mark_sent) — se registra igual que un envío completo,
    // para no perder rastro ni permitir remandar el mismo borrador a todo el segmento
    // por error. El self-test rápido ("Test a mi email") NO manda mark_sent y sigue
    // sin dejar rastro, como siempre.
    const trackThis = !test_to || mark_sent;

    // destinatarios
    const TEST = /@viven\.ch$|@entropia|@example\.|test/i;
    const isWon = (st: string) => /ganado|won|cerrado/i.test(st || "");
    const isOut = (st: string) => /spam|descartado/i.test(st || "");
    let recips: { id?: number; email: string; name?: string; lang?: string }[] = [];
    if (test_to) {
      // si el email coincide con un lead real, usamos su id/lang → link de baja
      // funcional en vez del fallback a la home (que no da forma de darse de baja)
      const { data: matchLead } = await service.from("leads").select("id,lang").ilike("email", String(test_to)).maybeSingle();
      recips = [{ email: String(test_to), id: matchLead?.id, lang: matchLead?.lang }];
    } else {
      let q = await service.from("leads").select("id,email,name,first_name,status,lang,unsubscribed").not("email", "is", null);
      if (q.error && /column/.test(q.error.message || "")) q = await service.from("leads").select("id,email,name,first_name,status,lang").not("email", "is", null);
      const seen = new Set<string>();
      for (const r of (q.data ?? []) as Record<string, string | number | boolean>[]) {
        const em = String(r.email || "").toLowerCase().trim();
        if (!em || seen.has(em) || TEST.test(em)) continue;
        if ((r as { unsubscribed?: boolean }).unsubscribed) continue;
        const st = String(r.status || "");
        if (isOut(st)) continue;
        if (nl.segment_stage === "won" && !isWon(st)) continue;
        if (nl.segment_stage === "open" && isWon(st)) continue;
        if (nl.segment_lang !== "all" && String(r.lang || "en") !== nl.segment_lang) continue;
        if ((nl.exclude_ids || []).includes(r.id)) continue;   // sacado a mano en "Ver destinatarios"
        seen.add(em);
        recips.push({ id: r.id as number, email: em, name: String((r as { first_name?: string }).first_name || String(r.name || "").split(" ")[0] || ""), lang: String(r.lang || "en") });
      }
      // agregados a mano en "Ver destinatarios" — no tienen que estar en el segmento
      for (const raw of (nl.extra_emails || []) as string[]) {
        const em = String(raw || "").toLowerCase().trim();
        if (!em || seen.has(em) || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) continue;
        seen.add(em);
        const { data: matchLead } = await service.from("leads").select("id,first_name,name,lang").ilike("email", em).maybeSingle();
        recips.push({ id: matchLead?.id, email: em, name: String(matchLead?.first_name || String(matchLead?.name || "").split(" ")[0] || ""), lang: String(matchLead?.lang || "en") });
      }
    }
    if (!recips.length) return json({ error: "el segmento quedó vacío (0 destinatarios)" }, 400);

    const html = bodyHtml(nl.body);
    let sent = 0, failed = 0;
    for (const r of recips) {
      const lang = r.lang || "en";
      const tok = r.id != null ? await unsubToken(r.id) : "";
      const unsub = r.id != null ? `${SB_URL}/functions/v1/newsletter-unsub?l=${r.id}&t=${tok}` : "https://www.viven.ch";
      const full = `<!doctype html><body style="margin:0;background:#f4f5f7;font-family:Helvetica,Arial,sans-serif">
<div style="max-width:600px;margin:0 auto;padding:28px 16px">
  <div style="background:#0f1826;border-radius:14px 14px 0 0;padding:18px 26px"><img src="https://www.viven.ch/assets/brand/viven-logo-email.png" alt="VIVEN" height="24" style="height:24px;width:auto;display:block" /></div>
  <div style="background:#ffffff;border-radius:0 0 14px 14px;padding:30px 26px">
    ${r.name ? `<p style="margin:0 0 16px;font-size:15px;color:#222">Hi ${esc(r.name)},</p>` : ""}
    ${html}
    <p style="margin:22px 0 0;font-size:14px;color:#444">— Sofia, VIVEN AG</p>
  </div>
  <p style="text-align:center;font-size:11.5px;color:#9aa;margin-top:16px">VIVEN AG · Zürich · <a href="https://www.viven.ch" style="color:#9aa">viven.ch</a> · <a href="${unsub}" style="color:#9aa">${UNSUB_LABEL[lang] || UNSUB_LABEL.en}</a></p>
</div></body>`;
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: "Bearer " + RESEND, "Content-Type": "application/json" },
        body: JSON.stringify({ from: "Sofia — VIVEN <info@viven.ch>", reply_to: "sofia@viven.ch", to: [r.email], subject: nl.subject, html: full }),
      });
      if (res.ok) { sent++; if (trackThis) await service.from("newsletter_sends").insert({ newsletter_id: id, lead_id: r.id ?? null, email: r.email }); }
      else { failed++; console.error("RESEND_FAIL", r.email, res.status, (await res.text()).slice(0, 120)); }
      if (recips.length > 8) await new Promise((ok) => setTimeout(ok, 150));   // suave con el rate limit
    }
    if (trackThis) await service.from("newsletters").update({ status: "sent", sent_at: new Date().toISOString(), sent_count: sent, updated_at: new Date().toISOString() }).eq("id", id);
    return json({ ok: true, sent, failed, test: !!test_to });
  } catch (e) {
    console.error("FUNCTION_ERROR", String(e));
    return json({ error: String(e) }, 500);
  }
});
