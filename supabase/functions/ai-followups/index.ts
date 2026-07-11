// Supabase Edge Function: ai-followups
// Genera una secuencia de 3 follow-ups personalizados para un lead (idioma del lead,
// referencia a su consulta y a la página donde convirtió). Devuelve borradores con
// día recomendado — el dashboard los muestra para corregir/aprobar antes de enviar.
//
// Deploy:  supabase functions deploy ai-followups --no-verify-jwt
// Secret:  ANTHROPIC_API_KEY (ya seteado)

import { createClient } from "jsr:@supabase/supabase-js@2";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
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

    const { lead = {}, sender_name = "Sofia", offer_title = "", stage = "contactado", offer_total = "" } = await req.json();
    const lang = ["en", "de", "es"].includes(lead.lang) ? lead.lang : "en";
    const language = lang === "de" ? "German (Swiss business style, Sie-Form)" : lang === "es" ? "Spanish" : "English";

    // el OBJETIVO de la secuencia depende de la etapa del deal:
    // sin respuesta → conseguir el video call · call agendado → mantener momentum · oferta/propuesta enviada → decisión
    let goal: string;
    if (stage === "propuesta" && offer_title) {
      goal = `They received our offer "${offer_title}"${offer_total ? ` (${offer_total})` : ""} and haven't decided yet. GOAL: get a decision on the offer.
- Email 1 (day 3): ask if they had a chance to review it, offer to walk them through it on a quick call, or adjust scope/budget if something doesn't fit.
- Email 2 (day 7): add value — what similar clients did (e.g. Siemens got a 3× traffic lift), address the most common hesitation (scope flexibility, timing), remind the offer includes two correction rounds.
- Email 3 (day 12): gentle deadline — the offer is valid 30 days and production slots fill up; ask if you should hold their slot or close the file for now.`;
    } else if (stage === "videocall") {
      goal = `They booked/had a video call with us. GOAL: keep momentum toward the offer.
- Email 1 (day 1): thank them for the call, recap in one line what we understood, confirm the offer is on its way.
- Email 2 (day 4): share one relevant client story matching their project type, ask if anything changed on their side.
- Email 3 (day 8): check in — still the right timing? Offer a short call to refine details.`;
    } else {
      goal = `They inquired but haven't replied to our first response. GOAL: get a reply and book a 15-min video call (a booking button is added below your text automatically — mention they can book directly below).
- Email 1 (day 2): gentle nudge, reference THEIR specific request, add ONE piece of value (e.g. "for Siemens we produced 120+ videos in 5 days, 3× traffic lift").
- Email 2 (day 5): different angle — social proof (5.0 stars on Google, 47 reviews) or a relevant case study, ask ONE easy question.
- Email 3 (day 10): polite "should I close the file?" breakup email, keeps door open.`;
    }

    const prompt = `You write follow-up emails for VIVEN AG, a video production company in Zürich (clients: UBS, Siemens, Porsche, ON, FIFA). Write a sequence of 3 SHORT follow-up emails in ${language} that build trust without being pushy.

Lead context:
- Name: ${lead.first_name || lead.name || "there"}
- Their inquiry: "${(lead.message || "").slice(0, 400)}"
- Page they converted on: ${lead.form_path || lead.landing_path || "website"}
- Deal stage: ${stage}

${goal}

Rules:
- Each: max 90 words, personal tone, sign with "${sender_name} · VIVEN AG". No links, no placeholders like [name] — use their actual name.
- Subjects: short, no clickbait, reference their project${offer_title ? ` or the offer "${offer_title}"` : ""}.

Respond ONLY with valid minified JSON:
{"followups":[{"day":2,"subject":"...","body":"..."},{"day":5,"subject":"...","body":"..."},{"day":10,"subject":"...","body":"..."}]}`;

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 2000,
        system: "You output ONLY a single valid minified JSON object. No markdown, no commentary.",
        messages: [{ role: "user", content: prompt }, { role: "assistant", content: "{" }],
      }),
    });
    if (!res.ok) { const t = await res.text(); console.error("ANTHROPIC_ERROR", res.status, t); return json({ error: `Anthropic ${res.status}: ${t.slice(0, 200)}` }); }
    const data = await res.json();
    let text = (data.content?.[0]?.text ?? "").trim();
    if (!text.startsWith("{")) text = "{" + text;
    const last = text.lastIndexOf("}");
    if (last > -1) text = text.slice(0, last + 1);
    let p: { followups?: { day: number; subject: string; body: string }[] } | null = null;
    try { p = JSON.parse(text); } catch { p = null; }
    if (!p || !Array.isArray(p.followups) || !p.followups.length) return json({ error: "La IA no devolvió una secuencia válida — probá de nuevo." });
    return json({ followups: p.followups.slice(0, 5) });
  } catch (e) {
    console.error("FUNCTION_ERROR", String(e));
    return json({ error: String(e) }, 500);
  }
});
