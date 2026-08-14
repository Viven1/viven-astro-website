// Supabase Edge Function: cro-ideas
// 🧪 MOTOR DE CRO SEMANAL: cada lunes (cron SQL 0112) junta un snapshot REAL del
// sitio (funnels con drop-off 7/28d, señales de fricción, páginas de entrada,
// A/B tests corriendo con sus conversiones, leads/ganados por canal en CHF) y le
// pide a Anthropic 3-5 ideas CONCRETAS de mejora/test — cada una anclada a un
// dato del snapshot, sin recetas genéricas. Guarda en cro_ideas (1 fila por
// semana, idempotente) y avisa por push. El dashboard (Analytics → 🧪 CRO) las
// muestra y permite regenerar con {force:true}.
//
// Deploy:   supabase functions deploy cro-ideas --no-verify-jwt
// Schedule: SQL 0112 (cron lunes 05:00 UTC, vault cron_secret)
// Secrets:  ANTHROPIC_API_KEY, CRON_SECRET, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY (ya seteados)

import { createClient } from "jsr:@supabase/supabase-js@2";

const service = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
// mismo patrón de auth que content-engine: el cron llama con el secret compartido,
// el botón 🔄 del dashboard con el JWT real del usuario — nunca una llamada anónima.
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

// lunes de la semana actual (UTC) como 'YYYY-MM-DD' — la clave de idempotencia
function weekStart(): string {
  const now = new Date();
  const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - ((now.getUTCDay() + 6) % 7)));
  return monday.toISOString().slice(0, 10);
}

/* Delegar en push-send, que manda Web Push Y APNs. Estaba reimplementado acá
 * y solo salía por Web Push: al iPhone, donde los avisos van por APNs, no
 * llegaba NUNCA. (14 ago 2026 — Sebastián: "quiero notificaciones de blogs a
 * publicar, emails que tenemos que aprobar, nuevas leads". Los avisos existían;
 * el teléfono no era destinatario de ninguno.) */
