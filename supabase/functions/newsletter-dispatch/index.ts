// Supabase Edge Function: newsletter-dispatch
// Despacha las campañas de newsletter PROGRAMADAS cuya hora (scheduled_at) ya
// pasó, invocando newsletter-send por cada una con el service role real.
//
// ACTIVA desde el 12 ago 2026 (migración 0120_newsletter_dispatch_cron.sql).
// Antes existía pero no estaba enganchada a ningún cron: "Programar fecha y hora"
// en el dashboard guardaba la fecha y no pasaba nada nunca. Sebastián pidió
// encenderla.
//
// HORARIO LABORAL SUIZO — ACÁ VIVE LA REGLA (única fuente de verdad):
//   lunes a viernes, 09:00–12:00 y 13:30–17:00, hora de Zúrich.
//   EL CORTE DEL MEDIODÍA ES A PROPÓSITO, confirmado por Sebastián: no se
//   unifica en un solo bloque 09:00–17:00. Nada sale fuera de esas ventanas.
//   Se calcula con Intl en Europe/Zurich, así que el cambio de hora (CET/CEST)
//   sale bien solo — por eso la regla NO está en el cron de Postgres, que solo
//   entiende UTC. El cron corre cada 15 min en una ventana UTC amplia y esta
//   función decide; una corrida fuera de horario contesta {skipped:true} y no
//   manda nada.
//   Si programás algo para un sábado a las 10, sale el lunes a las 09:00.
//
// GUARDA DE VENCIMIENTO: no despacha nada programado hace más de 48 h. Sin esto,
// el día que se enciende el cron cualquier borrador viejo con scheduled_at en el
// pasado saldría de golpe a toda la base. Esas quedan reportadas como "vencida"
// para que Sebastián las reprograme a mano.
//
// Se puede pedir { dry_run: true } para ver qué haría sin mandar nada.
//
// Deploy:  supabase functions deploy newsletter-dispatch --no-verify-jwt
// Auth:    Authorization: Bearer <CRON_SECRET>  (mismo patrón que el resto de los
//          crons — ver 0081_cron_secret_headers.sql; el secret sale del Vault).
// Usa:     SERVICE_ROLE para leer/actualizar, e invoca newsletter-send.

import { createClient } from "jsr:@supabase/supabase-js@2";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

// ---- horario laboral suizo: vive en _shared/horario.ts, compartido con
// newsletter-send. Una sola regla para el que programa y el que manda.
import { enHorarioLaboral, zurich } from "../_shared/horario.ts";

const VENCE_MS = 48 * 60 * 60 * 1000;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  // mismo gate que el resto de los crons: sin el secret, nadie dispara envíos
  if (CRON_SECRET && req.headers.get("Authorization") !== `Bearer ${CRON_SECRET}`) {
    return json({ error: "unauthorized" }, 401);
  }
  try {
    const body = await req.json().catch(() => ({}));
    const dryRun = !!body?.dry_run;
    const admin = createClient(SB_URL, SERVICE);
    const now = new Date();
    const nowIso = now.toISOString();
    const zh = zurich(now);

    // borradores/programados con hora vencida y que todavía no se enviaron
    const { data: due, error } = await admin.from("newsletters")
      .select("id,subject,scheduled_at,status")
      .neq("status", "sent")
      .not("scheduled_at", "is", null)
      .lte("scheduled_at", nowIso);
    if (error) return json({ error: error.message }, 500);

    /* Y las ediciones mensuales automáticas, que hasta hoy solo se podían mandar a mano.
       Van en la MISMA cola y con la misma ventana horaria: para el que recibe es el mismo
       newsletter, y tener dos motores con dos criterios de horario es la forma segura de
       que uno de los dos mande un domingo a las 3 de la mañana.
       (Sebastián, 2 sep 2026: "lo quiero programar para mañana no ahora".) */
    const { data: dueIss } = await admin.from("newsletter_issues")
      .select("id,month,scheduled_at,status,content")
      .eq("status", "draft")
      .not("scheduled_at", "is", null)
      .lte("scheduled_at", nowIso);
    const issues = ((dueIss || []) as { id: string; month: string; scheduled_at: string; content: Record<string, { subject?: string }> | null }[])
      .map((i) => ({ id: i.id, subject: (i.content?.en?.subject) || i.month, scheduled_at: i.scheduled_at, esIssue: true }));

    const pendientes = (due || []) as { id: string; subject: string; scheduled_at: string }[];
    const vencidas = pendientes.filter((n) => now.getTime() - Date.parse(n.scheduled_at) > VENCE_MS);
    const listas = pendientes.filter((n) => now.getTime() - Date.parse(n.scheduled_at) <= VENCE_MS);

    // fuera de horario laboral suizo: no se manda nada, se espera la próxima ventana
    const abierto = enHorarioLaboral(now);
    if (!abierto || dryRun) {
      return json({
        ok: true,
        dispatched: 0,
        skipped: true,
        motivo: abierto ? "dry_run" : "fuera de horario laboral suizo",
        zurich: zh.label,
        horario: "Lun-Vie 09:00-12:00 y 13:30-17:00 (Europe/Zurich)",
        en_horario: abierto,
        dry_run: dryRun,
        listas: listas.map((n) => ({ id: n.id, subject: n.subject, scheduled_at: n.scheduled_at })),
        ediciones: issues.map((n) => ({ id: n.id, subject: n.subject, scheduled_at: n.scheduled_at })),
        vencidas: vencidas.map((n) => ({ id: n.id, subject: n.subject, scheduled_at: n.scheduled_at })),
      });
    }

    if (vencidas.length) {
      console.error("DISPATCH_VENCIDAS", "no se despachan (programadas hace +48h):",
        vencidas.map((n) => n.id + " @" + n.scheduled_at).join(", "));
    }

    const results: { id: string; ok: boolean; sent?: number; failed?: number; error?: string }[] = [];
    /* Las vencidas de las ediciones se filtran igual que las manuales: una programada hace
       más de 48 h ya no se manda sola — el contexto cambió y mandarla sería peor que no. */
    const issVencidas = issues.filter((n) => now.getTime() - Date.parse(n.scheduled_at) > VENCE_MS);
    const issListas = issues.filter((n) => !issVencidas.includes(n));
    if (issVencidas.length) console.error("DISPATCH_ISSUES_VENCIDAS", issVencidas.map((n) => n.id).join(", "));

    for (const nl of [...listas, ...issListas]) {
      try {
        const esIssue = !!(nl as { esIssue?: boolean }).esIssue;
        const res = await fetch(`${SB_URL}/functions/v1/newsletter-send`, {
          method: "POST",
          headers: { Authorization: "Bearer " + SERVICE, "Content-Type": "application/json" },
          body: JSON.stringify(esIssue ? { issue_id: nl.id } : { id: nl.id }),
        });
        const out = await res.json().catch(() => ({}));
        results.push({ id: nl.id, ok: res.ok && !out.error, sent: out.sent, failed: out.failed, error: out.error });
      } catch (e) {
        results.push({ id: nl.id, ok: false, error: String(e) });
      }
    }
    return json({
      ok: true, dispatched: results.length, zurich: zh.label, results,
      vencidas: vencidas.map((n) => ({ id: n.id, subject: n.subject, scheduled_at: n.scheduled_at })),
    });
  } catch (e) {
    console.error("DISPATCH_ERROR", String(e));
    return json({ error: String(e) }, 500);
  }
});
