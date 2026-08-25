// Supabase Edge Function: ai-newsletter-translate
//
// Traduce el newsletter manual de un idioma a otro, bloque por bloque.
//
// Por qué bloque por bloque y no el HTML entero: los bloques que NO son texto
// —video, still, case, CTA— tienen URLs, thumbnails y destinos que no se traducen y
// que un modelo, si le das el HTML completo, "mejora" sin que nadie se lo pida. Acá
// solo viajan los campos de TEXTO; el resto se copia tal cual.
//
// El destino del CTA tampoco se toca: newsletter-send ya lo resuelve por idioma
// (/de/book/ vs /en/book/). Lo único que se traduce del CTA es la etiqueta.
//
// Auth: JWT del dashboard. Secret: ANTHROPIC_API_KEY.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, content-type" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";

const NOMBRE: Record<string, string> = {
  en: "English",
  // Suiza no usa ß: es un error ortográfico local, no una variante estilística
  de: "Swiss High German (Sie form, NEVER ß — always ss)",
  es: "Spanish (professional, voseo-friendly)",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const auth = req.headers.get("Authorization") ?? "";
    const sb = createClient(SB_URL, ANON, { global: { headers: { Authorization: auth } } });
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return json({ error: "unauthorized" }, 401);
    if (!KEY) return json({ error: "falta ANTHROPIC_API_KEY" }, 500);

    const { from = "en", to = "de", subject = "", blocks = [] } = await req.json();
    if (!subject && !blocks.length) return json({ error: "nada que traducir" }, 400);

    // solo los textos, con su posición, para poder devolverlos a su lugar exacto
    type B = { type?: string; text?: string; label?: string; title?: string; caption?: string };
    const piezas: { i: number; campo: string; txt: string }[] = [];
    (blocks as B[]).forEach((b, i) => {
      (["text", "label", "title", "caption"] as const).forEach((campo) => {
        const v = String((b as Record<string, unknown>)[campo] ?? "").trim();
        if (v) piezas.push({ i, campo, txt: v });
      });
    });

    const sys = `You translate marketing newsletters for VIVEN, a video production company in Zurich. ` +
      `Translate from ${NOMBRE[from] ?? from} to ${NOMBRE[to] ?? to}. ` +
      `Keep the tone, the length and the line breaks. Keep proper nouns, brand names, client names and URLs EXACTLY as they are. ` +
      `Do not add, remove or "improve" anything — this is a translation, not a rewrite. ` +
      `Output ONLY minified JSON: {"subject":"...","piezas":["...","..."]} where piezas has EXACTLY ${piezas.length} strings, in the same order you received them.`;
    const task = JSON.stringify({ subject, piezas: piezas.map((p) => p.txt) });

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": KEY, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 3000, system: sys, messages: [{ role: "user", content: task }] }),
    });
    if (!res.ok) return json({ error: `Anthropic ${res.status}: ${(await res.text()).slice(0, 200)}` }, 502);
    const data = await res.json();
    let t = ((data.content ?? []) as { type: string; text?: string }[])
      .filter((c) => c.type === "text").map((c) => c.text ?? "").join(" ").trim().replace(/```json|```/g, "");
    const m = t.match(/\{[\s\S]*\}/); if (m) t = m[0];
    let out: { subject?: string; piezas?: string[] } = {};
    try { out = JSON.parse(t); } catch { /* abajo */ }
    if (!out.piezas || out.piezas.length !== piezas.length) {
      console.error("TRAD_MISMATCH", { esperadas: piezas.length, vinieron: out.piezas?.length, stop: data.stop_reason });
      return json({ error: "la traducción volvió incompleta — probá de nuevo" }, 502);
    }

    // se copian los bloques enteros y solo se reemplazan los textos: URLs, thumbnails
    // y destinos quedan intactos
    const nuevos = (blocks as B[]).map((b) => ({ ...b }));
    piezas.forEach((p, k) => { (nuevos[p.i] as Record<string, unknown>)[p.campo] = out.piezas![k]; });

    return json({ ok: true, from, to, subject: out.subject || subject, blocks: nuevos });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
