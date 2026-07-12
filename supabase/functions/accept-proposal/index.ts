// Supabase Edge Function: accept-proposal
// El cliente acepta la propuesta desde la página pública. Valida password, marca
// status=accepted con la selección (tier + add-ons + total) y avisa a Viven por email.
//
// Deploy:  supabase functions deploy accept-proposal --no-verify-jwt
// Secret:  RESEND_API_KEY (ya seteado)

import { createClient } from "jsr:@supabase/supabase-js@2";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const { slug, password, name, email, tier, addons, total, agreed_terms } = await req.json();
    if (!slug || !name || !email) return json({ error: "faltan datos (name, email)" }, 400);
    if (!agreed_terms) return json({ error: "hay que aceptar los términos" }, 400);
    const admin = createClient(SB_URL, SERVICE);
    const { data, error } = await admin.from("proposals").select("*").eq("slug", slug).maybeSingle();
    if (error) return json({ error: error.message });
    if (!data) return json({ error: "not_found" }, 404);
    if (data.password && String(password || "") !== String(data.password)) return json({ error: "wrong_password" }, 401);
    if (data.status === "accepted") return json({ ok: true, already: true });

    // rastro mínimo de auditoría de la firma: IP best-effort (proxy delante en
    // Supabase Edge Functions) — no bloquea el accept si no viene ningún header
    const signedIp = (req.headers.get("cf-connecting-ip") || req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || null;

    const upd = await admin.from("proposals").update({
      status: "accepted",
      accepted_at: new Date().toISOString(),
      accepted_name: String(name).slice(0, 120),
      accepted_email: String(email).slice(0, 160),
      accepted_tier: tier ? String(tier).slice(0, 120) : null,
      accepted_addons: Array.isArray(addons) ? addons : null,
      accepted_total: Number(total) || null,
      signed_ip: signedIp,
      agreed_terms: true,
    }).eq("id", data.id);
    if (upd.error) return json({ error: upd.error.message });

    // sincronizar TODO — modelo DEALS: gana el DEAL de esta propuesta (los otros
    // proyectos de la persona no se tocan) + sus ofertas; espejo en la persona.
    const nowIso = new Date().toISOString();
    let dealScoped = false;
    if (data.deal_id) {
      try {
        await admin.from("deals").update({ stage: "ganado", won_at: nowIso, last_stage_at: nowIso }).eq("id", data.deal_id);
        await admin.from("offers").update({ status: "won" }).eq("deal_id", data.deal_id).in("status", ["draft", "sent"]);
        dealScoped = true;
      } catch (_e) { /* tabla deals sin migrar → legado */ }
    }
    // OFERTAS-PAQUETE (status 'tier', ligadas por tier.offer_id en el content):
    // la elegida por el cliente pasa a GANADA (con sus posiciones exactas);
    // los paquetes hermanos se ARCHIVAN — cero ruido en los números.
    try {
      const tiers = (data.content && Array.isArray(data.content.tiers)) ? data.content.tiers : [];
      const winner = tiers.find((t: { name?: string; offer_id?: number }) => t.offer_id && tier && String(t.name || "").trim() === String(tier).trim());
      for (const t of tiers) {
        if (!t.offer_id) continue;
        if (winner && t.offer_id === winner.offer_id) {
          await admin.from("offers").update({ status: "won", archived: false }).eq("id", t.offer_id);
        } else {
          await admin.from("offers").update({ archived: true }).eq("id", t.offer_id).eq("status", "tier");
        }
      }
    } catch (_e) { /* sin content.tiers → nada que hacer */ }
    if (data.lead_id) {
      const { data: lead } = await admin.from("leads").select("won_at").eq("id", data.lead_id).maybeSingle();
      const patch: Record<string, unknown> = { status: "ganado", last_stage_at: nowIso };
      if (!lead?.won_at) patch.won_at = nowIso;
      const { error: le } = await admin.from("leads").update(patch).eq("id", data.lead_id);
      if (le) await admin.from("leads").update({ status: "ganado" }).eq("id", data.lead_id);   // columnas nuevas sin migrar
      if (!dealScoped) await admin.from("offers").update({ status: "won" }).eq("lead_id", String(data.lead_id)).in("status", ["draft", "sent"]);
    }

    // avisar a Viven (best-effort)
    if (RESEND_API_KEY) {
      const body = `✅ Propuesta ACEPTADA\n\n` +
        `Propuesta: ${data.title || slug}\n` +
        `Cliente: ${name} <${email}>\n` +
        (tier ? `Paquete: ${tier}\n` : "") +
        (total ? `Total: CHF ${Number(total).toLocaleString("de-CH")}\n` : "") +
        (Array.isArray(addons) && addons.length ? `Add-ons: ${addons.join(", ")}\n` : "");
      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Authorization": `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: "Viven Propuestas <leads@viven.ch>",
          to: ["info@viven.ch"],
          reply_to: email,
          subject: `✅ Propuesta aceptada — ${data.title || slug}`,
          text: body,
        }),
      }).catch(() => {});
    }
    return json({ ok: true });
  } catch (e) {
    return json({ error: String(e) });
  }
});
