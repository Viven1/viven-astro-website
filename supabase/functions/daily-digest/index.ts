// Supabase Edge Function: daily-digest
// El DIGEST DE LA MAÑANA: corre por cron L-V 07:00 UTC (≈09:00 CH en verano) y arma
// UN email por destinatario con lo que necesita atención HOY: leads sin respuesta,
// deals estancados, propuestas sin respuesta, cashflow por vencer, ritmo del mes
// (mismo cálculo que el panel "🎯 Ritmo del mes" del tab Hoy) y el próximo tema del
// motor de contenido (solo L/M/V, los días que corre content-engine).
//
// Destinatarios (decisión de Sebastián 2026-07-24): DOS emails separados —
//   · sebastian@viven.ch: completo.
//   · sofia@viven.ch: idéntico pero SIN la sección 💰 Cashflow — el módulo de
//     cashflow es superadmin-only por diseño (0077 user_roles) y el digest no debe
//     filtrarle datos financieros que el dashboard le oculta. 🎯 Ritmo sí va en
//     ambos (deals/pipeline son visibles para todo el equipo).
// Las secciones se arman UNA vez y cada email se compone filtrando por flag.
//
// Deploy:   supabase functions deploy daily-digest --no-verify-jwt
// Schedule: SQL 0108 (pg_cron 'daily-digest-9am', L-V 07:00 UTC, header con
//           CRON_SECRET desde Vault — patrón 0081)
// Secrets:  RESEND_API_KEY, CRON_SECRET (ya seteados)

import { createClient } from "jsr:@supabase/supabase-js@2";

const service = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
// mismo patrón de auth que content-engine (auditoría 2026-07-14): el cron llama con
// el secret compartido; el dashboard podría llamarla con el JWT del usuario logueado
// (botón de test); NUNCA una llamada anónima.
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");

const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } });
const chf = (n: number) => "CHF " + Math.round(n).toLocaleString("de-CH");
const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const daysAgo = (iso: string | null | undefined) => iso ? Math.floor((Date.now() - Date.parse(iso)) / 864e5) : null;
const hoursAgo = (iso: string | null | undefined) => iso ? Math.floor((Date.now() - Date.parse(iso)) / 36e5) : null;
const fmtDate = (iso: string) => new Date(iso + (iso.length === 10 ? "T00:00:00Z" : "")).toLocaleDateString("es-CH", { day: "2-digit", month: "2-digit", timeZone: "Europe/Zurich" });

// ---- etapas: MISMO modelo que el dashboard (STAGES en index.astro) ----------
// Pesos del pipeline ponderado = STAGES.prob del dashboard (nuevo .2 · contactado .4 ·
// videocall .6 · propuesta .8) — el digest tiene que dar los MISMOS números que el
// panel "🎯 Ritmo del mes". Única diferencia (comentada): acá el valor del deal es
// deals.deal_value crudo — la cascada "ofertas ganadas > abiertas > deal_value" del
// frontend (dealValue) necesitaría traer todas las ofertas; para el digest la
// aproximación con el estimado manual alcanza.
const STAGE_PROB: Record<string, number> = { nuevo: 0.2, contactado: 0.4, videocall: 0.6, propuesta: 0.8 };
const STAGE_LABEL: Record<string, string> = { nuevo: "Nuevo", contactado: "Contactado", videocall: "Video Call", propuesta: "Propuesta enviada", ganado: "Ganado", perdido: "Perdido" };
const STAGE_MATCH: [string, string[]][] = [
  ["nuevo", ["new", "nuevo", "", "pending"]],
  ["contactado", ["contacted", "contactado"]],
  ["videocall", ["videocall", "video call booked", "call", "agendada", "booked"]],
  ["propuesta", ["proposal", "propuesta", "qualified"]],
  ["ganado", ["won", "cerrado", "ganado"]],
  ["perdido", ["lost", "perdido"]],
];
function stageOf(status: string | null | undefined): string {
  const s = (status || "").toLowerCase();
  for (const [key, match] of STAGE_MATCH) if (match.includes(s)) return key;
  return "nuevo";
}
const OPEN_STAGES = ["nuevo", "contactado", "videocall", "propuesta"];

type Lead = { id: number; name: string | null; email: string | null; company: string | null; status: string | null; channel: string | null; created_at: string; contacted_at: string | null; session_id: string | null };
type Deal = { id: string; lead_id: number; title: string | null; stage: string; deal_value: number | null; archived: boolean; created_at: string; last_stage_at: string | null; won_at: string | null };
type Proposal = { id: number; title: string | null; status: string; lead_id: string | null; archived: boolean; is_template: boolean; published_at: string | null; updated_at: string; last_view_at: string | null };
type CfEntry = { kind: "income" | "expense"; description: string; amount_chf: number; due_date: string; status: string };

