// Supabase Edge Function: cashflow-alert
// Corre por CRON 1×/día: proyecta el saldo de Viven AG a 12 meses (misma lógica
// que el motor client-side del tab Cash Flow del dashboard) y, si el primer mes
// que cruza el umbral mínimo cambió desde el último aviso, manda un email DIRECTO
// (no pasa por el Outbox — eso es solo para comunicación con clientes/leads
// externos; esto es un alerta interno de ops a Sebastián).
//
// Deploy:    supabase functions deploy cashflow-alert --no-verify-jwt
// Schedule:  SQL 0079 (pg_cron, diario 06:17 UTC)
// Secrets:   RESEND_API_KEY (ya seteado)

import { createClient } from "jsr:@supabase/supabase-js@2";

const service = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
// fix (auditoría 2026-07-14): deployada con --no-verify-jwt y sin ningún chequeo propio,
// esta función era invocable por cualquiera sin login — filtraba una señal financiera
// parcial (si hay o no un mes en rojo) y podía mutar last_alerted_period/disparar el
// email fuera de horario. Mismo patrón que ya usa lead-followup (CRON_SECRET). Queda
// INERTE (no bloquea nada) hasta que el secret CASHFLOW_CRON_SECRET exista de verdad.
const CASHFLOW_CRON_SECRET = Deno.env.get("CASHFLOW_CRON_SECRET") ?? "";

type Entry = { kind: "income" | "expense"; amount_chf: number; due_date: string; status: string };
type Template = {
  kind: "income" | "expense"; amount_chf: number; frequency: "monthly" | "quarterly" | "yearly";
  day_of_month: number; start_date: string; end_date: string | null; active: boolean;
};
type Loan = { monthly_payment_chf: number; start_date: string; end_date: string };

const chf = (n: number) => "CHF " + Math.round(n).toLocaleString("de-CH");
const ymKey = (d: Date) => d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0");
const monthLabel = (ym: string) => {
  const [y, m] = ym.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("es-CH", { month: "long", year: "numeric", timeZone: "UTC" });
};

// Proyección mensual a 12 meses — misma lógica que cfProject() en el dashboard:
// saldo actual + entries futuras + recurrentes activos expandidos + préstamos expandidos.
function projectMonthly(startBalance: number, entries: Entry[], templates: Template[], loans: Loan[]) {
  const today = new Date();
  const monthStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  const months: { ym: string; delta: number; balance: number }[] = [];
  let running = startBalance;

  for (let i = 0; i < 12; i++) {
    const mStart = new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + i, 1));
    const mEnd = new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + i + 1, 1));
    const ym = ymKey(mStart);
    let delta = 0;

    // entries manuales/Bexio con due_date en este mes
    for (const e of entries) {
      const d = new Date(e.due_date + "T00:00:00Z");
      if (d >= mStart && d < mEnd) delta += e.kind === "income" ? Number(e.amount_chf) : -Number(e.amount_chf);
    }

    // recurrentes activos expandidos según frequency/day_of_month
    for (const t of templates) {
      if (!t.active) continue;
      const s = new Date(t.start_date + "T00:00:00Z");
      const e = t.end_date ? new Date(t.end_date + "T00:00:00Z") : null;
      if (s >= mEnd) continue;
      if (e && e < mStart) continue;
      const occursThisMonth =
        t.frequency === "monthly" ||
        (t.frequency === "quarterly" && (mStart.getUTCFullYear() * 12 + mStart.getUTCMonth() - (s.getUTCFullYear() * 12 + s.getUTCMonth())) % 3 === 0) ||
        (t.frequency === "yearly" && mStart.getUTCMonth() === s.getUTCMonth());
      if (!occursThisMonth) continue;
      const occDay = new Date(Date.UTC(mStart.getUTCFullYear(), mStart.getUTCMonth(), t.day_of_month));
      if (occDay < s) continue;
      if (e && occDay > e) continue;
      delta += t.kind === "income" ? Number(t.amount_chf) : -Number(t.amount_chf);
    }

    // préstamos/leasing: cuota mensual entre start_date y end_date
    for (const l of loans) {
      const s = new Date(l.start_date + "T00:00:00Z");
      const e = new Date(l.end_date + "T00:00:00Z");
      if (s < mEnd && e >= mStart) delta -= Number(l.monthly_payment_chf);
    }

    running += delta;
    months.push({ ym, delta, balance: running });
  }
  return months;
}

