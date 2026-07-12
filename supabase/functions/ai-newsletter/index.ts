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

    const { topic, notes, lang } = await req.json();
    if (!topic) return json({ error: "falta el tema/título" }, 400);
    const language = lang === "de" ? "German (Swiss High German — NEVER use ß, always ss)" : lang === "es" ? "Spanish" : "English";

    const prompt = `You write a short, warm, non-salesy newsletter email for VIVEN AG, a video production company in Zurich (clients: UBS, Siemens, Porsche, FIFA, Philips). Write in ${language}.

Topic / title given by the sender: "${topic}"${notes ? `\nAdditional context/notes from the sender: ${notes}` : ""}

Rules:
- Plain text body (no HTML tags), paragraphs separated by a blank line. Write any links as plain URLs (they become clickable automatically).
- 80-160 words. Sounds like a real person wrote it in one sitting, not a template. No corporate fluff, no excessive exclamation marks, no "we are thrilled to announce".
- One light, natural call to action near the end (reply, book a call, read more) — no hard sell.
- Subject line: short, specific, curiosity-driven, under 60 characters, no clickbait.

Respond ONLY with valid minified JSON, no markdown fences: {"subject":"...","body":"..."}`;

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 900,
        system: "You output ONLY a single valid minified JSON object. No markdown, no code fences, no commentary.",
        messages: [{ role: "user", content: prompt }, { role: "assistant", content: "{" }],
      }),
    });
    if (!res.ok) return json({ error: "Anthropic " + res.status + ": " + (await res.text()).slice(0, 200) }, 502);
    const data = await res.json();
    let text = (data.content?.[0]?.text ?? "").trim();
    if (!text.startsWith("{")) text = "{" + text;
    text = text.replace(/```json|```/g, "").trim();
    const last = text.lastIndexOf("}");
    if (last > -1) text = text.slice(0, last + 1);
    let p: { subject?: string; body?: string } | null = null;
    try { p = JSON.parse(text); } catch { p = null; }
    if (!p || !p.body || !p.subject) return json({ error: "la IA no devolvió un formato válido — probá de nuevo" }, 502);
    return json({ ok: true, subject: p.subject, body: p.body });
  } catch (e) {
    console.error("FUNCTION_ERROR", String(e));
    return json({ error: String(e) }, 500);
  }
});
