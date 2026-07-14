// Supabase Edge Function: newsletter-dispatch
// Despacha las campañas de newsletter PROGRAMADAS cuya hora (scheduled_at) ya
// pasó, invocando newsletter-send con { id, internal:true } por cada una.
//
// ⚠️ INERTE POR DISEÑO: esta función existe pero NO está enganchada a ningún
// cron. La política del proyecto (0060_pause_outbound_email_crons.sql) mantiene
// TODOS los crons de email saliente en pausa hasta que el dueño los active en
// persona. Para activar el scheduling, descomentar y correr el bloque cron.schedule
// de la migración 0075 (requiere pg_cron + net + el service role key).
//
// Deploy:  supabase functions deploy newsletter-dispatch --no-verify-jwt
// Usa:     SERVICE_ROLE para leer/actualizar, e invoca newsletter-send.

import { createClient } from "jsr:@supabase/supabase-js@2";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const admin = createClient(SB_URL, SERVICE);
    const nowIso = new Date().toISOString();
    // borradores/programados con hora vencida y que todavía no se enviaron
    const { data: due, error } = await admin.from("newsletters")
      .select("id,subject,scheduled_at,status")
      .neq("status", "sent")
      .not("scheduled_at", "is", null)
      .lte("scheduled_at", nowIso);
    if (error) return json({ error: error.message }, 500);

    const results: { id: string; ok: boolean; sent?: number; failed?: number; error?: string }[] = [];
    for (const nl of (due || []) as { id: string; subject: string }[]) {
      try {
        const res = await fetch(`${SB_URL}/functions/v1/newsletter-send`, {
          method: "POST",
          headers: { Authorization: "Bearer " + SERVICE, "Content-Type": "application/json" },
          body: JSON.stringify({ id: nl.id, internal: true }),
        });
        const out = await res.json().catch(() => ({}));
        results.push({ id: nl.id, ok: res.ok && !out.error, sent: out.sent, failed: out.failed, error: out.error });
      } catch (e) {
        results.push({ id: nl.id, ok: false, error: String(e) });
      }
    }
    return json({ ok: true, dispatched: results.length, results });
  } catch (e) {
    console.error("DISPATCH_ERROR", String(e));
    return json({ error: String(e) }, 500);
  }
});