async function pushAll(title: string, body: string, url: string) {
  await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/push-send`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") },
    body: JSON.stringify({ title, body, url }),
  }).catch((e) => console.error("PUSH_ERROR", String(e)));
}

// ---------------------------------------------------------------------------
// Snapshot server-side: TODO con service role, el cliente nunca ve filas crudas.
// Cada bloque es best-effort (si un RPC falta, el snapshot sale sin ese bloque
// y la IA trabaja con lo que hay) — un dato menos nunca tumba la generación.
// ---------------------------------------------------------------------------
type FunnelStep = { step: number; label: string; sessions: number; drop_pct: number | null };

async function funnelSnapshot(funnel: string, days: number): Promise<FunnelStep[]> {
  const { data, error } = await service.rpc("rpc_funnel_steps", { p_funnel: funnel, p_days: days });
  if (error || !Array.isArray(data)) return [];
  let prev: number | null = null;
  return (data as { step: number; label: string; sessions: number }[]).map((r) => {
    const n = Number(r.sessions) || 0;
    const drop = prev != null && prev > 0 ? Math.round((1 - n / prev) * 100) : null;
    prev = n;
    return { step: r.step, label: r.label || String(r.step), sessions: n, drop_pct: drop };
  });
}

async function buildSnapshot() {
  const FUNNELS = ["calc", "brief", "magnet"];
  const snapshot: Record<string, unknown> = { generated_at: new Date().toISOString() };

  // 1) funnels 7 y 28 días con drop-off por paso
  const funnels: Record<string, { d7: FunnelStep[]; d28: FunnelStep[] }> = {};
  for (const f of FUNNELS) {
    const [d7, d28] = await Promise.all([funnelSnapshot(f, 7), funnelSnapshot(f, 28)]);
    funnels[f] = { d7, d28 };
  }
  snapshot.funnels = funnels;

  // 2) top 10 señales de fricción 28d (rage / dead / jserror)
  try {
    const { data } = await service.rpc("rpc_ux_signals", { p_days: 28 });
    snapshot.ux_signals_28d = (Array.isArray(data) ? data : []).slice(0, 10);
  } catch (_) { snapshot.ux_signals_28d = []; }

  // 3) top 10 páginas de entrada 28d con % de rebote
  try {
    const { data } = await service.rpc("rpc_entry_pages", { p_days: 28 });
    snapshot.entry_pages_28d = (Array.isArray(data) ? data : []).slice(0, 10).map((r: { landing: string; sessions: number; bounces: number; avg_pages: number }) => {
      const s = Number(r.sessions) || 0, b = Number(r.bounces) || 0;
      return { landing: r.landing, sessions: s, bounce_pct: s ? Math.round((b / s) * 100) : 0, avg_pages: Number(r.avg_pages) || 0 };
    });
  } catch (_) { snapshot.entry_pages_28d = []; }

  // 4) A/B tests activos: exposiciones únicas por bucket (ab_hits) + conversiones
  //    (leads.ab guarda tags "id:bucket" separados por coma — vvAbTags en site.js)
  try {
    const { data: tests } = await service.from("ab_tests").select("id,name,url_path,status,split_pct,start_at").eq("status", "running");
    const active = tests ?? [];
    if (active.length) {
      const ids = active.map((t: { id: number }) => t.id);
      const [{ data: hits }, { data: abLeads }] = await Promise.all([
        service.from("ab_hits").select("test_id,bucket,session_id").in("test_id", ids).limit(50000),
        service.from("leads").select("id,ab").not("ab", "is", null).limit(5000),
      ]);
      const exp: Record<string, Set<string>> = {};
      (hits ?? []).forEach((h: { test_id: number; bucket: string; session_id: string | null }) => {
        if (/^claude-/.test(h.session_id || "")) return; // sesiones de test internas
        const k = h.test_id + ":" + h.bucket;
        (exp[k] = exp[k] || new Set()).add(h.session_id || crypto.randomUUID());
      });
      const convOf = (id: number, bucket: string) =>
        (abLeads ?? []).filter((l: { ab: string | null }) => String(l.ab || "").split(",").includes(id + ":" + bucket)).length;
      snapshot.ab_tests_running = active.map((t: { id: number; name: string | null; url_path: string; split_pct: number; start_at: string | null }) => ({
        id: t.id, name: t.name, url_path: t.url_path, split_pct: t.split_pct, start_at: t.start_at,
        a: { sessions: (exp[t.id + ":a"] || new Set()).size, leads: convOf(t.id, "a") },
        b: { sessions: (exp[t.id + ":b"] || new Set()).size, leads: convOf(t.id, "b") },
      }));
    } else snapshot.ab_tests_running = [];
  } catch (_) { snapshot.ab_tests_running = []; }

  // 5) leads y ganados por canal 28d, con CHF de los deals ganados
  try {
    const since = new Date(Date.now() - 28 * 864e5).toISOString();
    const [{ data: leads }, { data: won }] = await Promise.all([
      service.from("leads").select("id,channel").gte("created_at", since).limit(5000),
      service.from("deals").select("lead_id,deal_value").eq("stage", "ganado").gte("won_at", since).limit(1000),
    ]);
    const wonLeadIds = [...new Set((won ?? []).map((d: { lead_id: number | string }) => d.lead_id).filter((x) => x != null))];
    // el lead de un deal ganado puede ser más viejo que 28d — su canal se busca aparte
    const { data: wonLeads } = wonLeadIds.length
      ? await service.from("leads").select("id,channel").in("id", wonLeadIds)
      : { data: [] as { id: number | string; channel: string | null }[] };
    const chOfLead: Record<string, string> = {};
    (wonLeads ?? []).forEach((l: { id: number | string; channel: string | null }) => { chOfLead[String(l.id)] = l.channel || "(directo)"; });
    const channels: Record<string, { leads: number; won: number; won_chf: number }> = {};
    (leads ?? []).forEach((l: { channel: string | null }) => {
      const c = l.channel || "(directo)";
      (channels[c] = channels[c] || { leads: 0, won: 0, won_chf: 0 }).leads++;
    });
    (won ?? []).forEach((d: { lead_id: number | string; deal_value: number | null }) => {
      const c = chOfLead[String(d.lead_id)] || "(directo)";
      const e = (channels[c] = channels[c] || { leads: 0, won: 0, won_chf: 0 });
      e.won++; e.won_chf += Number(d.deal_value) || 0;
    });
    snapshot.channels_28d = channels;
  } catch (_) { snapshot.channels_28d = {}; }

  return snapshot;
}

// ---------------------------------------------------------------------------
// Generación: prompt con el snapshot + los títulos de las últimas 4 semanas
// (para no repetir ideas), salida SOLO JSON con el contrato del dashboard.
// ---------------------------------------------------------------------------
type Idea = { title: string; hypothesis: string; evidence: string; where: string; type: string; effort: string; impact: number; how: string };

async function generateIdeas(snapshot: Record<string, unknown>, previousTitles: string[]): Promise<Idea[]> {
  const prompt = `Sos el CRO (conversion rate optimization) de viven.ch — productora de video suiza B2B en Zúrich (clientes: UBS, Siemens, Porsche, FIFA). El objetivo de cada página es generar leads: formulario de contacto, calculadora de costos, brief de proyecto, lead magnet o book-a-call.

Este es el snapshot REAL de datos del sitio de esta semana (funnels con % de drop-off por paso a 7 y 28 días; top señales de fricción rage/dead/jserror; páginas de entrada con rebote; A/B tests corriendo con sesiones y leads por variante; leads y deals ganados por canal en CHF, últimos 28 días):

${JSON.stringify(snapshot)}

${previousTitles.length ? `Ideas YA PROPUESTAS en las últimas semanas — NO las repitas ni propongas variantes triviales de ellas:\n${previousTitles.map((t) => "- " + t).join("\n")}\n` : ""}
Proponé entre 3 y 5 ideas de mejora de conversión para ESTA semana, ordenadas por impact descendente. Reglas estrictas:
- NADA genérico ("mejorar el copy", "hacer la página más rápida"): cada idea tiene que estar anclada a un dato CONCRETO del snapshot, citado en "evidence" (número real: % de drop-off de tal paso, % de rebote de tal landing, X hits de rage click en tal selector, conversión A vs B de tal test, CHF por canal…).
- Si un dato del snapshot está vacío o con poco volumen, no inventes: trabajá con los bloques que sí tienen señal.
- "how": cómo implementarlo o testearlo, en 1-2 frases accionables.
- "type": "ab_test" si se valida con un experimento A/B, "fix" si es un arreglo directo (bug, fricción, link roto), "experiment" para apuestas nuevas medibles sin split.
- "effort": "S" (horas), "M" (1-2 días), "L" (más).
- "impact": 1-5 (potencial sobre leads/ganados).
- "where": página o flujo exacto (path o nombre del funnel).

Respondé SOLO con JSON válido minificado, sin markdown:
{"ideas":[{"title":"...","hypothesis":"...","evidence":"...","where":"...","type":"ab_test|fix|experiment","effort":"S|M|L","impact":1,"how":"..."}]}`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 3500,
      system: "You output ONLY a single valid minified JSON object. No markdown, no code fences, no commentary.",
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) throw new Error("Anthropic " + res.status + " " + (await res.text()).slice(0, 200));
  const data = await res.json();
  // claude-sonnet-5 puede anteponer bloques que no son texto — quedarse solo con type:"text"
  let text = ((data.content ?? []) as { type: string; text?: string }[])
    .filter((c) => c.type === "text").map((c) => c.text ?? "").join(" ").trim();
  text = text.replace(/```json|```/g, "").trim();
  // sin prefill (claude-sonnet-5 no lo soporta): extraer del primer { en adelante
  const first = text.indexOf("{");
  if (first > 0) text = text.slice(first);
  const last = text.lastIndexOf("}");
  if (last > -1) text = text.slice(0, last + 1);
  let parsed: { ideas?: unknown[] } | null = null;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  if (!parsed || !Array.isArray(parsed.ideas) || !parsed.ideas.length) {
    console.error("CRO_PARSE_FAIL raw:", text.slice(0, 400), "stop:", data.stop_reason);
    throw new Error("la IA no devolvió ideas válidas");
  }
  const ideas = (parsed.ideas as Record<string, unknown>[]).map((i) => ({
    title: String(i.title ?? "").slice(0, 200),
    hypothesis: String(i.hypothesis ?? ""),
    evidence: String(i.evidence ?? ""),
    where: String(i.where ?? ""),
    type: ["ab_test", "fix", "experiment"].includes(String(i.type)) ? String(i.type) : "experiment",
    effort: ["S", "M", "L"].includes(String(i.effort)) ? String(i.effort) : "M",
    impact: Math.max(1, Math.min(5, Math.round(Number(i.impact) || 3))),
    how: String(i.how ?? ""),
  })).filter((i) => i.title);
  ideas.sort((a, b) => b.impact - a.impact);
  return ideas.slice(0, 5);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const authHdr = req.headers.get("Authorization") ?? "";
  const isCron = !!CRON_SECRET && authHdr === `Bearer ${CRON_SECRET}`;
  if (!isCron) {
    const supabaseAuth = createClient(SB_URL, SB_ANON, { global: { headers: { Authorization: authHdr } } });
    const { data: { user } } = await supabaseAuth.auth.getUser();
    if (!user) return json({ error: "unauthorized" }, 401);
  }
  try {
    const body = await req.json().catch(() => ({}));
    const ws = weekStart();

    // idempotente: si la semana ya tiene ideas y no viene {force:true} (botón 🔄
    // del dashboard), se devuelve lo que hay — el cron puede reintentar sin duplicar.
    const { data: existing, error: exErr } = await service.from("cro_ideas").select("*").eq("week_start", ws).maybeSingle();
    if (exErr) return json({ error: exErr.message + " — ¿ya corriste el SQL 0112?" }, 500);
    if (existing && !body.force) return json({ ok: true, week_start: ws, ideas: existing.ideas, cached: true });

    // títulos de las últimas 4 semanas → "ya propuestas, no repetir"
    const { data: prevRows } = await service.from("cro_ideas").select("week_start,ideas").neq("week_start", ws).order("week_start", { ascending: false }).limit(4);
    const previousTitles = (prevRows ?? []).flatMap((r: { ideas: unknown }) =>
      (Array.isArray(r.ideas) ? r.ideas : []).map((i: { title?: string }) => String(i.title ?? "")).filter(Boolean));

    const snapshot = await buildSnapshot();
    const ideas = await generateIdeas(snapshot, previousTitles);

    const row = { week_start: ws, ideas, data_snapshot: snapshot };
    const up = existing
      ? await service.from("cro_ideas").update(row).eq("id", existing.id)
      : await service.from("cro_ideas").insert(row);
    if (up.error) return json({ error: "no pude guardar las ideas: " + up.error.message }, 500);

    await pushAll("🧪 Ideas CRO de la semana listas", ideas.length + " ideas nuevas ancladas a tus datos — " + ideas[0].title, "/dashboard/?tab=analytics&sub=cro");
    return json({ ok: true, week_start: ws, ideas, regenerated: !!existing });
  } catch (e) {
    console.error("FUNCTION_ERROR", String(e));
    return json({ error: String(e) }, 500);
  }
});
