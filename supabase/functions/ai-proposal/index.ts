// Supabase Edge Function: ai-proposal
// Genera una PROPUESTA completa (tipo Qwilr) con 3 paquetes desde la consulta + brief.
// Usa el CATÁLOGO de Viven para que los precios salgan de ahí. Todo el texto lo escribe la IA.
// Devuelve { title, intro, overview{objective,outputs[],location,timing,delivery},
//            scope[{title,text}], tiers[{name,subtitle,recommended,includes[],items[]}],
//            addon_groups[{title,items[]}] }.
//
// Deploy:  supabase functions deploy ai-proposal --no-verify-jwt
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

    const { inquiry = "", brief = null, catalog = [], lang = "en", client_name = "", client_company = "" } = await req.json();
    if (!inquiry && !brief) return json({ error: "faltan datos (inquiry o brief)" }, 400);
    const language = lang === "de" ? "German" : lang === "es" ? "Spanish" : "English";
    const catLines = (catalog || []).map((c: any) => `- [${c.phase}] ${c.name} | ${c.unit} | price ${c.price} | cost ${c.cost}`).join("\n");

    const prompt = `You are a senior producer at VIVEN AG, a video production company in Zürich (clients: UBS, Siemens, Porsche, ON, V-ZUG, Sonova). Write a full client-facing video production PROPOSAL, in ${language}, from the client's inquiry (and brief if present).

CATALOG (use THESE items with their prices/costs; pick which and how many per tier):
${catLines || "(no catalog)"}

Produce THREE packages (tiers), increasing in scope/price (e.g. Lite / Plus / Premium — name them fittingly). Differentiate them clearly: more shooting days, more outputs/videos, more crew, extra formats. Mark ONE as recommended (usually the middle). A typical Viven project is CHF 3'000–20'000 net. Prices/costs of catalog items must be their catalog values; adjust quantities. You may add up to 2 custom items per tier if essential (estimate price & cost).

Client: ${client_name || "the client"}${client_company ? " at " + client_company : ""}.

Respond ONLY with valid JSON, no extra text, exactly this shape:
{
 "title": "Company — Video type",
 "intro": "Dear ... warm 2-3 sentence opening letter",
 "overview": {"objective":"1-2 sentences on the goal","outputs":["1x ... video, ca X min, 16:9","..."],"location":"...","timing":"...","delivery":"..."},
 "scope": [{"title":"Creative Development","text":"..."},{"title":"Pre-Production","text":"..."},{"title":"Production","text":"..."},{"title":"Post-Production","text":"..."},{"title":"Presentation & Revisions","text":"..."}],
 "tiers": [{"name":"Lite Package","subtitle":"1 shooting day","recommended":false,"includes":["client-facing bullet","..."],"items":[{"phase":"Production","name":"Director of Photography","qty":1,"unit":"Tag","price":1000,"cost":800}]}],
 "addon_groups": [{"title":"Add-ons","items":[{"name":"Drone","note":"","qty":1,"unit":"Day","price":250,"cost":0}]}]
}

Consulta del cliente:
${inquiry || "(no direct message)"}

Brief${brief ? "" : " (not completed)"}:
${brief ? JSON.stringify(brief, null, 2) : "—"}`;

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 6000,
        system: "You output ONLY a single valid minified JSON object. No markdown, no code fences, no commentary before or after. Keep bullet lists concise so the JSON is never truncated.",
        messages: [{ role: "user", content: prompt }, { role: "assistant", content: "{" }],
      }),
    });
    if (!res.ok) {
      const t = await res.text();
      console.error("ANTHROPIC_ERROR", res.status, t);
      return json({ error: `Anthropic ${res.status}: ${t.slice(0, 300)}` });
    }
    const data = await res.json();
    let text = (data.content?.[0]?.text ?? "").trim();
    if (!text.startsWith("{")) text = "{" + text;          // el assistant fue prellenado con "{"
    text = text.replace(/```json|```/g, "").trim();
    const last = text.lastIndexOf("}");
    if (last > -1) text = text.slice(0, last + 1);          // recorta basura post-JSON
    let p: any;
    try { p = JSON.parse(text); } catch { p = null; }
    if (!p || !Array.isArray(p.tiers) || !p.tiers.length) {
      console.error("PARSE_ERROR stop=" + data.stop_reason, text.slice(-400));
      const hint = data.stop_reason === "max_tokens" ? " (respuesta cortada — probá de nuevo)" : "";
      return json({ error: "La IA no devolvió una propuesta válida" + hint + "." });
    }
    // sanear
    const num = (v: any, d = 0) => Number(v) || d;
    p.tiers = p.tiers.slice(0, 3).map((t: any) => ({
      name: String(t.name || "Package").slice(0, 60),
      subtitle: String(t.subtitle || "").slice(0, 80),
      recommended: !!t.recommended,
      includes: Array.isArray(t.includes) ? t.includes.slice(0, 20).map((x: any) => String(x).slice(0, 160)) : [],
      items: Array.isArray(t.items) ? t.items.slice(0, 40).map((it: any) => ({ phase: it.phase || "Production", name: String(it.name || "").slice(0, 80), qty: num(it.qty, 1), unit: it.unit || "Tag", price: num(it.price), cost: num(it.cost) })) : [],
    }));
    p.addon_groups = Array.isArray(p.addon_groups) ? p.addon_groups.slice(0, 4).map((g: any) => ({
      title: String(g.title || "Add-ons").slice(0, 60),
      items: Array.isArray(g.items) ? g.items.slice(0, 12).map((it: any) => ({ name: String(it.name || "").slice(0, 80), note: String(it.note || "").slice(0, 160), qty: num(it.qty, 1), unit: it.unit || "", price: num(it.price), cost: num(it.cost) })) : [],
    })) : [];
    return json({ title: p.title || "", intro: p.intro || "", overview: p.overview || {}, scope: Array.isArray(p.scope) ? p.scope : [], tiers: p.tiers, addon_groups: p.addon_groups });
  } catch (e) {
    console.error("FUNCTION_ERROR", String(e));
    return json({ error: String(e) });
  }
});
