// Supabase Edge Function: ai-lead-magnet-ideas
// Parte B del tab 🧲 Lead Magnets: genera ideas NUEVAS de lead magnets (PDF
// descargable o mini-tool tipo calculadora) a partir de contexto real —
// servicios activos, últimos artículos del blog, y demanda real de búsqueda
// (Search Console directo, o la cartera keyword_opportunities de SQL 0070 si
// ya existe). Un solo call a Claude, sin búsqueda web (no hace falta acá).
//
// Dos modos, mismo endpoint:
//   body: {}                              → devuelve 4-6 IDEAS {title,type,rationale,lang}
//   body: { draft: {title,type,lang,...} } → devuelve el BORRADOR de contenido
//                                             real de esa idea puntual (PDF-type),
//                                             que el dashboard convierte a PDF
//                                             client-side (jsPDF) — nunca se
//                                             publica ni linkea solo en ningún lado.
//
// Deploy:   supabase functions deploy ai-lead-magnet-ideas --no-verify-jwt
// Requiere: ANTHROPIC_API_KEY; opcional GOOGLE_REFRESH_TOKEN (scope webmasters)
//           para el fallback de Search Console si keyword_opportunities está vacía.

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

async function claude(prompt: string, maxTokens: number): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) throw new Error("Anthropic " + res.status + ": " + (await res.text()).slice(0, 200));
  const data = await res.json();
  let text = (data.content ?? []).filter((c: { type: string }) => c.type === "text").map((c: { text: string }) => c.text).join("").trim();
  text = text.replace(/```json|```/g, "").trim();
  const m = text.match(/\{[\s\S]*\}/);
  if (m) text = m[0];
  return text;
}

