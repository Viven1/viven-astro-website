// Supabase Edge Function: lead-notify
// Disparada por un Database Webhook en INSERT sobre `leads`.
// Manda un email instantáneo a info@viven.ch vía Resend.
//
// Deploy:  supabase functions deploy lead-notify --no-verify-jwt
// Secret:  supabase secrets set RESEND_API_KEY=re_xxx
// Webhook: Supabase → Database → Webhooks → New:
//          tabla=leads, evento=INSERT, tipo=Supabase Edge Function → lead-notify
//          HTTP Headers → agregar Authorization: Bearer <CRON_SECRET>
//
// fix (auditoría 2026-07-14): invocable sin auth por cualquiera con un body
// { record: {...} } armado a mano — filtraba nombre/mensaje/campaña de leads
// reales y podía spammear el push del team. Exige el mismo CRON_SECRET
// compartido que el resto de las funciones internas — el Database Webhook
// tiene que mandarlo como header custom (configuración manual en el
// Dashboard, ver arriba; no se puede setear desde una migración SQL).

import { createClient } from "jsr:@supabase/supabase-js@2";

const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;
const TO = "info@viven.ch";
const FROM = "Viven Leads <leads@viven.ch>"; // dominio verificado en Resend
const esc = (s: unknown) =>
  String(s ?? "").replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]!));

// fix (2026-07-31): esto reimplementaba Web Push a mano y nunca tocaba
// device_tokens — un lead nuevo jamás llegaba como push nativo al iPhone/iPad,
// solo a browsers con la PWA suscripta. Ahora delega en push-send (mismo
// camino que reactivation-engine/deal-followup-later), que ya manda por
// Web Push Y APNs con un solo JWT cacheado por corrida.
function pushBroadcast(title: string, body: string, url = "/dashboard/") {
  fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/push-send`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") },
    body: JSON.stringify({ title, body, url }),
  }).catch((e) => console.error("PUSH_ERROR", String(e)));
}


/* ── RECORRIDO: qué vio esta persona antes de escribirnos ─────────────────────
   Todo esto ya se estaba guardando (pageviews/video_plays por session_id) y nadie
   lo miraba. Es instantáneo: son dos consultas por id de sesión. */
type Vista = { path: string; duration: number | null; created_at: string; is_entry: boolean; referrer: string | null; device: string | null };
// deno-lint-ignore no-explicit-any -- el cliente tipado generico no aporta acá
async function recorrido(service: any, sessionId: string | null) {
  if (!sessionId) return null;
  const [pv, vp] = await Promise.all([
    service.from("pageviews").select("path,duration,created_at,is_entry,referrer,device")
      .eq("session_id", sessionId).order("created_at", { ascending: true }).limit(60),
    service.from("video_plays").select("label,created_at").eq("session_id", sessionId).limit(20),
  ]);
  const vistas = (pv.data ?? []) as Vista[];
  if (!vistas.length) return null;
  const entrada = vistas.find((v) => v.is_entry) ?? vistas[0];
  const segundos = vistas.reduce((a, v) => a + (Number(v.duration) || 0), 0);
  return {
    paginas: vistas.length,
    minutos: Math.round(segundos / 6) / 10,
    entrada: entrada?.path ?? null,
    referrer: entrada?.referrer ?? null,
    device: entrada?.device ?? null,
    camino: vistas.map((v) => ({ path: v.path, seg: Math.round(Number(v.duration) || 0) })),
    videos: ((vp.data ?? []) as { label: string }[]).map((v) => v.label).filter(Boolean),
  };
}

/* ── FICHA: quién es. Con un límite duro de tiempo: el aviso tiene que salir YA,
   así que si la investigación no llega, el mail sale igual y lo dice. ───────── */
async function ficha(lead: Record<string, unknown>, ms = 22000) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    const res = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/ai-enrich`, {
      method: "POST", signal: ctrl.signal,
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") },
      body: JSON.stringify({ lead }),
    });
    clearTimeout(t);
    const d = await res.json().catch(() => ({}));
    if (d?.enrichment) return { ok: true as const, e: d.enrichment };
    return { ok: false as const, motivo: d?.error ? String(d.error) : "la investigación no devolvió nada" };
  } catch (e) {
    return { ok: false as const, motivo: String(e).includes("abort") ? "la investigación tardó más de 22 s" : String(e) };
  }
}

