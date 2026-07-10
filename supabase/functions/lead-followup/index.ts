// Supabase Edge Function: lead-followup
// La invoca pg_cron una vez al día. Busca leads con follow-up vencido, manda
// un digest a info@viven.ch (con borrador de IA opcional) y reprograma la cadencia.
//
// Deploy:  supabase functions deploy lead-followup --no-verify-jwt
// Secrets: RESEND_API_KEY, ANTHROPIC_API_KEY (opcional), SUPABASE_SERVICE_ROLE_KEY, CRON_SECRET
// Cron:    ver 0001_followup_and_analytics.sql (sección 3)

import { createClient } from "jsr:@supabase/supabase-js@2";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TO = "info@viven.ch";
const FROM = "Viven Leads <leads@viven.ch>";
const OFFSETS = [2, 4, 7, 14, 44, 74]; // debe coincidir con followup_offsets() del SQL
const esc = (s: unknown) => String(s ?? "").replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]!));

async function aiDraft(lead: Record<string, unknown>): Promise<string> {
  if (!ANTHROPIC_API_KEY) return "";
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 300,
        messages: [{
          role: "user",
          content: `Escribí un follow-up breve (máx 80 palabras) en ${lead.lang === "de" ? "alemán" : lead.lang === "en" ? "inglés" : "español"} para ${lead.first_name || "el lead"} de Viven (productora de video, Zúrich). Mensaje original: "${lead.message || "sin mensaje"}". CTA: agendar 15 min. Solo el cuerpo.`,
        }],
      }),
    });
    if (!res.ok) return "";
    const d = await res.json();
    return (d.content?.[0]?.text ?? "").trim();
  } catch { return ""; }
}

Deno.serve(async (req) => {
  // seguridad: solo el cron con el token correcto
  if (CRON_SECRET && req.headers.get("Authorization") !== `Bearer ${CRON_SECRET}`) {
    return new Response("forbidden", { status: 403 });
  }
  const sb = createClient(SB_URL, SERVICE_KEY);
  const nowIso = new Date().toISOString();

  const { data: due, error } = await sb
    .from("leads")
    .select("*")
    .lte("next_follow_up_at", nowIso)
    .not("next_follow_up_at", "is", null)
    .in("status", ["contacted", "contactado"])
    .order("next_follow_up_at", { ascending: true });
  if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  if (!due?.length) return new Response(JSON.stringify({ ok: true, due: 0 }));

  // armar digest + reprogramar cada lead
  const blocks: string[] = [];
  for (const l of due) {
    const draft = await aiDraft(l);
    const nextIdx = (l.follow_up_count ?? 0) + 1;
    const nextOff = OFFSETS[Math.min(nextIdx, OFFSETS.length - 1)];
    const next = nextIdx >= OFFSETS.length ? null : new Date(Date.now() + nextOff * 864e5).toISOString();
    await sb.from("leads").update({
      follow_up_count: nextIdx,
      last_followup_sent_at: nowIso,
      next_follow_up_at: next,
    }).eq("id", l.id);

    blocks.push(`<div style="border-top:1px solid #eee;padding:12px 0">
      <strong>${esc(l.name || l.first_name)}</strong> · ${esc(l.email)} · follow-up #${nextIdx}<br>
      <span style="color:#667">Mensaje original:</span> ${esc(l.message || "—")}
      ${draft ? `<div style="background:#f6f8f4;border-radius:8px;padding:10px;margin-top:8px;white-space:pre-wrap">${esc(draft)}</div>` : ""}
    </div>`);
  }

  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: FROM, to: [TO],
      subject: `⏰ ${due.length} follow-up${due.length > 1 ? "s" : ""} pendiente${due.length > 1 ? "s" : ""} hoy`,
      html: `<h2 style="font-family:sans-serif">Follow-ups de hoy</h2>${blocks.join("")}
        <p style="font-family:sans-serif;font-size:13px"><a href="https://www.viven.ch/dashboard/">Abrir dashboard →</a></p>`,
    }),
  });

  return new Response(JSON.stringify({ ok: true, due: due.length }), { headers: { "Content-Type": "application/json" } });
});
