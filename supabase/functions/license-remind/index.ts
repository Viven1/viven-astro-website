// Supabase Edge Function: license-remind
// Corre por CRON 1×/día: avisa al equipo (task + push, NUNCA email directo al
// cliente) cuando una licencia/renovación entra en la ventana de -90/-30/0 días.
// Dedupe: un marcador oculto en el título de la task ([LIC#id:milestone]) evita
// duplicar el aviso si el cron corre más de una vez el mismo día.
//
// Deploy:    supabase functions deploy license-remind --no-verify-jwt
// Schedule:  SQL 0048 (pg_cron, diario 06:30 UTC)
// Secrets:   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY (ya seteados)

import { createClient } from "jsr:@supabase/supabase-js@2";

const service = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const MILESTONES = [90, 30, 0];
// fix (auditoría 2026-07-14): invocable sin auth — cron-only, exige el secret compartido
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";

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

Deno.serve(async (req) => {
  if (CRON_SECRET && req.headers.get("Authorization") !== `Bearer ${CRON_SECRET}`) {
    return new Response("forbidden", { status: 403 });
  }
  try {
    const today = new Date().toLocaleString("sv-SE", { timeZone: "Europe/Zurich" }).slice(0, 10);
    const todayMs = Date.parse(today + "T00:00:00Z");

    const { data: licenses, error } = await service.from("licenses").select("*").eq("status", "active");
    if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 });

    const { data: existingTasks } = await service.from("lead_tasks").select("title").ilike("title", "%[LIC#%");
    const already = new Set((existingTasks ?? []).map((t) => t.title as string));

    let sent = 0;
    for (const lic of licenses ?? []) {
      const renewalMs = Date.parse(lic.renewal_date + "T00:00:00Z");
      const daysLeft = Math.round((renewalMs - todayMs) / 864e5);
      const milestone = MILESTONES.find((m) => m === daysLeft);
      if (milestone === undefined) continue;
      // el marcador incluye la renewal_date vigente — así, cuando se renueva
      // (misma fila, nueva fecha), el próximo ciclo genera marcadores NUEVOS
      // en vez de quedar dedupeado para siempre por los avisos del ciclo viejo
      const marker = `[LIC#${lic.id}:${lic.renewal_date}:${milestone}]`;
      if ([...already].some((t) => t.includes(marker))) continue;

      let lead: { name?: string; email?: string } | null = null;
      if (lic.lead_id) { const { data } = await service.from("leads").select("name,email").eq("id", lic.lead_id).maybeSingle(); lead = data; }
      const who = lead?.name || lead?.email || "Cliente";
      const when = milestone === 0 ? "HOY" : `en ${milestone} días`;
      const title = `🔄 Renovación ${when}: ${lic.title} — ${who} ${marker}`;

      await service.from("lead_tasks").insert({ lead_id: lic.lead_id, title, due_date: today, done: false });
      await pushAll(`🔄 Renovación ${when}`, `${lic.title} — ${who}${lic.amount ? " · CHF " + Number(lic.amount).toLocaleString("de-CH") : ""}`,
        lic.lead_id ? `/dashboard/?lead=${lic.lead_id}` : "/dashboard/");
      sent++;
    }
    return new Response(JSON.stringify({ ok: true, checked: (licenses ?? []).length, sent }), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    console.error("FUNCTION_ERROR", String(e));
    return new Response(JSON.stringify({ error: String(e) }), { status: 500 });
  }
});
