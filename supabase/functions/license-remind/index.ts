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
import webpush from "npm:web-push@3.6.7";

const service = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const MILESTONES = [90, 30, 0];
// fix (auditoría 2026-07-14): invocable sin auth — cron-only, exige el secret compartido
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";

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
