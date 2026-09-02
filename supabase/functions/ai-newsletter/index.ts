// Supabase Edge Function: ai-newsletter
// Genera copy (asunto + cuerpo) de una campaña de newsletter a partir de un
// título/tema (y notas opcionales) — para mandar emails rápidos pero buenos
// sin escribir todo a mano cada vez. Llamado desde el dashboard (JWT del usuario).
//
// Deploy: supabase functions deploy ai-newsletter --no-verify-jwt
// Secret: ANTHROPIC_API_KEY (ya seteado)

import { createClient } from "jsr:@supabase/supabase-js@2";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
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

    /* `catalogo` lo manda el dashboard: los proyectos reales con su still. Sin esto, la IA
       no tiene forma de "usar el proyecto Siemens" —no conoce ninguno— y solo podía
       devolver texto. Y un newsletter sin bloques cae en el camino viejo que manda texto
       pelado: por eso "no pone imágenes" y "no puedo decir qué proyecto usar" eran el
       mismo bug visto desde dos lados.
       (Sebastián, 2 sep 2026.) */
    const { topic, notes, lang, catalogo } = await req.json();
    if (!topic) return json({ error: "falta el tema/título" }, 400);
    const language = lang === "de" ? "German (Swiss High German — NEVER use ß, always ss)" : lang === "es" ? "Spanish" : "English";

    const prompt = `You write a short, warm, non-salesy newsletter email for VIVEN AG, a video production company in Zurich (clients: UBS, Siemens, Porsche, FIFA, Philips). Write in ${language}.

Topic / title given by the sender: "${topic}"${notes ? `\nAdditional context/notes from the sender: ${notes}` : ""}

${Array.isArray(catalogo) && catalogo.length ? `
Real VIVEN projects you may reference (use ONLY these — never invent a client or an image):
${(catalogo as { cliente: string; still: string }[]).slice(0, 40).map((c) => `- ${c.cliente} | ${c.still}`).join("\n")}
If the sender's notes name one of these clients, use THAT project's image. If they name none, pick the one that best fits the topic.` : ""}

Rules:
- Plain text body (no HTML tags), paragraphs separated by a blank line. Write any links as plain URLs (they become clickable automatically).
- 80-160 words. Sounds like a real person wrote it in one sitting, not a template. No corporate fluff, no excessive exclamation marks, no "we are thrilled to announce".
- One light, natural call to action near the end (reply, book a call, read more) — no hard sell.
- Subject line: short, specific, curiosity-driven, under 60 characters, no clickbait.

- Pick exactly ONE image from the list above and return its path verbatim in "still". Copy it character by character: a path you alter does not exist and the email arrives with a broken image.

Respond ONLY with valid minified JSON, no markdown fences: {"subject":"...","body":"...","still":"...","caption":"..."}
"caption" is optional, max 8 words, describing the image. Leave "still" empty only if the list above is empty.`;

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        /* OPUS, NO HAIKU. Esto escribe el texto que le llega a los clientes; el modelo
           chico se nota justo ahí —frases de plantilla, entusiasmo genérico— y se manda
           un puñado de veces por mes, así que el costo no es el criterio.
           (Sebastián, 2 sep 2026: "que use IA real".) */
        model: "claude-opus-5",
        max_tokens: 8000,
        /* Esquema en vez del truco de prefill: el JSON viene bien formado por contrato y
           deja de depender de recortar llaves a mano más abajo. Mismo patrón que ai-guion. */
        output_config: {
          effort: "high",
          format: {
            type: "json_schema",
            schema: {
              type: "object",
              properties: {
                subject: { type: "string", description: "Menos de 60 caracteres." },
                body: { type: "string", description: "Texto plano, párrafos separados por línea en blanco." },
                still: { type: "string", description: "Una ruta EXACTA del catálogo, o vacío." },
                caption: { type: "string", description: "Máximo 8 palabras, o vacío." },
              },
              required: ["subject", "body", "still", "caption"],
              additionalProperties: false,
            },
          },
        },
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) return json({ error: "Anthropic " + res.status + ": " + (await res.text()).slice(0, 200) }, 502);
    const data = await res.json();
    /* Con salida estructurada el texto ya es JSON válido. Se recorre el contenido en vez
       de asumir content[0]: con effort alto puede venir un bloque de razonamiento antes. */
    let text = ((data.content ?? []) as { type: string; text?: string }[])
      .filter((c) => c.type === "text").map((c) => c.text ?? "").join("").trim();
    text = text.replace(/```json|```/g, "").trim();
    let p: { subject?: string; body?: string; still?: string; caption?: string } | null = null;
    try { p = JSON.parse(text); } catch { p = null; }
    if (!p || !p.body || !p.subject) return json({ error: "la IA no devolvió un formato válido — probá de nuevo" }, 502);
    /* La imagen se valida contra el catálogo que mandó el dashboard: si la IA inventó o
       alteró la ruta, se descarta. Una imagen rota en un email no se puede arreglar
       después de mandarlo. */
    const permitidas = new Set((Array.isArray(catalogo) ? catalogo : [])
      .map((c: { still?: string }) => String(c?.still || "")));
    const still = p.still && permitidas.has(String(p.still)) ? String(p.still) : "";
    if (p.still && !still) console.log("NL_STILL_INVENTADO", String(p.still).slice(0, 120));
    return json({ ok: true, subject: p.subject, body: p.body, still, caption: still ? (p.caption || "") : "" });
  } catch (e) {
    console.error("FUNCTION_ERROR", String(e));
    return json({ error: String(e) }, 500);
  }
});
