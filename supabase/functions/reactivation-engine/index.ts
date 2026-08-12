// Supabase Edge Function: reactivation-engine
// MOTOR DE REACTIVACIÓN por email — dos vertientes, cron semanal (lunes 06:30 UTC,
// SQL 0113). Los drafts NUNCA se envían solos: van a la Bandeja de salida
// (outbox, kind='reactivation') y esperan aprobación humana en el dashboard,
// con aviso por email (outbox-notify) + push. El envío real lo hace el mismo
// pipeline de siempre (automations-run sección 3 / outbox-action), que ya
// respeta horario laboral suizo y bajas.
//
//   (a) GANADOS  (category='won')  — clientes con deal ganado cuyo ÚLTIMO
//       proyecto terminó hace 6+ meses y sin ningún deal abierto hoy →
//       draft personalizado que referencia el proyecto anterior concreto
//       (título del deal + propuesta aceptada) y propone retomar.
//   (b) PERDIDOS (category='lost') — deals perdidos hace 60–90 días → UN
//       email suave único ("¿retomamos la conversación?" + una novedad real
//       de VIVEN). Nunca más de uno por contacto, jamás.
//
// Idempotencia (regla innegociable): leads.reactivation_drafted_at se marca
// al CREAR el draft (no al enviar) y nunca se resetea solo — un contacto
// recibe como máximo UN intento de reactivación en su vida, aunque el draft
// se descarte. Cinturón y tiradores: además se chequea que no exista ya un
// outbox row kind='reactivation' para ese lead.
//
// IA: claude-sonnet-5. OJO: este modelo NO soporta prefill de assistant —
// messages termina en user y el JSON se parsea recortando desde la primera "{".
//
// Deploy:   supabase functions deploy reactivation-engine --no-verify-jwt
// Schedule: SQL 0113 (cron lunes 06:30 UTC ≈ 08:30 CH verano).
// Probar:   curl -X POST .../functions/v1/reactivation-engine \
//             -H "Authorization: Bearer $CRON_SECRET" -d '{"dry_run":true}'
//           (dry_run lista candidatos sin gastar IA ni crear drafts)

import { createClient } from "jsr:@supabase/supabase-js@2";

const service = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Content-Type": "application/json" } });

// mismos frenos que el resto de los motores del repo
// "test" acotado (12 ago 2026): antes era la palabra suelta en cualquier posición
// y dejaba afuera EN SILENCIO direcciones reales — testimonios@empresa.ch,
// protest@, contest@. Ahora solo la casilla test@ o un dominio @test.*
const TEST = /@viven\.ch$|@entropia|@example\.|^test@|@test\./i;
// casillas de facturación/contabilidad (frecuentes en el import de Bexio):
// jamás mandarles un email comercial cálido — nadie humano de decisión lo lee
const BILLING = /invoic|accounts?@|billing|rechnung|payable|ekonomi|brokering|buchhalt|kreditor|accounting|finance@|ap@/i;
const DAY = 864e5;
const WON_DORMANT_DAYS = 183;      // 6 meses sin proyecto nuevo
const WON_MAX_AGE_DAYS = 1095;     // >3 años sin facturar: email probablemente muerto
                                   // (contactos Bexio viejos suelen ser de pago, no
                                   // la persona real) — mandar ahí = rebotes que
                                   // dañan la reputación del dominio. Esos quedan
                                   // como archivo en Personas, reactivación manual.
const LOST_MIN_DAYS = 60;          // ventana de rescate: perdido hace 60–90 días
const LOST_MAX_DAYS = 90;
const ACTIVE_REPLY_DAYS = 90;      // respondió hace <90d = conversación viva, robots afuera
const RECENT_AUTO_DAYS = 14;       // ya le salió un email automático hace <14d → esta corrida no
const MAX_PER_VERTICAL = 3;        // corrida semanal: máx 3+3 drafts, no saturar la bandeja

type Lead = Record<string, unknown> & { id: number };
type Deal = { id: string; lead_id: number; title: string | null; stage: string; archived: boolean; won_at: string | null; lost_at: string | null; lost_reason: string | null };

