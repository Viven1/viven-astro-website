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
    const detalle: Array<Record<string, string>> = [];
    for (const lic of licenses ?? []) {
      const renewalMs = Date.parse(lic.renewal_date + "T00:00:00Z");
      const daysLeft = Math.round((renewalMs - todayMs) / 864e5);
      /* Los hitos son 90/30/0 días ANTES. Si la fecha pasa sin que nadie cierre la
         licencia, daysLeft se vuelve negativo, ningún hito coincide y la función se
         calla para siempre: la licencia queda "activa" y vencida sin que nadie se
         entere. Pasó con la de Sonova — se cargó el mismo 13 de julio que vencía, el
         cron de esa mañana ya había corrido, y estuvo 43 días vencida en silencio con
         todos los indicadores en verde. Ahora hay un hito para eso, que avisa una sola
         vez (el marcador lleva la fecha, así que renovarla lo reinicia). */
      const vencida = daysLeft < 0;
      const milestone = vencida ? -1 : MILESTONES.find((m) => m === daysLeft);
      if (milestone === undefined) continue;
      // el marcador incluye la renewal_date vigente — así, cuando se renueva
      // (misma fila, nueva fecha), el próximo ciclo genera marcadores NUEVOS
      // en vez de quedar dedupeado para siempre por los avisos del ciclo viejo
      const marker = `[LIC#${lic.id}:${lic.renewal_date}:${vencida ? "vencida" : milestone}]`;
      if ([...already].some((t) => t.includes(marker))) continue;
      /* Sin cliente atado no hay tarea donde dejar el marcador, así que se guarda en la
         propia licencia (SQL 0146). Sin esto el push salía todos los días. */
      if (!lic.lead_id && lic.last_alert === marker) continue;

      let lead: { name?: string; email?: string } | null = null;
      if (lic.lead_id) { const { data } = await service.from("leads").select("name,email").eq("id", lic.lead_id).maybeSingle(); lead = data; }
      const who = lead?.name || lead?.email || "Cliente";
      const when = vencida ? `VENCIDA hace ${-daysLeft} días` : milestone === 0 ? "HOY" : `en ${milestone} días`;
      const title = `${vencida ? "⚠️ Licencia" : "🔄 Renovación"} ${when}: ${lic.title} — ${who} ${marker}`;

      /* lead_tasks.lead_id es NOT NULL, y una licencia puede no tener cliente atado:
         las dos que hay están así. El insert se caía en silencio y la función devolvía
         igual sent:1 — verde por fuera, cero avisos por dentro. Ahora, sin cliente, no
         se intenta la tarea (no hay dónde colgarla) pero el push sale igual, y la
         respuesta dice cuál de las dos cosas pasó. */
      let tarea = "sin cliente atado — solo push";
      if (lic.lead_id) {
        const { error: tErr } = await service.from("lead_tasks").insert({ lead_id: String(lic.lead_id), title, due_date: today, done: false });
        tarea = tErr ? ("no se pudo crear la tarea: " + tErr.message) : "tarea creada";
        if (tErr) console.error("license-remind:", tErr.message);
      }
      if (!lic.lead_id) await service.from("licenses").update({ last_alert: marker }).eq("id", lic.id);
      detalle.push({ licencia: lic.title, aviso: when, tarea });
      await pushAll(vencida ? `⚠️ Licencia ${when}` : `🔄 Renovación ${when}`, `${lic.title} — ${who}${lic.amount ? " · CHF " + Number(lic.amount).toLocaleString("de-CH") : ""}`,
        lic.lead_id ? `/dashboard/?lead=${lic.lead_id}` : "/dashboard/");
      sent++;
    }
    return new Response(JSON.stringify({ ok: true, checked: (licenses ?? []).length, sent, detalle }), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    console.error("FUNCTION_ERROR", String(e));
    return new Response(JSON.stringify({ error: String(e) }), { status: 500 });
  }
});