/* El HTML del aviso, como funcion PURA: recibe datos y devuelve el email. Asi se
   puede probar con datos reales sin crear un lead de mentira en el CRM. */
// deno-lint-ignore no-explicit-any
export function emailHtml(name: string, r: any, rows: [string, unknown][], rec: any, fi: any): string {
  const S = 'font-family:sans-serif';
  const bloqueRecorrido = rec ? `
    <h3 style="${S};font-size:14px;margin:22px 0 6px">🧭 Qué vio antes de escribirte</h3>
    <p style="${S};font-size:13.5px;margin:0 0 8px;color:#333">
      <strong>${rec.paginas} página${rec.paginas === 1 ? "" : "s"}</strong> · ${rec.minutos} min en el sitio${rec.device ? " · desde " + esc(rec.device) : ""}<br>
      Entró por <strong>${esc(rec.entrada || "—")}</strong>${rec.referrer ? " · viniendo de <strong>" + esc(rec.referrer) + "</strong>" : ""}
    </p>
    <ol style="${S};font-size:13px;color:#444;margin:0;padding-left:18px">
      ${rec.camino.slice(0, 12).map((c: { path: string; seg: number }) => `<li>${esc(c.path)}${c.seg ? ` <span style="color:#889">— ${c.seg}s</span>` : ""}</li>`).join("")}
    </ol>
    ${rec.videos.length ? `<p style="${S};font-size:13.5px;margin:8px 0 0">🎬 Miró: <strong>${rec.videos.map((v: string) => esc(v)).join(", ")}</strong></p>` : ""}`
    : `<h3 style="${S};font-size:14px;margin:22px 0 6px">🧭 Qué vio antes de escribirte</h3>
       <p style="${S};font-size:13.5px;color:#885">No tengo el recorrido de esta persona — llegó sin sesión registrada (formulario directo, o bloqueó el tracking).</p>`;

  const e = fi.ok ? fi.e : null;
  const seg = e?.seguridad || (fi.ok ? "media" : null);
  const avisoSeguridad = seg === "alta" ? "" :
    `<p style="${S};font-size:12.5px;color:#a06000;background:#fff6e5;padding:8px 10px;border-radius:6px;margin:8px 0 0">
       ⚠️ ${seg === "baja" ? "Confianza BAJA" : "Confianza media"} — ${esc(e?.por_que || "no pude confirmar que sea esta persona exacta")}. Verificá antes de usarlo en una conversación.</p>`;
  const bloqueFicha = !fi.ok
    ? `<h3 style="${S};font-size:14px;margin:22px 0 6px">🔎 Quién es</h3>
       <p style="${S};font-size:13.5px;color:#885">No pude averiguar nada todavía (${esc(fi.motivo)}). Podés investigarlo desde el dashboard con «✨ Enriquecer».</p>`
    : `<h3 style="${S};font-size:14px;margin:22px 0 6px">🔎 Quién es</h3>
       ${e.persona?.resumen ? `<p style="${S};font-size:13.5px;margin:0 0 6px;color:#333">${esc(e.persona.resumen)}${e.persona.cargo ? ` <span style="color:#667">· ${esc(e.persona.cargo)}</span>` : ""}</p>` : ""}
       ${e.empresa?.resumen ? `<p style="${S};font-size:13.5px;margin:0 0 6px;color:#333"><strong>${esc(e.empresa.nombre || "")}</strong> — ${esc(e.empresa.resumen)}</p>` : ""}
       ${!e.persona?.resumen && !e.empresa?.resumen ? `<p style="${S};font-size:13.5px;color:#885">La investigación no encontró información confiable sobre esta persona.</p>` : ""}
       ${(e.hooks || []).length ? `<p style="${S};font-size:13.5px;margin:10px 0 4px"><strong>Por dónde entrarle:</strong></p>
         <ul style="${S};font-size:13.5px;color:#333;margin:0;padding-left:18px">${(e.hooks || []).slice(0, 4).map((h: string) => `<li>${esc(h)}</li>`).join("")}</ul>` : ""}
       ${avisoSeguridad}`;

  return `
    <h2 style="${S};margin:0 0 12px">🎬 Nuevo lead — ${esc(name)}</h2>
    ${r.message ? `<p style="${S};font-size:15px;background:#f4f6f9;padding:12px 14px;border-radius:8px;margin:0 0 14px;color:#111">"${esc(r.message)}"</p>` : ""}
    <table style="${S};font-size:14px;border-collapse:collapse">
      ${rows.map(([k, v]) => `<tr>
        <td style="padding:4px 12px 4px 0;color:#667;white-space:nowrap">${k}</td>
        <td style="padding:4px 0"><strong>${esc(v)}</strong></td></tr>`).join("")}
    </table>
    ${bloqueRecorrido}
    ${bloqueFicha}
    <p style="${S};font-size:13px;margin-top:20px">
      <a href="https://www.viven.ch/dashboard/?lead=${esc(r.id ?? "")}">Abrir la ficha en el dashboard →</a>
    </p>`;
}

