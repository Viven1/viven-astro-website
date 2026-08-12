// Supabase Edge Function: deal-followup-later
// Barre deals en etapa "seguimiento_futuro" (Kanban: "no por ahora, pero sí más
// adelante") cuya fecha objetivo (follow_up_target_at) ya llegó, y arma UN
// draft con IA para retomar la conversación — mismo patrón que
// reactivation-engine: nunca se manda solo, va a la Bandeja de salida
// (outbox, kind='followup_later') a esperar aprobación humana.
//
// Idempotencia: deals.follow_up_drafted_at se marca al CREAR el draft (no al
// enviar) y no se resetea sola — setDealStage() en el dashboard SÍ la resetea
// si el humano vuelve a mover el deal a este stage con una fecha nueva.
//
// Cron: diario (SQL 0119). Deploy: supabase functions deploy deal-followup-later --no-verify-jwt
// Probar: curl -X POST .../functions/v1/deal-followup-later -H "Authorization: Bearer $CRON_SECRET" -d '{"dry_run":true}'

import { createClient } from "jsr:@supabase/supabase-js@2";

const service = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Content-Type": "application/json" } });

// "test" acotado (12 ago 2026): antes era la palabra suelta en cualquier posición
// y dejaba afuera EN SILENCIO direcciones reales — testimonios@empresa.ch,
// protest@, contest@. Ahora solo la casilla test@ o un dominio @test.*
const TEST = /@viven\.ch$|@entropia|@example\.|^test@|@test\./i;
const BILLING = /invoic|accounts?@|billing|rechnung|payable|ekonomi|brokering|buchhalt|kreditor|accounting|finance@|ap@/i;
const MAX_PER_RUN = 5;

type Lead = Record<string, unknown> & { id: number };
type Deal = { id: string; lead_id: number; title: string | null; stage: string; archived: boolean; follow_up_target_at: string | null; follow_up_reason: string | null; follow_up_drafted_at: string | null };

const langOf = (l: Lead) => (["en", "de", "es"].includes(String(l.lang)) ? String(l.lang) : "en");
const LANG_RULES: Record<string, string> = {
  de: "Swiss High German. STRICTLY formal Sie — NEVER du, NEVER the first name alone. Greeting: \"Guten Tag Herr <Nachname>,\" or \"Guten Tag Frau <Nachname>,\" ONLY if the gender is unambiguous from the first name; if in ANY doubt, greet with the full name. NEVER use ß — always ss.",
  es: "Español comercial neutro con voseo suave (podés, querés, tenés) — profesional y cercano. Saludo con nombre de pila (\"Hola <nombre>:\").",
  en: "English, professional but warm. First-name greeting is fine (\"Hi <first name>,\").",
};

function notifyDraft(id: string | number) {
  fetch(`${SB_URL}/functions/v1/outbox-notify`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") },
    body: JSON.stringify({ id }),
  }).catch(() => {});
}
function pushSummary(n: number) {
  fetch(`${SB_URL}/functions/v1/push-send`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") },
    body: JSON.stringify({ title: "🕓 Seguimientos futuros listos", body: `${n} borrador${n === 1 ? "" : "es"} de "seguimiento futuro" esperan tu aprobación.`, url: "/dashboard/?tab=sistema&sub=auto" }),
  }).catch(() => {});
}