// ---- HTML del email: mismo lenguaje que los emails existentes (content-engine):
// max-width 600, Inter, cards con border-radius 14, sobrio ------------------------
const card = (title: string, inner: string) =>
  `<div style="border:1px solid #e3e6ec;border-radius:14px;padding:16px 18px;margin:0 0 16px">
    <div style="font-size:14.5px;font-weight:700;margin-bottom:10px;color:#1a2230">${title}</div>${inner}</div>`;
const row = (main: string, sub: string, right = "") =>
  `<div style="display:flex;justify-content:space-between;gap:10px;padding:7px 0;border-top:1px solid #eceef2">
    <div style="min-width:0"><div style="font-size:13.5px;font-weight:600;color:#1a2230">${main}</div>
    ${sub ? `<div style="font-size:12px;color:#5b6472;margin-top:1px">${sub}</div>` : ""}</div>
    ${right ? `<div style="flex:none;font-size:13px;font-weight:700;color:#1a2230;white-space:nowrap">${right}</div>` : ""}</div>`;

Deno.serve(async (req) => {
  const authHdr = req.headers.get("Authorization") ?? "";
  const isCron = !!CRON_SECRET && authHdr === `Bearer ${CRON_SECRET}`;
  if (!isCron) {
    const supabaseAuth = createClient(SB_URL, SB_ANON, { global: { headers: { Authorization: authHdr } } });
    const { data: { user } } = await supabaseAuth.auth.getUser();
    if (!user) return json({ error: "unauthorized" }, 401);
  }
  try {
    const now = Date.now(), D = 864e5;
    const todayYmd = new Date().toISOString().slice(0, 10);
    const in7Ymd = new Date(now + 7 * D).toISOString().slice(0, 10);
    // día de semana en HORA SUIZA (el cron corre en UTC): el motor de contenido corre L/M/V
    const zhWeekday = new Date().toLocaleDateString("en-US", { weekday: "short", timeZone: "Europe/Zurich" });
    const isContentDay = ["Mon", "Wed", "Fri"].includes(zhWeekday);

    const [leadsQ, dealsQ, propsQ, cfQ, goalQ, cqQ] = await Promise.all([
      service.from("leads").select("id,name,email,company,status,channel,created_at,contacted_at,session_id")
        .gte("created_at", new Date(now - 7 * D).toISOString()).order("created_at", { ascending: true }),
      service.from("deals").select("id,lead_id,title,stage,deal_value,archived,created_at,last_stage_at,won_at").eq("archived", false),
      service.from("proposals").select("id,title,status,lead_id,archived,is_template,published_at,updated_at,last_view_at").eq("status", "sent"),
      // cashflow_entries (0078): vencidas (sin pagar) o que vencen en 7 días
      service.from("cashflow_entries").select("kind,description,amount_chf,due_date,status").neq("status", "paid").lte("due_date", in7Ymd).order("due_date", { ascending: true }).limit(30),
      service.from("business_goals").select("monthly_target").eq("id", 1).maybeSingle(),
      isContentDay
        ? service.from("content_queue").select("topic,priority").eq("status", "pending").order("priority", { ascending: false }).order("id").limit(1)
        : Promise.resolve({ data: null, error: null } as { data: { topic: string; priority: number }[] | null; error: null }),
    ]);
    if (dealsQ.error) return json({ error: dealsQ.error.message }, 500);

    const leads = (leadsQ.data ?? []) as Lead[];
    const deals = (dealsQ.data ?? []) as Deal[];
    const props = (propsQ.data ?? []) as Proposal[];

    // nombre de la persona de un deal/propuesta (para las secciones 🧊 y 📄):
    // los leads de la ventana de 7 días no alcanzan — pedimos los que falten por id
    const needIds = new Set<string>();
    deals.forEach((d) => needIds.add(String(d.lead_id)));
    props.forEach((p) => { if (p.lead_id) needIds.add(String(p.lead_id)); });
    leads.forEach((l) => needIds.delete(String(l.id)));
    const leadName: Record<string, string> = {};
    leads.forEach((l) => { leadName[String(l.id)] = l.name || l.email || ""; });
    if (needIds.size) {
      const ids = [...needIds].map(Number).filter((n) => Number.isFinite(n));
      if (ids.length) {
        const { data: extra } = await service.from("leads").select("id,name,email").in("id", ids);
        (extra ?? []).forEach((l: { id: number; name: string | null; email: string | null }) => { leadName[String(l.id)] = l.name || l.email || ""; });
      }
    }

    // ---- secciones: cada una SOLO si tiene items. forSofia marca cuáles van en
    // el segundo email (todas menos cashflow). --------------------------------------

    const sections: { key: string; forSofia: boolean; html: string }[] = [];

    // 🔥 Leads sin respuesta. Definición (con los campos que EXISTEN — no hay tabla de
    // activities; sí hay lead_notes, 0010): lead creado en los últimos 7 días que
    //   · sigue en etapa inicial (stageOf(status) === 'nuevo'),
    //   · lleva más de 4h desde created_at,
    //   · no tiene contacted_at (se sella al mandar el primer email/mover a Contactado),
    //   · no tiene NINGUNA nota en lead_notes (si alguien anotó algo, ya lo miraron),
    //   · no es carga manual nuestra (channel 'manual') ni test/spam.
    const candidates = leads.filter((l) =>
      stageOf(l.status) === "nuevo" &&
      now - Date.parse(l.created_at) > 4 * 36e5 &&
      !l.contacted_at &&
      l.channel !== "manual" &&
      !/spam/i.test(l.status || "") &&
      !/^claude-/.test(l.session_id || "") &&
      !/@example\.|@test\./i.test(l.email || ""));
    let unanswered: Lead[] = [];
    if (candidates.length) {
      const { data: notes } = await service.from("lead_notes").select("lead_id").in("lead_id", candidates.map((l) => String(l.id)));
      const noted = new Set((notes ?? []).map((n: { lead_id: string }) => String(n.lead_id)));
      unanswered = candidates.filter((l) => !noted.has(String(l.id)));
    }
    if (unanswered.length) {
      sections.push({
        key: "leads", forSofia: true,
        html: card(`🔥 Leads sin respuesta (${unanswered.length})`,
          unanswered.slice(0, 10).map((l) => row(
            esc(l.name || l.email || "(sin nombre)") + (l.company ? ` <span style="font-weight:400;color:#5b6472">· ${esc(l.company)}</span>` : ""),
            `entró hace ${hoursAgo(l.created_at)! < 48 ? hoursAgo(l.created_at) + " h" : daysAgo(l.created_at) + " días"} · canal ${esc(l.channel || "web")} · sin contactar`,
          )).join("") + (unanswered.length > 10 ? `<div style="font-size:12px;color:#8a94a8;padding-top:8px">…y ${unanswered.length - 10} más en el dashboard.</div>` : "")),
      });
    }

    // 🧊 Deals estancados: abiertos con más de 7 días sin moverse de etapa
    // (last_stage_at; fallback created_at si nunca se movió — mismo criterio que
    // dealStageDays del dashboard). Orden: más valor primero.
    const stalled = deals
      .filter((d) => OPEN_STAGES.includes(stageOf(d.stage)))
      .map((d) => ({ d, days: daysAgo(d.last_stage_at || d.created_at) ?? 0 }))
      .filter((x) => x.days > 7)
      .sort((a, b) => (Number(b.d.deal_value) || 0) - (Number(a.d.deal_value) || 0));
    if (stalled.length) {
      sections.push({
        key: "deals", forSofia: true,
        html: card(`🧊 Deals estancados (${stalled.length})`,
          stalled.slice(0, 10).map(({ d, days }) => row(
            esc(d.title || leadName[String(d.lead_id)] || "(deal)"),
            `${days} días en ${STAGE_LABEL[stageOf(d.stage)]}${leadName[String(d.lead_id)] ? " · " + esc(leadName[String(d.lead_id)]) : ""}`,
            d.deal_value ? chf(Number(d.deal_value)) : "—",
          )).join("") + (stalled.length > 10 ? `<div style="font-size:12px;color:#8a94a8;padding-top:8px">…y ${stalled.length - 10} más.</div>` : "")),
      });
    }

    // 📄 Propuestas sin respuesta: el schema SÍ tiene señal de vista (0058:
    // published_at + last_view_at) — publicadas hace >48h sin aceptar, con el dato
    // de si el cliente la abrió (vista reciente = llamar; 0 vistas = reenviar link).
    const waiting = props
      .filter((p) => !p.archived && !p.is_template)
      .map((p) => ({ p, days: daysAgo(p.published_at || p.updated_at) ?? 0 }))
      .filter((x) => x.days >= 2)
      .sort((a, b) => b.days - a.days);
    if (waiting.length) {
      sections.push({
        key: "props", forSofia: true,
        html: card(`📄 Propuestas sin respuesta (${waiting.length})`,
          waiting.slice(0, 10).map(({ p, days }) => row(
            esc(p.title || "Propuesta"),
            `publicada hace ${days} días${p.lead_id && leadName[String(p.lead_id)] ? " · " + esc(leadName[String(p.lead_id)]) : ""} · ` +
              (p.last_view_at ? `última vista hace ${daysAgo(p.last_view_at)} d${(daysAgo(p.last_view_at) ?? 9) <= 1 ? " → llamar HOY" : ""}` : "0 vistas — ¿le llegó el link?"),
          )).join("")),
      });
    }

    // 💰 Cashflow: partidas sin pagar vencidas o que vencen en 7 días.
    // SOLO en el email de Sebastián (superadmin-only por diseño, 0077).
    const cf = (cfQ.error ? [] : (cfQ.data ?? [])) as CfEntry[];
    if (cf.length) {
      const sign = (e: CfEntry) => (e.kind === "income" ? "+" : "−") + chf(Number(e.amount_chf));
      const overdue = cf.filter((e) => e.due_date < todayYmd);
      const soon = cf.filter((e) => e.due_date >= todayYmd);
      const cfRow = (e: CfEntry, tag: string) => row(
        esc(e.description),
        `${tag} ${fmtDate(e.due_date)} · ${e.kind === "income" ? "cobro" : "pago"} ${e.status === "confirmed" ? "confirmado" : "proyectado"}`,
        sign(e));
      sections.push({
        key: "cashflow", forSofia: false,
        html: card(`💰 Cashflow (${overdue.length ? overdue.length + " vencida" + (overdue.length === 1 ? "" : "s") + " · " : ""}${soon.length} en 7 días)`,
          overdue.map((e) => cfRow(e, "⚠ venció el")).join("") + soon.map((e) => cfRow(e, "vence el")).join("")),
      });
    }

    // 🎯 Ritmo del mes: mismo cálculo que el panel del tab Hoy (server-side).
    const goal = goalQ.error ? 0 : Number(goalQ.data?.monthly_target ?? 0);
    const zhNow = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Zurich" }));
    const m0 = new Date(zhNow.getFullYear(), zhNow.getMonth(), 1).getTime();
    const daysInMonth = new Date(zhNow.getFullYear(), zhNow.getMonth() + 1, 0).getDate();
    const closed = deals
      .filter((d) => stageOf(d.stage) === "ganado" && Date.parse(d.won_at || d.last_stage_at || "") >= m0)
      .reduce((a, d) => a + (Number(d.deal_value) || 0), 0);
    const weighted = deals
      .filter((d) => OPEN_STAGES.includes(stageOf(d.stage)))
      .reduce((a, d) => a + (Number(d.deal_value) || 0) * (STAGE_PROB[stageOf(d.stage)] || 0), 0);
    const proj = closed + weighted;
    const gap = proj - goal;
    const pctToday = Math.round(zhNow.getDate() / daysInMonth * 100);
    const gapLine = goal
      ? (gap >= 0
        ? `<div style="font-size:13px;font-weight:700;color:#3f9b2f;margin-top:8px">✓ Proyección ${chf(proj)} — ${chf(gap)} arriba del objetivo.</div>`
        : `<div style="font-size:13px;font-weight:700;color:#c0392b;margin-top:8px">⚠ Proyección ${chf(proj)} — faltan ${chf(-gap)} para el objetivo (vas por el día ${zhNow.getDate()} de ${daysInMonth}, ${pctToday}% del mes).</div>`)
      : `<div style="font-size:13px;color:#5b6472;margin-top:8px">Sin objetivo mensual definido — cargalo en el panel 🎯 Ritmo del mes del dashboard.</div>`;
    sections.push({
      key: "ritmo", forSofia: true,
      html: card("🎯 Ritmo del mes",
        `<div style="display:flex;flex-wrap:wrap;gap:14px 22px">
          <div><div style="font-size:11px;color:#8a94a8">Objetivo</div><div style="font-size:16px;font-weight:700">${goal ? chf(goal) : "—"}</div></div>
          <div><div style="font-size:11px;color:#8a94a8">Cerrado</div><div style="font-size:16px;font-weight:700;color:#3f9b2f">${chf(closed)}</div></div>
          <div><div style="font-size:11px;color:#8a94a8">Ponderado</div><div style="font-size:16px;font-weight:700">${chf(weighted)}</div></div>
          <div><div style="font-size:11px;color:#8a94a8">Proyección</div><div style="font-size:16px;font-weight:700">${chf(proj)}</div></div>
        </div>` + gapLine),
    });

    // 📝 Contenido: solo los días que corre el motor (L/M/V, cron 05:30 UTC) — qué
    // tema escribió/está escribiendo hoy (el próximo pendiente de la cola).
    const nextTopic = (cqQ && !cqQ.error && cqQ.data && cqQ.data[0]) || null;
    if (isContentDay && nextTopic) {
      sections.push({
        key: "content", forSofia: true,
        html: card("📝 Motor de contenido",
          `<div style="font-size:13px;color:#333c4a;line-height:1.6">Hoy corre el motor (L/M/V): el próximo tema de la cola es<br><b>«${esc(nextTopic.topic)}»</b> (prioridad ${Number(nextTopic.priority) || 0}). Los borradores llegan por email para aprobar.</div>`),
      });
    }

    // ---- asunto: "[lo más urgente]" con el count más crítico, calculado por
    // destinatario (Sofia no ve cashflow, su asunto no puede referenciarlo) --------
    const subjectFor = (keys: Set<string>) => {
      if (unanswered.length && keys.has("leads")) return `☀️ Viven hoy: ${unanswered.length} lead${unanswered.length === 1 ? "" : "s"} sin respuesta`;
      if (waiting.length && keys.has("props")) return `☀️ Viven hoy: ${waiting.length} propuesta${waiting.length === 1 ? "" : "s"} esperando respuesta`;
      if (stalled.length && keys.has("deals")) return `☀️ Viven hoy: ${stalled.length} deal${stalled.length === 1 ? "" : "s"} estancado${stalled.length === 1 ? "" : "s"}`;
      const cfOver = cf.filter((e) => e.due_date < todayYmd).length;
      if (cfOver && keys.has("cashflow")) return `☀️ Viven hoy: ${cfOver} partida${cfOver === 1 ? "" : "s"} de cashflow vencida${cfOver === 1 ? "" : "s"}`;
      if (goal && gap < 0) return `☀️ Viven hoy: faltan ${chf(-gap)} para el objetivo del mes`;
      return "☀️ Viven hoy: todo al día ✅";
    };
    const wrap = (inner: string) =>
      `<div style="font-family:Inter,sans-serif;max-width:600px;margin:0 auto;color:#1a2230">
        <h2 style="font-size:18px;margin:0 0 4px">☀️ Buen día — así arranca ${zhNow.toLocaleDateString("es-CH", { weekday: "long", day: "numeric", month: "long" })}</h2>
        <p style="color:#5b6472;font-size:13px;margin:0 0 18px">Digest automático de las 9:00 · <a href="https://www.viven.ch/dashboard/" style="color:#1a2230">abrir el dashboard →</a></p>
        ${inner}
        <p style="color:#8a94a8;font-size:11.5px;margin-top:6px">Solo aparecen las secciones con algo para hacer. Corre lunes a viernes.</p>
      </div>`;

    // dos emails SEPARADOS (no CC): Sebastián completo, Sofia sin cashflow
    const recipients = [
      { to: "sebastian@viven.ch", secs: sections },
      { to: "sofia@viven.ch", secs: sections.filter((s) => s.forSofia) },
    ];
    const sent: string[] = [];
    if (RESEND_API_KEY) {
      for (const r of recipients) {
        await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            from: "Viven Dashboard <leads@viven.ch>",
            to: [r.to],
            subject: subjectFor(new Set(r.secs.map((s) => s.key))),
            html: wrap(r.secs.map((s) => s.html).join("")),
          }),
        }).then((res) => { if (res.ok) sent.push(r.to); else console.error("RESEND_ERROR", r.to, res.status); })
          .catch((e) => console.error("RESEND_ERROR", r.to, String(e)));
      }
    }

    return json({
      ok: true, sent,
      counts: { unanswered: unanswered.length, stalled: stalled.length, proposals: waiting.length, cashflow: cf.length, contentDay: isContentDay },
      ritmo: { goal, closed, weighted: Math.round(weighted), proj: Math.round(proj), gap: Math.round(gap) },
    });
  } catch (e) {
    console.error("FUNCTION_ERROR", String(e));
    return json({ error: String(e) }, 500);
  }
});