const OPEN_STAGES = ["nuevo", "contactado", "videocall", "propuesta"];
const langOf = (l: Lead) => (["en", "de", "es"].includes(String(l.lang)) ? String(l.lang) : "en");
const fmtDate = (iso: string, lang: string) =>
  new Date(iso).toLocaleDateString(lang === "de" ? "de-CH" : lang === "es" ? "es-ES" : "en-GB", { month: "long", year: "numeric", timeZone: "Europe/Zurich" });

// -------------------------------------------------------------------------
// aviso de draft nuevo: email al remitente (outbox-notify, por draft) + UN
// push agregado al final de la corrida (push-send). Mismo par de vías que
// automations-run. Best-effort: si fallan, el draft ya quedó pendiente igual.
// -------------------------------------------------------------------------
function notifyDraft(id: string | number) {
  fetch(`${SB_URL}/functions/v1/outbox-notify`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") },
    body: JSON.stringify({ id }),
  }).catch(() => {});
}
function pushSummary(nWon: number, nLost: number) {
  const parts = [nWon ? `${nWon} de clientes ganados` : "", nLost ? `${nLost} de leads perdidos` : ""].filter(Boolean).join(" y ");
  fetch(`${SB_URL}/functions/v1/push-send`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") },
    body: JSON.stringify({ title: "♻️ Drafts de reactivación listos", body: `${parts} esperan tu aprobación en la Bandeja de salida.`, url: "/dashboard/?tab=sistema&sub=auto" }),
  }).catch(() => {});
}

// -------------------------------------------------------------------------
// novedades REALES de VIVEN para el email de rescate: últimos posts
// PUBLICADOS del blog en el idioma del lead — material verificable, nada
// inventado. Si no hay ninguno en su idioma, se cae a EN.
// -------------------------------------------------------------------------
async function recentNews(lang: string): Promise<{ title: string; url: string }[]> {
  const q = async (lg: string) => {
    const { data } = await service.from("blogs").select("title,slug,lang,published_url,published_at")
      .eq("status", "published").eq("lang", lg).order("published_at", { ascending: false }).limit(3);
    return data ?? [];
  };
  let rows = await q(lang);
  if (!rows.length && lang !== "en") rows = await q("en");
  return rows.map((b) => ({ title: String(b.title || ""), url: String(b.published_url || `https://www.viven.ch/${b.lang}/blog/${b.slug}/`) }));
}

// -------------------------------------------------------------------------
// generación IA — claude-sonnet-5, SIN prefill de assistant (no lo soporta):
// messages termina en user; el JSON se recorta desde la primera "{" hasta la
// última "}" y se limpian fences ```json.
// -------------------------------------------------------------------------
const LANG_RULES: Record<string, string> = {
  de: "Swiss High German. STRICTLY formal Sie — NEVER du, NEVER the first name alone. Greeting: \"Guten Tag Herr <Nachname>,\" or \"Guten Tag Frau <Nachname>,\" ONLY if the gender is unambiguous from the first name; if in ANY doubt, greet with the full name: \"Guten Tag <Vorname Nachname>,\". NEVER use ß — always ss (Strasse, gross, heisst).",
  es: "Español comercial neutro con voseo suave (podés, querés, tenés) — profesional y cercano, sin jerga rioplatense ni exceso de confianza. Saludo con nombre de pila (\"Hola <nombre>:\").",
  en: "English, professional but warm. First-name greeting is fine (\"Hi <first name>,\").",
};
async function aiDraft(kind: "won" | "lost", lead: Lead, context: string): Promise<{ subject: string; body: string } | null> {
  const lang = langOf(lead);
  const sys = `You write as Sebastian Cepeda, founder of VIVEN AG, a video production company in Zürich (produced the first Swiss feature film on Netflix; clients include UBS, Siemens, Porsche, FIFA): direct, generous, entrepreneurial, zero hype.
Language: ${LANG_RULES[lang]}
Plain text only, 80-140 words, short paragraphs separated by \\n\\n, exactly ONE call to action, no bullet lists, no emojis, no multiple exclamation marks. Sign with "Sebastian" only. NEVER invent facts, projects, numbers or news not present in the context. Internal CRM notes in the context are background only — never quote or reveal them.
Output ONLY a single valid minified JSON object {"subject":"...","body":"..."} — no markdown, no fences, no commentary.`;
  const task = kind === "won"
    ? `TASK: Re-engagement email to a PAST CLIENT we already delivered a project for. Reference the concrete previous project (what we produced, for which brand/company — use the real project data below). Warmly propose picking things up again: a follow-up, an update of the existing video, or a new project for this year. Low pressure, high familiarity — we know each other. CTA: a short call or reply to exchange ideas.`
    : `TASK: ONE soft, single win-back email to a lead whose deal went cold/lost 2-3 months ago. Tone: door stays open, zero pressure, no guilt. Ask if it makes sense to pick the conversation back up ("¿retomamos la conversación?" energy), briefly mention ONE real piece of VIVEN news from the context below (a recent article or simply that we would love to hear where their project stands). Make clear this is a one-off, we are not going to chase them. CTA: reply if the timing is better now.`;
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 800,
      system: sys,
      // claude-sonnet-5: sin prefill — el array TERMINA en user
      messages: [{ role: "user", content: task + "\n\n" + context }],
    }),
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
    if (langOf(lead) === "de") { // Schweizer Hochdeutsch garantizado por código, no solo por prompt
      p.subject = String(p.subject).replaceAll("ß", "ss");
      p.body = String(p.body).replaceAll("ß", "ss");
    }
    return { subject: String(p.subject), body: String(p.body) };
  } catch { return null; }
}