async function aiDraft(lead: Lead, deal: Deal, brief: string): Promise<{ subject: string; body: string } | null> {
  const lang = langOf(lead);
  const sys = `You write as Sebastian Cepeda, founder of VIVEN AG, a video production company in Zürich (produced the first Swiss feature film on Netflix; clients include UBS, Siemens, Porsche, FIFA): direct, generous, entrepreneurial, zero hype.
Language: ${LANG_RULES[lang]}
Plain text only, 70-120 words, short paragraphs separated by \\n\\n, exactly ONE call to action, no bullet lists, no emojis, no multiple exclamation marks. Sign with "Sebastian" only. Never invent facts, prices or projects not present in the context. Internal CRM notes/reasons are background only — never quote them verbatim. Output ONLY a single valid minified JSON object {"subject":"...","body":"..."} — no markdown, no fences.`;
  const task = `TASK: We agreed with this contact to check back in around now — they said "not right now" before (see internal reason below, background only, don't quote it directly). Write a warm, low-pressure email asking if the timing has changed and if it makes sense to pick the conversation back up. Reference their original project idea if present in the context. CTA: a short reply or call to see where things stand.`;
  const lines = [`CONTACT: ${lead.name || ""} · company: ${lead.company || ""} · language: ${lang}`];
  if (deal.title) lines.push(`PROJECT DISCUSSED: "${deal.title}"`);
  if (deal.follow_up_reason) lines.push(`INTERNAL REASON THEY WEREN'T READY (background only, never quote): ${deal.follow_up_reason}`);
  if (lead.message) lines.push(`THEIR ORIGINAL INQUIRY: "${String(lead.message).slice(0, 800)}"`);
  if (brief) lines.push(`DEEP BRIEF (read in full):\n${brief.slice(0, 2000)}`);
  const ctx = lines.join("\n");

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 700, system: sys, messages: [{ role: "user", content: task + "\n\n" + ctx }] }),
  });
  if (!res.ok) { console.error("AI_DRAFT_FAIL", res.status, (await res.text()).slice(0, 200)); return null; }
  const data = await res.json();
  let text = ((data.content ?? []).filter((c: { type: string }) => c.type === "text").map((c: { text: string }) => c.text).join(" ")).trim();
  text = text.replace(/```json|```/g, "").trim();
  const first = text.indexOf("{"), last = text.lastIndexOf("}");
  if (first === -1 || last <= first) return null;
  text = text.slice(first, last + 1);
  try {
    const p = JSON.parse(text);
    if (!p.subject || !p.body) return null;
    if (lang === "de") { p.subject = String(p.subject).replaceAll("ß", "ss"); p.body = String(p.body).replaceAll("ß", "ss"); }
    return { subject: String(p.subject), body: String(p.body) };
  } catch { return null; }
}