Deno.serve(async (req) => {
  if (CASHFLOW_CRON_SECRET && req.headers.get("Authorization") !== `Bearer ${CASHFLOW_CRON_SECRET}`) {
    return new Response("forbidden", { status: 403 });
  }
  try {
    const { data: settings, error: settingsErr } = await service.from("cashflow_alert_settings").select("*").eq("id", 1).maybeSingle();
    if (settingsErr) return new Response(JSON.stringify({ error: settingsErr.message }), { status: 500 });
    if (!settings || !settings.enabled) return new Response(JSON.stringify({ ok: true, skipped: "disabled" }), { headers: { "Content-Type": "application/json" } });

    const { data: balRow } = await service.from("cashflow_bank_balance").select("*").order("as_of_date", { ascending: false }).limit(1).maybeSingle();
    const startBalance = balRow ? Number(balRow.balance_chf) : 0;

    const today = new Date().toISOString().slice(0, 10);
    const [entriesQ, templatesQ, loansQ] = await Promise.all([
      service.from("cashflow_entries").select("kind,amount_chf,due_date,status").gte("due_date", today),
      service.from("cashflow_recurring_templates").select("kind,amount_chf,frequency,day_of_month,start_date,end_date,active").eq("active", true),
      service.from("cashflow_loans").select("monthly_payment_chf,start_date,end_date"),
    ]);
    if (entriesQ.error || templatesQ.error || loansQ.error) {
      const err = entriesQ.error || templatesQ.error || loansQ.error;
      return new Response(JSON.stringify({ error: err?.message }), { status: 500 });
    }

    const months = projectMonthly(startBalance, entriesQ.data ?? [], templatesQ.data ?? [], loansQ.data ?? []);
    const threshold = Number(settings.min_balance_threshold_chf);
    const redMonth = months.find((m) => m.balance < threshold) || null;
    const newPeriod = redMonth ? redMonth.ym : null;
    const prevPeriod = settings.last_alerted_period || null;

    if (newPeriod === prevPeriod) {
      return new Response(JSON.stringify({ ok: true, unchanged: true, period: newPeriod }), { headers: { "Content-Type": "application/json" } });
    }

    if (newPeriod) {
      // nuevo mes en rojo (o cambió el mes detectado) → avisar
      if (RESEND_API_KEY) {
        const subject = `⚠️ Cash flow: saldo bajo el umbral en ${monthLabel(newPeriod)}`;
        const html = `<div style="font-family:sans-serif;font-size:14px;line-height:1.6">
          <p>El motor de proyección de Cash Flow detectó que el saldo de Viven AG cruzaría el umbral mínimo
          (${chf(threshold)}) en <b>${monthLabel(newPeriod)}</b>, con un saldo proyectado de
          <b>${chf(redMonth!.balance)}</b>.</p>
          <p>Saldo actual: ${chf(startBalance)} (al ${balRow ? balRow.as_of_date : "—"}).</p>
          <p><a href="https://www.viven.ch/dashboard/">Abrir Cash Flow en el dashboard →</a></p>
          <p style="color:#888;font-size:12px">Aviso automático diario — no se repite para el mismo mes hasta que cambie.</p>
        </div>`;
        await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { "Authorization": `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({ from: "Viven Dashboard <leads@viven.ch>", to: [settings.alert_email], subject, html }),
        }).catch(() => {});
      }
      await service.from("cashflow_alert_settings").update({ last_alerted_period: newPeriod }).eq("id", 1);
    } else if (prevPeriod) {
      // ya no hay ningún mes en rojo en el horizonte de 12 meses → limpiar, para que
      // si vuelve a pasar en el futuro (con un mes distinto o el mismo), vuelva a alertar
      await service.from("cashflow_alert_settings").update({ last_alerted_period: null }).eq("id", 1);
    }

    return new Response(JSON.stringify({ ok: true, period: newPeriod, prevPeriod }), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    console.error("FUNCTION_ERROR", String(e));
    return new Response(JSON.stringify({ error: String(e) }), { status: 500 });
  }
});