Deno.serve(async (req) => {
  if (CRON_SECRET && req.headers.get("Authorization") !== `Bearer ${CRON_SECRET}`) {
    return new Response("forbidden", { status: 403 });
  }
  try {
    const body = await req.json();
    const r = body.record ?? body; // webhook trae { type, table, record }

    // 'manual' = lo cargó el equipo mismo desde Personas → no es un lead nuevo real,
    // avisarnos de algo que acabamos de hacer nosotros no tiene sentido
    if (r.channel === "manual") return new Response(JSON.stringify({ ok: true, skipped: "manual" }), { headers: { "Content-Type": "application/json" } });

    const name = r.name || `${r.first_name ?? ""} ${r.last_name ?? ""}`.trim() || "—";
    const rows: [string, unknown][] = [
      ["Nombre", name],
      ["Email", r.email],
      // el mensaje NO va acá: ya se muestra arriba, destacado en su propio bloque
      ["Canal", r.channel || "direct"],
      ["Campaña", r.utm_campaign || "—"],
      ["Google Ads (gclid)", r.gclid ? "sí" : "no"],
      ["Landing", r.landing_path || "—"],
      ["Idioma", r.lang || "—"],
    ];
    // el recorrido es instantáneo; la ficha va con límite de tiempo
    const service = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const [rec, fi] = await Promise.all([
      recorrido(service, (r.session_id as string) ?? null).catch(() => null),
      ficha({ name, email: r.email, company: r.company, domain: String(r.email || "").split("@")[1] || null }),
    ]);

    // guardar la ficha en el lead: el dashboard la muestra sin volver a investigar
    if (fi.ok && r.id) {
      await service.from("leads").update({ enrichment: fi.e, enriched_at: new Date().toISOString() }).eq("id", r.id).then(() => {}, () => {});
    }

    const html = emailHtml(name, r, rows, rec, fi);

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: FROM, to: [TO], reply_to: r.email || undefined,
        subject: `Nuevo lead: ${name}${r.email ? " · " + r.email : ""}`,
        html,
      }),
    });
    // push al celular (además del email) — abre el lead directo al tocarla
    pushBroadcast(
      "🎬 Nuevo lead: " + name,
      [(r.message || "").slice(0, 90) || r.email,
       rec ? `${rec.paginas} pág · ${rec.minutos} min` : null,
       r.gclid ? "Google Ads" : (r.utm_source || r.channel || null)].filter(Boolean).join(" · "),
      r.id ? "/dashboard/?lead=" + r.id : "/dashboard/");

    if (!res.ok) return new Response(await res.text(), { status: 502 });
    return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500 });
  }
});