// mismo criterio que pickDeepestBrief() del dashboard: preferir la fila con
// goal (brief real) sobre una fila-flag más nueva sin goal (ver ai-email-draft).
async function briefTextFor(lead: Lead): Promise<string> {
  let { data } = await service.from("briefs").select("*").eq("lead_id", String(lead.id)).order("created_at", { ascending: false }).limit(5);
  if ((!data || !data.length) && lead.email) ({ data } = await service.from("briefs").select("*").ilike("email", String(lead.email)).order("created_at", { ascending: false }).limit(5));
  const b = (data || []).find((x: { goal?: string }) => x && x.goal) || (data || [])[0];
  if (!b) return "";
  const a = b.answers || {};
  const li = (k: string, v: unknown) => { if (!v) return ""; const s = Array.isArray(v) ? v.join(", ") : String(v); return s.trim() ? `${k}: ${s}\n` : ""; };
  const fields = li("Objetivo", b.goal) + li("Audiencia", a.audience) + li("Dónde va a correr", b.distribution || a.distribution) +
    li("Presupuesto", b.budget) + li("Timing", b.timeline);
  const extra = b.extra && String(b.extra).trim() ? `SUS PROPIAS PALABRAS: "${String(b.extra).trim()}"\n\n` : "";
  return (extra + fields).trim();
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" } });
  const authHdr = req.headers.get("Authorization") ?? "";
  const isCron = !!CRON_SECRET && authHdr === `Bearer ${CRON_SECRET}`;
  if (!isCron) {
    const supabaseAuth = createClient(SB_URL, SB_ANON, { global: { headers: { Authorization: authHdr } } });
    const { data: { user } } = await supabaseAuth.auth.getUser();
    if (!user) return json({ error: "unauthorized" }, 401);
  }
  try {
    const body = await req.json().catch(() => ({}));
    const dryRun = !!body.dry_run;
    const nowIso = new Date().toISOString();

    const { data: deals, error: derr } = await service.from("deals")
      .select("id,lead_id,title,stage,archived,follow_up_target_at,follow_up_reason,follow_up_drafted_at")
      .eq("stage", "seguimiento_futuro").eq("archived", false)
      .lte("follow_up_target_at", nowIso).is("follow_up_drafted_at", null);
    if (derr) return json({ error: derr.message }, 500);
    if (!deals?.length) return json({ ok: true, msg: "sin vencimientos hoy", made: 0 });

    const ids = [...new Set((deals as Deal[]).map((d) => d.lead_id))];
    const { data: leads, error: lerr } = await service.from("leads").select("*").in("id", ids);
    if (lerr) return json({ error: lerr.message }, 500);
    const leadById = new Map<number, Lead>((leads ?? []).map((l: Lead) => [Number(l.id), l]));

    type Verdict = { lead_id: number; deal_id: string; email: string; skip: string | null };
    const report: Verdict[] = [];
    const ok: { lead: Lead; deal: Deal }[] = [];
    for (const deal of deals as Deal[]) {
      const lead = leadById.get(deal.lead_id);
      if (!lead) continue;
      let skip: string | null = null;
      if (!lead.email) skip = "sin email";
      else if (TEST.test(String(lead.email))) skip = "email interno/test";
      else if (BILLING.test(String(lead.email))) skip = "casilla de facturación";
      else if (lead.unsubscribed) skip = "dado de baja";
      report.push({ lead_id: deal.lead_id, deal_id: deal.id, email: String(lead.email || ""), skip });
      if (!skip) ok.push({ lead, deal });
    }

    if (dryRun) return json({ ok: true, dry_run: true, candidates: report, would_draft: ok.slice(0, MAX_PER_RUN).map((c) => c.lead.email) });

    const made: { email: string; outbox_id: string }[] = [];
    for (const { lead, deal } of ok.slice(0, MAX_PER_RUN)) {
      try {
        const brief = await briefTextFor(lead);
        const draft = await aiDraft(lead, deal, brief);
        if (!draft) { console.error("DRAFT_NULL", deal.id); continue; }
        // flag primero (idempotencia dura), igual que reactivation-engine
        const { error: flagErr } = await service.from("deals").update({ follow_up_drafted_at: new Date().toISOString() }).eq("id", deal.id).is("follow_up_drafted_at", null);
        if (flagErr) { console.error("FLAG_ERROR", String(flagErr.message)); continue; }
        const { data: ob, error: obErr } = await service.from("outbox").insert({
          lead_id: lead.id, kind: "followup_later", sender: "sebastian",
          subject: draft.subject, body: draft.body, status: "pending",
        }).select("id").single();
        if (obErr) { console.error("OUTBOX_ERROR", String(obErr.message)); continue; }
        await service.from("lead_notes").insert({
          lead_id: String(lead.id), author: "Sistema",
          body: `🕓 Llegó la fecha de seguimiento futuro${deal.title ? ` («${deal.title}»)` : ""} — draft creado, esperando aprobación en la Bandeja de salida.`,
        }).then(() => {}, () => {});
        notifyDraft(ob.id);
        made.push({ email: String(lead.email), outbox_id: String(ob.id) });
        await new Promise((r) => setTimeout(r, 150));
      } catch (e) { console.error("CANDIDATE_ERROR", deal.id, String(e)); }
    }
    if (made.length) pushSummary(made.length);
    return json({ ok: true, made: made.length, drafts: made, skipped: report.filter((r) => r.skip) });
  } catch (e) {
    console.error("FUNCTION_ERROR", String(e));
    return json({ error: String(e) }, 500);
  }
});
