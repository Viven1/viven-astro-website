// Supabase Edge Function: stale-remind
// Corre por CRON 1×/día: detecta PERSONAS con más de 5 semanas sin contacto ni
// actividad (notas, tasks, ofertas, propuestas, bookings, follow-ups enviados)
// y avisa al team: push a todos + task "⏰ Sin contacto" en el contacto (aparece
// en la campanita y en Necesita atención). Perdidos quedan fuera; se deduplica
// con la task abierta — al completarla (o al haber actividad) el reloj arranca de nuevo.
//
// Deploy:    supabase functions deploy stale-remind --no-verify-jwt
// Schedule:  SQL 0026 (pg_cron, diario)
// Secrets:   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY (ya seteados)

import { createClient } from "jsr:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const service = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
// fix (auditoría 2026-07-14): invocable sin auth — cron-only, exige el secret compartido
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";

const STALE_DAYS = 35;          // 5 semanas
const MAX_PER_RUN = 10;         // tope por corrida (que el primer día no sea un aluvión)
const TASK_PREFIX = "⏰ Sin contacto";

async function pushAll(title: string, body: string, url: string) {
  const pub = Deno.env.get("VAPID_PUBLIC_KEY"), priv = Deno.env.get("VAPID_PRIVATE_KEY");
  if (!pub || !priv) return;
  webpush.setVapidDetails("mailto:info@viven.ch", pub, priv);
  const { data: subs } = await service.from("push_subscriptions").select("*");
  const payload = JSON.stringify({ title, body, url });
  for (const s of subs ?? []) {
    try { await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload); }
    catch (e) { const c = (e as { statusCode?: number }).statusCode; if (c === 404 || c === 410) await service.from("push_subscriptions").delete().eq("id", s.id); }
  }
}

Deno.serve(async (req) => {
  if (CRON_SECRET && req.headers.get("Authorization") !== `Bearer ${CRON_SECRET}`) {
    return new Response("forbidden", { status: 403 });
  }
  try {
    const now = Date.now();
    const cutoff = now - STALE_DAYS * 864e5;

    const { data: leads, error } = await service.from("leads").select("*").limit(5000);
    if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 });

    // actividad por lead desde todas las fuentes (best-effort: tabla ausente = se ignora)
    const last: Record<string, number> = {};
    const bump = (lid: unknown, iso: string | null) => {
      if (!lid || !iso) return;
      const t = Date.parse(iso); if (!t) return;
      const k = String(lid);
      if (!last[k] || t > last[k]) last[k] = t;
    };
    for (const l of leads ?? []) {
      ["created_at", "contacted_at", "videocall_at", "proposal_at", "won_at", "last_stage_at"].forEach((f) => bump(l.id, l[f]));
    }
    const src = async (table: string, fields: string[]) => {
      const { data, error: e } = await service.from(table).select("lead_id," + fields.join(",")).limit(10000);
      if (e) return;
      for (const r of data ?? []) fields.forEach((f) => bump(r.lead_id, (r as Record<string, string | null>)[f]));
    };
    await src("lead_notes", ["created_at"]);
    await src("lead_tasks", ["created_at", "done_at"]);
    await src("offers", ["updated_at"]);
    await src("proposals", ["updated_at"]);
    await src("bookings", ["created_at"]);
    // fix (auditoría 2026-07-14): lead_followups NO tiene columna updated_at (solo
    // sent_at) — pedirla hacía que PostgREST devolviera error y la función lo tragaba
    // en silencio (if (e) return), perdiendo esta fuente de actividad por completo.
    // Alguien con un follow-up recién mandado podía marcarse igual como "sin contacto".
    await src("lead_followups", ["sent_at"]);

    // tasks de recordatorio abiertas → no duplicar el aviso
    const { data: openT } = await service.from("lead_tasks").select("lead_id,title").eq("done", false).ilike("title", TASK_PREFIX + "%");
    const already = new Set((openT ?? []).map((t) => String(t.lead_id)));

    const isLost = (s: string | null) => /perdido|lost/i.test(s || "");
    const stale = (leads ?? [])
      .filter((l) => !isLost(l.status) && !already.has(String(l.id)))
      .map((l) => ({ l, at: last[String(l.id)] || Date.parse(l.created_at) || now }))
      .filter((x) => x.at < cutoff)
      .sort((a, b) => b.at - a.at)           // los "menos fríos" primero: más chance de rescatarlos
      .slice(0, MAX_PER_RUN);

    const today = new Date().toLocaleString("sv-SE", { timeZone: "Europe/Zurich" }).slice(0, 10);
    let sent = 0;
    for (const { l, at } of stale) {
      const weeks = Math.floor((now - at) / (7 * 864e5));
      const who = l.name || l.email || "Contacto";
      const lastStr = new Date(at).toLocaleDateString("de-CH", { day: "2-digit", month: "short", timeZone: "Europe/Zurich" });
      // task en el contacto (campanita + Necesita atención); reminded=true → task-remind no re-pushea
      await service.from("lead_tasks").insert({
        lead_id: l.id, title: `${TASK_PREFIX} hace ${weeks} semanas — retomar`,
        due_date: today, done: false, reminded: true,
      });
      await pushAll(`👋 ${who} — ${weeks} semanas sin contacto`,
        `Última actividad: ${lastStr}. Tocá para abrir y mandar un follow-up.`,
        `/dashboard/?lead=${l.id}`);
      sent++;
    }
    return new Response(JSON.stringify({ ok: true, checked: (leads ?? []).length, stale: stale.length, sent }), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    console.error("FUNCTION_ERROR", String(e));
    return new Response(JSON.stringify({ error: String(e) }), { status: 500 });
  }
});
