// Supabase Edge Function: ai-email-draft
// Reemplaza el viejo esquema de ai-suggest (una sola frase insertada en una
// plantilla fija) — acá la IA escribe el email COMPLETO (asunto + cuerpo),
// leyendo la conversación real (email_log, ambas direcciones) que el
// dashboard ya tiene cargada, no solo el mensaje original del lead.
// Con "hint" (opcional) el usuario dice de qué debe hablar el email; sin
// hint, la IA arma el próximo follow-up natural según dónde quedó la charla
// (pedido explícito: "aunque no digamos de que va" — tiene que andar igual).
//
// La llama el dashboard (JWT del usuario logueado) → { subject, body }.
//
// Deploy:  supabase functions deploy ai-email-draft --no-verify-jwt
// Secret:  ANTHROPIC_API_KEY (ya existe, mismo que ai-suggest/automations-run)

import { createClient } from "jsr:@supabase/supabase-js@2";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_ANON = Deno.env.get("SUPABASE_ANON_KEY")!;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// mismo tono por remitente que automations-run (aiDraft) — coherencia de voz
// entre los emails automáticos y los que se generan a mano desde la ficha.
const VOICE: Record<string, string> = {
  sofia: "You write as Sofia Treviño, producer at VIVEN: warm, precise, service-minded, zero fluff.",
  sebastian: "You write as Sebastian Cepeda, founder of VIVEN (produced the first Swiss feature film on Netflix): direct, generous, entrepreneurial, zero hype.",
  team: "You write as the VIVEN team: friendly, professional, concise.",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const auth = req.headers.get("Authorization") ?? "";
    const supabase = createClient(SB_URL, SB_ANON, { global: { headers: { Authorization: auth } } });
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: cors });

    const { lead, sender = "team", hint = "", history = [] } = await req.json();
    if (!lead) return new Response(JSON.stringify({ error: "falta lead" }), { status: 400, headers: cors });
    const lang = ["en", "de", "es"].includes(lead.lang) ? lead.lang : "en";

    const sys = `${VOICE[sender] || VOICE.team} Language: ${lang === "de" ? "Swiss High German (Sie form, NEVER ß — always ss)" : lang === "es" ? "Spanish (voseo friendly but professional)" : "English"}. Write a COMPLETE, ready-to-send email — greeting, body, sign-off. Plain text only, 60-160 words, ONE clear next step, no marketing hype, no multiple exclamation marks, no emojis unless natural. Sign with the sender's first name only. Never invent facts, prices, or commitments not present in the context — if unsure, keep it general. Output ONLY minified JSON {"subject":"...","body":"..."} — body paragraphs separated by \\n\\n.`;

    // últimas entradas reales del hilo (ambas direcciones) — el dashboard ya las
    // tiene cargadas en la timeline, se las pasa acá tal cual, sin re-consultar.
    const histTxt = (Array.isArray(history) ? history : [])
      .slice(-8)
      .map((h: { direction?: string; subject?: string; body?: string }) =>
        (h.direction === "in" ? "CLIENT REPLIED" : "WE SENT") +
        (h.subject ? ` ("${h.subject}")` : "") + ": " + String(h.body || "").slice(0, 400))
      .join("\n\n");

    const ctx = `CONTACT: ${lead.name || lead.email || ""} · ${lead.company || ""} · stage: ${lead.status || "nuevo"} · channel: ${lead.channel || "direct"}\nORIGINAL MESSAGE: "${String(lead.message || "(none)").slice(0, 400)}"` +
      (histTxt ? `\n\nCONVERSATION SO FAR (oldest first):\n${histTxt}` : "\n\n(no previous email exchange yet)");

    const task = hint && String(hint).trim()
      ? `Write this email. What it should be about: ${String(hint).trim()}`
      : `Write the next natural follow-up email given the conversation so far — pick up exactly where things left off, don't repeat what's already been said, don't restart the pitch from scratch.`;

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 700, system: sys, messages: [{ role: "user", content: `${task}\n\n${ctx}` }] }),
    });
    if (!res.ok) {
      const errText = await res.text();
      console.error("ANTHROPIC_ERROR", res.status, errText);
      return new Response(JSON.stringify({ error: `Anthropic ${res.status}: ${errText.slice(0, 300)}` }), { headers: { ...cors, "Content-Type": "application/json" } });
    }
    const data = await res.json();
    // claude-sonnet-5 puede anteponer bloques no-text al content array —
    // filtrar por type==="text" antes de parsear (mismo fix que cro-ideas).
    let t = ((data.content ?? []) as { type: string; text?: string }[])
      .filter((c) => c.type === "text").map((c) => c.text ?? "").join(" ").trim().replace(/```json|```/g, "");
    const m = t.match(/\{[\s\S]*\}/); if (m) t = m[0];
    let parsed: { subject?: string; body?: string } = {};
    try { parsed = JSON.parse(t); } catch { /* cae al error de abajo */ }
    if (!parsed.subject || !parsed.body) {
      return new Response(JSON.stringify({ error: "La IA devolvió un formato inesperado — probá de nuevo" }), { headers: { ...cors, "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ subject: parsed.subject, body: parsed.body }), { headers: { ...cors, "Content-Type": "application/json" } });
  } catch (e) {
    console.error("FUNCTION_ERROR", String(e));
    return new Response(JSON.stringify({ error: String(e) }), { headers: { ...cors, "Content-Type": "application/json" } });
  }
});