// contexto del contacto para la IA (won: proyecto + propuesta; lost: deal + motivo)
async function contextFor(kind: "won" | "lost", lead: Lead, deal: Deal, news: { title: string; url: string }[]): Promise<string> {
  const lang = langOf(lead);
  const lines: string[] = [
    `CONTACT: ${lead.name || ""} · company: ${lead.company || ""} · language: ${lang}`,
  ];
  if (kind === "won") {
    lines.push(`PREVIOUS PROJECT (won deal): "${deal.title || "video project"}" — delivered/won in ${deal.won_at ? fmtDate(deal.won_at, "en") : "the past"} (over 6 months ago).`);
    // propuesta aceptada/enviada del deal (o del lead) — el "qué se hizo" concreto
    let { data: props } = await service.from("proposals").select("title,content,status,accepted_tier").eq("deal_id", deal.id).order("created_at", { ascending: false }).limit(1);
    if (!props?.length) ({ data: props } = await service.from("proposals").select("title,content,status,accepted_tier").eq("lead_id", String(lead.id)).order("created_at", { ascending: false }).limit(1));
    const pr = props?.[0];
    if (pr) {
      const c = (pr.content ?? {}) as Record<string, unknown>;
      const bits = ["intro", "overview", "scope"].map((k) => (typeof c[k] === "string" ? c[k] : "")).filter(Boolean).join(" ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 600);
      lines.push(`PROPOSAL "${pr.title || ""}"${pr.accepted_tier ? ` (accepted tier: ${pr.accepted_tier})` : ""}: ${bits}`);
    }
    const { data: notes } = await service.from("lead_notes").select("body").eq("lead_id", String(lead.id)).order("created_at", { ascending: false }).limit(3);
    if (notes?.length) lines.push("INTERNAL CRM NOTES (background only, never quote): " + notes.map((n) => String(n.body || "").slice(0, 160)).join(" | "));
  } else {
    lines.push(`LOST DEAL: "${deal.title || "video project"}" — went cold ${deal.lost_at ? fmtDate(deal.lost_at, "en") : "2-3 months ago"}${deal.lost_reason ? ` · internal lost reason (background only, never mention as such): ${deal.lost_reason}` : ""}.`);
    if (lead.message) lines.push(`THEIR ORIGINAL INQUIRY: "${String(lead.message).slice(0, 400)}"`);
    if (news.length) lines.push("RECENT VIVEN NEWS you may reference (pick at most ONE, only if it fits naturally): " + news.map((n) => `"${n.title}" (${n.url})`).join(" · "));
  }
  return lines.join("\n");
}

// -------------------------------------------------------------------------
// elegibilidad compartida — devuelve el motivo de exclusión o null si pasa
// -------------------------------------------------------------------------
function baseExclusion(lead: Lead): string | null {
  if (!lead.email) return "sin email";
  if (TEST.test(String(lead.email))) return "email interno/test";
  if (BILLING.test(String(lead.email))) return "casilla de facturación — buscar contacto humano a mano";
  if (lead.unsubscribed) return "dado de baja";
  if (lead.reactivation_drafted_at) return "ya tuvo reactivación (flag)";
  if (lead.last_reply_at && Date.now() - new Date(String(lead.last_reply_at)).getTime() < ACTIVE_REPLY_DAYS * DAY) return "conversación activa reciente";
  if (lead.last_automated_email_at && Date.now() - new Date(String(lead.last_automated_email_at)).getTime() < RECENT_AUTO_DAYS * DAY) return "email automático hace <14 días";
  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" } });
  // auth: cron con secret compartido O usuario logueado del dashboard (mismo patrón content-engine)
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
    const now = Date.now();

    // ---- datos base: todos los deals no archivados + estado por lead ----
    const { data: allDeals, error: derr } = await service.from("deals")
      .select("id,lead_id,title,stage,archived,won_at,lost_at,lost_reason").eq("archived", false);
    if (derr) return json({ error: derr.message }, 500);
    const byLead = new Map<number, Deal[]>();
    for (const d of (allDeals ?? []) as Deal[]) {
      if (!byLead.has(d.lead_id)) byLead.set(d.lead_id, []);
      byLead.get(d.lead_id)!.push(d);
    }

    // (a) GANADOS: último won_at hace 6+ meses, sin deal abierto
    const wonCandidates: { lead_id: number; deal: Deal }[] = [];
    // (b) PERDIDOS: deal perdido hace 60–90 días, sin deal abierto, jamás ganó
    const lostCandidates: { lead_id: number; deal: Deal }[] = [];
    for (const [leadId, deals] of byLead) {
      if (deals.some((d) => OPEN_STAGES.includes(d.stage))) continue;   // deal abierto = hay conversación comercial en curso
      const wons = deals.filter((d) => d.stage === "ganado" && d.won_at);
      if (wons.length) {
        const lastWon = wons.sort((a, b) => new Date(b.won_at!).getTime() - new Date(a.won_at!).getTime())[0];
        const age = now - new Date(lastWon.won_at!).getTime();
        if (age >= WON_DORMANT_DAYS * DAY && age <= WON_MAX_AGE_DAYS * DAY) wonCandidates.push({ lead_id: leadId, deal: lastWon });
        continue;   // un cliente ganado nunca cae en la vertiente de "perdidos"
      }
      const losts = deals.filter((d) => d.stage === "perdido" && d.lost_at);
      if (losts.length) {
        const lastLost = losts.sort((a, b) => new Date(b.lost_at!).getTime() - new Date(a.lost_at!).getTime())[0];
        const age = now - new Date(lastLost.lost_at!).getTime();
        if (age >= LOST_MIN_DAYS * DAY && age <= LOST_MAX_DAYS * DAY) lostCandidates.push({ lead_id: leadId, deal: lastLost });
      }
    }

    // dormidos MÁS RECIENTES primero: su email tiene más chances de seguir vivo
    wonCandidates.sort((a, b) => String(b.deal.won_at).localeCompare(String(a.deal.won_at)));

    // ---- leads de los candidatos + filtros de exclusión ----
    const ids = [...new Set([...wonCandidates, ...lostCandidates].map((c) => c.lead_id))];
    if (!ids.length) return json({ ok: true, msg: "sin candidatos hoy", won: 0, lost: 0 });
    const { data: leads, error: lerr } = await service.from("leads").select("*").in("id", ids);
    if (lerr) return json({ error: lerr.message }, 500);
    const leadById = new Map<number, Lead>((leads ?? []).map((l: Lead) => [Number(l.id), l]));
    // cinturón y tiradores: outbox ya tiene un draft de reactivación para estos leads
    const { data: prevOb } = await service.from("outbox").select("lead_id").eq("kind", "reactivation").in("lead_id", ids);
    const alreadyDrafted = new Set((prevOb ?? []).map((o: { lead_id: number }) => Number(o.lead_id)));

    type Verdict = { lead_id: number; name: string; email: string; deal: string; skip: string | null };
    const evaluate = (cands: { lead_id: number; deal: Deal }[]): { ok: { lead: Lead; deal: Deal }[]; report: Verdict[] } => {
      const ok: { lead: Lead; deal: Deal }[] = []; const report: Verdict[] = [];
      for (const c of cands) {
        const lead = leadById.get(c.lead_id);
        if (!lead) continue;
        const skip = alreadyDrafted.has(c.lead_id) ? "ya tiene draft de reactivación en outbox" : baseExclusion(lead);
        report.push({ lead_id: c.lead_id, name: String(lead.name || ""), email: String(lead.email || ""), deal: String(c.deal.title || ""), skip });
        if (!skip) ok.push({ lead, deal: c.deal });
      }
      return { ok, report };
    };
    const won = evaluate(wonCandidates);
    const lost = evaluate(lostCandidates);

    if (dryRun) {
      return json({ ok: true, dry_run: true, won_candidates: won.report, lost_candidates: lost.report,
        would_draft: { won: won.ok.slice(0, MAX_PER_VERTICAL).map((c) => c.lead.email), lost: lost.ok.slice(0, MAX_PER_VERTICAL).map((c) => c.lead.email) } });
    }

    // ---- generación + drafts (máx 3 por vertiente por corrida) ----
    const newsByLang: Record<string, { title: string; url: string }[]> = {};
    const made: { kind: "won" | "lost"; email: string; outbox_id: string }[] = [];
    for (const [kind, batch] of [["won", won.ok], ["lost", lost.ok]] as ["won" | "lost", { lead: Lead; deal: Deal }[]][]) {
      for (const { lead, deal } of batch.slice(0, MAX_PER_VERTICAL)) {
        try {
          const lang = langOf(lead);
          if (kind === "lost" && !newsByLang[lang]) newsByLang[lang] = await recentNews(lang);
          const ctx = await contextFor(kind, lead, deal, newsByLang[lang] ?? []);
          const draft = await aiDraft(kind, lead, ctx);
          if (!draft) { console.error("DRAFT_NULL", kind, lead.id); continue; }
          // FLAG PRIMERO (idempotencia dura): si el insert del outbox fallara
          // después, preferimos un contacto marcado sin draft (se ve en la
          // ficha) antes que el riesgo de dos drafts/emails al mismo contacto.
          const { error: flagErr } = await service.from("leads")
            .update({ reactivation_drafted_at: new Date().toISOString(), reactivation_kind: kind }).eq("id", lead.id).is("reactivation_drafted_at", null);
          if (flagErr) { console.error("FLAG_ERROR (¿corriste la SQL 0113?)", String(flagErr.message)); return json({ error: "leads.reactivation_drafted_at no existe — corré la migración 0113 primero" }, 500); }
          const { data: ob, error: obErr } = await service.from("outbox").insert({
            lead_id: lead.id, kind: "reactivation", category: kind, sender: "sebastian",
            subject: draft.subject, body: draft.body, status: "pending",
          }).select("id").single();
          if (obErr) { console.error("OUTBOX_ERROR", String(obErr.message)); continue; }
          await service.from("lead_notes").insert({
            lead_id: String(lead.id), author: "Sistema",
            body: `♻️ Draft de reactivación (${kind === "won" ? "cliente ganado, proyecto: " + (deal.title || "—") : "lead perdido"}) creado — esperando aprobación en la Bandeja de salida.`,
          }).then(() => {}, () => {});
          notifyDraft(ob.id);
          made.push({ kind, email: String(lead.email), outbox_id: String(ob.id) });
          await new Promise((ok) => setTimeout(ok, 150));
        } catch (e) { console.error("CANDIDATE_ERROR", kind, lead.id, String(e)); }
      }
    }
    const nWon = made.filter((m) => m.kind === "won").length, nLost = made.filter((m) => m.kind === "lost").length;
    if (made.length) pushSummary(nWon, nLost);
    return json({ ok: true, won: nWon, lost: nLost, drafts: made,
      skipped_won: won.report.filter((r) => r.skip), skipped_lost: lost.report.filter((r) => r.skip) });
  } catch (e) {
    console.error("FUNCTION_ERROR", String(e));
    return json({ error: String(e) }, 500);
  }
});
