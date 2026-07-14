// Supabase Edge Function: ai-offer
// Arma una oferta (posiciones por fase) a partir de la consulta del cliente + el brief.
// Usa el CATÁLOGO de Viven que le pasa el dashboard → los precios salen de ahí, no los inventa.
// Devuelve { title, summary, items:[{phase,name,qty,unit,price,cost}] }.
//
// Deploy:  supabase functions deploy ai-offer --no-verify-jwt
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

    const { inquiry = "", brief = null, catalog = [], lang = "es" } = await req.json();
    if (!inquiry && !brief) return json({ error: "faltan datos (inquiry o brief)" }, 400);

    const language = lang === "de" ? "alemán" : lang === "en" ? "inglés" : "español";
    // catálogo compacto para el prompt
    const catLines = (catalog || []).map((c: any) =>
      `- [${c.phase}] ${c.name} | ${c.unit} | precio ${c.price} | costo ${c.cost}`).join("\n");

    const prompt = `Sos productor senior de Viven, una productora de video en Zúrich (clientes: UBS, Siemens, Porsche, ON, V-ZUG, Sonova, Kanebo).
Tarea: a partir de la consulta del cliente (y el brief si existe), armá una OFERTA de producción realista, eligiendo posiciones y cantidades.

CATÁLOGO DE POSICIONES (usá ESTAS con sus precios/costos; elegí cuáles y cuántas):
${catLines || "(sin catálogo)"}

Reglas:
- Usá prioritariamente ítems del catálogo con SUS precios y costos exactos. Ajustá "qty" (días/horas/unidades) según el proyecto.
- Podés agregar como máximo 2 ítems fuera del catálogo si son imprescindibles; en ese caso estimá price y cost coherentes (costo = lo que pagamos a freelancer/rental).
- Un proyecto típico de Viven va de CHF 3'000 a 12'000 netos. No exageres.
- Cubrí las fases que correspondan: Development, Pre-Production, Production, Post-Production, Delivery.
- Si el brief trae "answers", USALO: formats con 9:16/1:1 → agregá "Social cutdowns"; cada idioma extra o "Subtitles needed" → una posición de "Untertitel / Subtitles" por idioma; quantity de varios videos → escalá días de producción/edición en proporción; "Animation (no shoot)" o "No shoot needed" → sin crew de rodaje, más Motion/VFX; "Multiple locations" → más días de producción y Van.
- IMPORTANTE — presupuesto del brief (answers.budget): si existe y NO es "Not sure yet", es un TECHO DURO, no orientativo. Tomá el extremo SUPERIOR del rango como límite ("< CHF 5k" → 5'000; "CHF 5–15k" → 15'000; "CHF 15–40k" → 40'000; "CHF 40k+" → tratalo como ~45'000) y el TOTAL NETO de la oferta (suma qty×price) NUNCA puede superar ese número. Quedar por debajo está perfecto (ideal si los costos reales dan más bajo). Superarlo NO — le pedimos ese dato al cliente justamente para no ofertarle algo que no puede pagar; si hace falta, bajá días/posiciones hasta entrar en el rango.
- El "title" corto y claro (cliente + tipo de video). El "summary" en ${language}, 1-2 frases sobre el enfoque.
- "intro_text" y "closing_text": textos PERSONALES en ${language} que van en el PDF y el email de la oferta, dirigidos al cliente (trato natural del idioma: Sie en alemán, you en inglés, tono cercano en español).
  · intro_text (2-4 frases): cálido y específico — agradecé la consulta, mencioná EL PROYECTO concreto del brief (qué video, para qué) y decí con ganas que nos encantaría hacerlo con ellos. Nada de plantillas genéricas.
  · closing_text (1-3 frases): cierre cercano — si hay preguntas sobre alcance o precio que escriban o llamen, estamos felices de ajustar lo que haga falta.

Respondé SOLO con JSON válido, sin texto extra, con esta forma EXACTA:
{"title":"...","summary":"...","intro_text":"...","closing_text":"...","items":[{"phase":"Production","name":"Director of Photography","qty":1,"unit":"Tag","price":1000,"cost":800}]}

Consulta del cliente:
${inquiry || "(sin mensaje directo)"}

Brief${brief ? "" : " (no completado)"}:
${brief ? JSON.stringify(brief, null, 2) : "—"}`;

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 4000,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) {
      const t = await res.text();
      console.error("ANTHROPIC_ERROR", res.status, t);
      return json({ error: `Anthropic ${res.status}: ${t.slice(0, 300)}` });
    }
    const data = await res.json();
    let text = (data.content?.[0]?.text ?? "").trim();
    text = text.replace(/^```(?:json)?/m, "").replace(/```\s*$/m, "").trim();   // fences de markdown
    const m = text.match(/\{[\s\S]*\}/);
    if (m) text = m[0];
    let parsed: any;
    try { parsed = JSON.parse(text); } catch { parsed = null; }
    if (!parsed || !Array.isArray(parsed.items)) {
      console.error("PARSE_ERROR", text.slice(0, 300));
      return json({ error: "La IA no devolvió una oferta válida." });
    }
    // sanear ítems
    parsed.items = parsed.items.filter((it: any) => it && it.name).map((it: any) => ({
      phase: it.phase || "Production",
      name: String(it.name).slice(0, 80),
      qty: Number(it.qty) || 1,
      unit: it.unit || "Tag",
      price: Number(it.price) || 0,
      cost: Number(it.cost) || 0,
    })).slice(0, 40);
    return json({
      title: parsed.title || "",
      summary: parsed.summary || "",
      intro_text: typeof parsed.intro_text === "string" ? parsed.intro_text.slice(0, 1200) : "",
      closing_text: typeof parsed.closing_text === "string" ? parsed.closing_text.slice(0, 600) : "",
      items: parsed.items,
    });
  } catch (e) {
    console.error("FUNCTION_ERROR", String(e));
    return json({ error: String(e) });
  }
});