async function googleToken(): Promise<string> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: Deno.env.get("GOOGLE_CLIENT_ID")!,
      client_secret: Deno.env.get("GOOGLE_CLIENT_SECRET")!,
      refresh_token: Deno.env.get("GOOGLE_REFRESH_TOKEN")!,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) throw new Error("google_token " + res.status);
  return (await res.json()).access_token;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const auth = req.headers.get("Authorization") ?? "";
    const supabase = createClient(SB_URL, SB_ANON, { global: { headers: { Authorization: auth } } });
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return json({ error: "unauthorized" }, 401);

    const body = await req.json().catch(() => ({}));

    // ---------- MODO 2: borrador de contenido real de UNA idea puntual (PDF) ----------
    if (body.draft && typeof body.draft === "object") {
      const idea = body.draft as { title?: string; type?: string; lang?: string; rationale?: string };
      const lang = ["en", "de", "es"].includes(idea.lang || "") ? idea.lang : "en";
      const langName = { en: "English", de: "German (Sie-Form, professional)", es: "Spanish" }[lang as string];
      const prompt = `You are a content strategist for VIVEN AG, a video production company in Zürich, Switzerland (clients: UBS, Siemens, FIFA, Porsche — 100+ productions). Draft the real content for a downloadable PDF lead magnet.

TITLE: "${idea.title || ""}"
WHY THIS IDEA: ${idea.rationale || ""}
LANGUAGE: write ALL content in ${langName}.

Produce 3-6 sections. Each section is either a short explanation (2-4 sentences) or a checklist (3-8 concrete, specific items — not generic fluff). This must read as genuinely useful, practical content a Swiss marketing/HR/comms manager would actually save and use — not a thin excuse to collect emails. Ground it in real video-production expertise (pre-production planning, briefing, budgeting, casting, locations, timelines, deliverables, employer branding, etc. — whatever fits the title).

Respond ONLY with valid JSON, no fences:
{"title":"...","subtitle":"<1 short line>","sections":[{"heading":"...","kind":"text|checklist","body":"<if kind=text>","items":["<if kind=checklist>"]}]}`;
      const text = await claude(prompt, 2500);
      let parsed: { title?: string; subtitle?: string; sections?: unknown[] } | null = null;
      try { parsed = JSON.parse(text); } catch { parsed = null; }
      if (!parsed || !Array.isArray(parsed.sections)) return json({ error: "La IA no devolvió un borrador válido." });
      return json({ draft: parsed });
    }

    // ---------- MODO 1: 4-6 ideas nuevas ----------
    // servicios activos (catálogo real — para que las ideas encajen con lo que vendemos)
    const { data: services } = await supabase.from("services").select("name,phase").eq("active", true).order("sort").limit(40);
    const servicesLines = (services || []).map((s: { name: string; phase: string }) => `- ${s.name} (${s.phase})`).join("\n") || "(sin datos)";

    // últimos artículos publicados del blog (para no repetir temas ya cubiertos)
    const { data: blogs } = await supabase.from("blogs").select("title,lang").eq("status", "published").order("published_at", { ascending: false }).limit(15);
    const blogLines = (blogs || []).map((b: { title: string; lang: string }) => `- [${(b.lang || "").toUpperCase()}] ${b.title}`).join("\n") || "(sin datos)";

    // demanda real: keyword_opportunities (SQL 0070) si ya existe y tiene filas; si no, GSC directo
    let demandLines = "";
    let demandSource = "";
    try {
      const { data: opps, error: oppErr } = await supabase.from("keyword_opportunities")
        .select("keyword,lang,type,priority,why").order("priority", { ascending: false }).limit(25);
      if (!oppErr && opps && opps.length) {
        demandSource = "keyword_opportunities (cartera SEO)";
        demandLines = opps.map((o: { keyword: string; lang: string; type: string; why: string }) =>
          `- "${o.keyword}" [${(o.lang || "").toUpperCase()}] (${o.type}) — ${o.why || ""}`).join("\n");
      }
    } catch { /* tabla puede no existir todavía (SQL 0070 sin correr) — sigue con GSC */ }
    if (!demandLines) {
      try {
        const token = await googleToken();
        let site = Deno.env.get("GSC_SITE") || "";
        if (!site) {
          const sres = await fetch("https://searchconsole.googleapis.com/webmasters/v3/sites", { headers: { Authorization: "Bearer " + token } });
          const entries = sres.ok ? ((await sres.json()).siteEntry ?? []) : [];
          const ok = entries.filter((e: { permissionLevel?: string }) => e.permissionLevel !== "siteUnverifiedUser").map((e: { siteUrl: string }) => e.siteUrl);
          const pref = ["sc-domain:viven.ch", "https://www.viven.ch/", "https://viven.ch/"];
          site = pref.find((p) => ok.includes(p)) || ok[0] || "https://viven.ch/";
        }
        const end = new Date(Date.now() - 2 * 864e5), start = new Date(end.getTime() - 90 * 864e5);
        const ymd = (x: Date) => x.toISOString().slice(0, 10);
        const qres = await fetch(`https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site)}/searchAnalytics/query`, {
          method: "POST",
          headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
          body: JSON.stringify({ startDate: ymd(start), endDate: ymd(end), dimensions: ["query"], rowLimit: 40 }),
        });
        const rows = qres.ok ? ((await qres.json()).rows ?? []) : [];
        demandSource = "Google Search Console (directo)";
        demandLines = rows.map((r: { keys: string[]; clicks: number; impressions: number; position: number }) =>
          `- "${r.keys[0]}" — pos ${r.position.toFixed(1)}, ${r.impressions} impresiones`).join("\n");
      } catch { /* sin GSC tampoco — seguimos solo con servicios+blog */ }
    }
    if (!demandLines) demandLines = "(sin datos de demanda todavía)";

    const prompt = `You are the growth strategist for VIVEN AG (video production, Zürich, Switzerland; EN/DE/ES site; targets Swiss B2B companies — corporate, employer branding, product, social, how-to video). Propose NEW lead magnet ideas: gated content that a marketing/HR/comms manager at a Swiss company would trade their email for.

OUR SERVICES (so ideas connect to what we actually sell):
${servicesLines}

RECENT BLOG POSTS (avoid duplicating these topics):
${blogLines}

REAL SEARCH DEMAND (source: ${demandSource || "none"}):
${demandLines}

Two TWO magnet types only:
- "pdf": a downloadable PDF (checklist, guide, template, planning worksheet) — always feasible immediately, zero engineering.
- "tool": an interactive mini-tool (like a calculator) — powerful but requires a NEW public page, so it always needs explicit human approval before it's ever built.

Propose 4-6 ideas, mixing both types (lean toward "pdf" — cheaper to ship). For each, ground the rationale in one CONCRETE signal from the data above (a specific keyword, a specific service, a gap vs. the blog).

Respond ONLY with valid JSON, no fences:
{"ideas":[{"title":"...","type":"pdf|tool","rationale":"<1-2 sentences citing the concrete signal>","lang":"en|de|es"}]}`;

    const text = await claude(prompt, 1800);
    let parsed: { ideas?: unknown[] } | null = null;
    try { parsed = JSON.parse(text); } catch { parsed = null; }
    if (!parsed || !Array.isArray(parsed.ideas)) return json({ error: "La IA no devolvió ideas válidas." });
    return json({ ideas: parsed.ideas.slice(0, 6), demand_source: demandSource || null });
  } catch (e) {
    console.error("FUNCTION_ERROR", String(e));
    return json({ error: String(e) }, 500);
  }
});
