// Supabase Edge Function: task-remind
// Corre por CRON cada 5 min: busca tasks vencidas (fecha+hora, zona Europe/Zurich)
// que aún no se recordaron, y manda PUSH al responsable (o a todo el team) + email.
//
// Deploy:    supabase functions deploy task-remind --no-verify-jwt
// Schedule:  Supabase Dashboard → Edge Functions → task-remind → Schedules → */5 * * * *
// Secrets:   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, RESEND_API_KEY (ya seteados)

import { createClient } from "jsr:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const service = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
// fix (auditoría 2026-07-14): invocable sin auth cada 5 min — cron-only, exige el secret
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";

async function pushTo(email: string | null, title: string, body: string, url: string) {
  const pub = Deno.env.get("VAPID_PUBLIC_KEY"), priv = Deno.env.get("VAPID_PRIVATE_KEY");
  if (!pub || !priv) return;
  webpush.setVapidDetails("mailto:info@viven.ch", pub, priv);
  let q = service.from("push_subscriptions").select("*");
  if (email) q = q.eq("user_email", email.toLowerCase());
  const { data: subs } = await q;
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
    // "ahora" en hora suiza como 'YYYY-MM-DD HH:MM' (las tasks se cargan en hora local)
    const nowCH = new Date().toLocaleString("sv-SE", { timeZone: "Europe/Zurich" }).slice(0, 16);
    const { data: tasks, error } = await service.from("lead_tasks")
      .select("*").eq("done", false).eq("reminded", false).not("due_date", "is", null).limit(50);
    if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 });

    let sent = 0;
    for (const t of tasks ?? []) {
      const due = `${t.due_date} ${t.due_time || "09:00"}`;   // sin hora → recordar 09:00
      if (due > nowCH) continue;
      // nombre del lead para el contexto
      const { data: lead } = await service.from("leads").select("name,email").eq("id", t.lead_id).maybeSingle();
      const who = lead ? (lead.name || lead.email || "") : "";
      const title = "⏰ Task vencida: " + t.title;
      const body = (who ? who + " · " : "") + due.slice(11) + (t.assignee ? " · " + t.assignee.split("@")[0] : "");
      const url = "/dashboard/?lead=" + t.lead_id;
      await pushTo(t.assignee || null, title, body, url);
      // email de respaldo al responsable
      if (RESEND_API_KEY && t.assignee && /@viven\.ch$/i.test(t.assignee)) {
        await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { "Authorization": `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({ from: "Viven Dashboard <leads@viven.ch>", to: [t.assignee], subject: title,
            html: `<p style="font-family:sans-serif">${body}<br><a href="https://www.viven.ch${url}">Abrir en el dashboard →</a></p>` }),
        }).catch(() => {});
      }
      await service.from("lead_tasks").update({ reminded: true }).eq("id", t.id);
      sent++;
    }
    return new Response(JSON.stringify({ ok: true, sent }), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    console.error("FUNCTION_ERROR", String(e));
    return new Response(JSON.stringify({ error: String(e) }), { status: 500 });
  }
});
