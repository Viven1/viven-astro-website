// Supabase Edge Function: plan-al-equipo
// Le manda el plan de rodaje al crew, con la misma plantilla que el resto de los emails.
//
// Sebastián, 26 ago 2026: "falta todo lo de poder mandar como PDF, etc." y "el email sale
// de su ficha. De todos, para el plan de rodaje."
//
// ── Dos cosas que definen esta función ──
// · `dry_run` devuelve el HTML sin mandar nada. El preview del dashboard muestra el email
//   EXACTO que sale, armado por este mismo código — no una copia que se desactualiza.
// · Los destinatarios salen de la ficha de cada técnico, no de un campo del proyecto. Si el
//   email está en dos lugares, un día uno queda viejo y el plan va a una dirección muerta.
//
// Deploy: supabase functions deploy plan-al-equipo

import { createClient } from "jsr:@supabase/supabase-js@2";
import { emailViven } from "../_shared/email-viven.ts";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND = Deno.env.get("RESEND_API_KEY");

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const esc = (x: unknown) =>
  String(x ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

const DE: Record<string, { nombre: string; email: string }> = {
  sofia: { nombre: "Sofia Treviño", email: "sofia@viven.ch" },
  sebastian: { nombre: "Sebastian Cepeda", email: "sebastian@viven.ch" },
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const auth = req.headers.get("Authorization") ?? "";
    const u = createClient(SB_URL, SB_ANON, { global: { headers: { Authorization: auth } } });
    const { data: { user } } = await u.auth.getUser();
    if (!user) return json({ error: "unauthorized" }, 401);
    const { data: esM } = await u.rpc("is_member");
    if (esM !== true) return json({ error: "unauthorized" }, 401);

    const body = await req.json().catch(() => ({}));
    const projectId = body.project_id;
    if (!projectId) return json({ error: "falta project_id" }, 400);

    const service = createClient(SB_URL, SERVICE);
    const { data: proj } = await service.from("projects")
      .select("id,ref,title,shoot_start,shoot_end,location,crew,client_contact")
      .eq("id", String(projectId)).maybeSingle();
    if (!proj) return json({ error: "no encontré ese proyecto" }, 404);

    const { data: plan } = await service.from("project_scripts")
      .select("*").eq("project_id", proj.id).eq("tipo", "plan")
      .order("updated_at", { ascending: false }).limit(1);
    const pl = (plan || [])[0];
    const filas = pl && Array.isArray(pl.cuerpo) ? pl.cuerpo as Array<Record<string, unknown>> : [];
    if (!filas.length) return json({ error: "El plan está vacío. Armalo primero." });

    /* Los emails salen de la FICHA de cada técnico del crew. Los que no lo tengan cargado
       se devuelven aparte: sin email no se les puede mandar, y decirlo es más útil que
       mandarlo a medias sin avisar. */
    const nombres = (Array.isArray(proj.crew) ? proj.crew : [])
      .map((c: { nombre?: string }) => String(c?.nombre || "").trim()).filter(Boolean);
    const { data: tecnicos } = nombres.length
      ? await service.from("crew").select("id,name,email,roles").in("name", nombres)
      : { data: [] };
    const norm = (x: unknown) => String(x ?? "").trim().toLowerCase();
    const conEmail = (tecnicos || []).filter((t: { email?: string }) => t.email);
    const sinEmail = nombres.filter((n) =>
      !(tecnicos || []).some((t: { name: string; email?: string }) => norm(t.name) === norm(n) && t.email));

    const destinos: string[] = Array.isArray(body.to) && body.to.length
      ? body.to.map(String)
      : conEmail.map((t: { email: string }) => t.email);

    const remitente = DE[String(body.de || "").toLowerCase()] || DE.sofia;
    const dmy = (d?: string) => d ? String(d).slice(0, 10).split("-").reverse().join(".") : "";
    const fechas = [dmy(proj.shoot_start as string), proj.shoot_end && proj.shoot_end !== proj.shoot_start ? dmy(proj.shoot_end as string) : ""]
      .filter(Boolean).join(" – ");

    /* El cronograma en una tabla, agrupado por tramo. El email tiene que poder leerse en el
       teléfono a las seis de la mañana sin abrir ningún adjunto. */
    let blq: string | null = null;
    const cuerpoTabla = filas.map((f) => {
      const b = String(f.bloque || "").trim();
      const cab = b && b !== blq
        ? (blq = b, `<tr><td colspan="4" style="background:#f3f7e8;font-weight:700;font-size:11px;letter-spacing:.09em;text-transform:uppercase;color:#4e650f;padding:7px 10px">${esc(b)}</td></tr>`)
        : "";
      return cab + `<tr>
        <td style="padding:9px 10px 9px 0;border-bottom:1px solid #e9ecf1;font-weight:700;white-space:nowrap;vertical-align:top">${esc(f.hora)}</td>
        <td style="padding:9px 10px 9px 0;border-bottom:1px solid #e9ecf1;color:#8a94a8;white-space:nowrap;vertical-align:top;font-size:12.5px">${f.dura_min ? esc(f.dura_min) + "′" : ""}</td>
        <td style="padding:9px 10px 9px 0;border-bottom:1px solid #e9ecf1;vertical-align:top">
          <b>${esc(f.que)}</b>${f.escenas && f.escenas !== "—" ? `<span style="display:block;font-size:12px;color:#4e650f;font-weight:600">Esc. ${esc(f.escenas)}</span>` : ""}
          ${f.lleva ? `<span style="display:block;font-size:12px;color:#3d4757;margin-top:2px">Llevar: ${esc(f.lleva)}</span>` : ""}
          ${f.notas ? `<span style="display:block;font-size:12px;color:#8a94a8;margin-top:2px">${esc(f.notas)}</span>` : ""}</td>
        <td style="padding:9px 0;border-bottom:1px solid #e9ecf1;vertical-align:top;font-size:12.5px;color:#3d4757">
          ${esc(f.donde)}${f.quien ? `<span style="display:block;color:#8a94a8">${esc(f.quien)}</span>` : ""}</td>
      </tr>`;
    }).join("");

    const listas = (t: unknown) => String(t ?? "").split("\n").map((x) => x.replace(/^[·\-\s]+/, "").trim())
      .filter(Boolean).map((x) => `<li>${esc(x)}</li>`).join("");
    const extra = String((pl as { premisa?: string })?.premisa || "");
    const nec = extra.includes("Hay que conseguir antes:") ? extra.split("Hay que conseguir antes:")[1].split("Ojo con:")[0] : "";
    const rie = extra.includes("Ojo con:") ? extra.split("Ojo con:")[1] : "";

    const asunto = String(body.asunto || "").trim() ||
      `${proj.ref ? proj.ref + " · " : ""}${proj.title || ""} — Plan de rodaje${fechas ? " · " + fechas : ""}`;

    const html = emailViven({
      lang: "es",
      saludo: "Hola,",
      titulo: `${proj.ref ? "#" + proj.ref + " · " : ""}${esc(proj.title || "")}`,
      intro: `El plan del rodaje${fechas ? " del " + fechas : ""}${proj.location ? ", en " + esc(String(proj.location)) : ""}. Va también en PDF adjunto para imprimir.`,
      cuerpo:
        `${body.mensaje ? `<div style="font-size:15px;line-height:1.65;margin:0 0 20px;padding:14px 16px;background:#fffbe9;border:1px solid #f0e2b0;border-radius:10px;white-space:pre-wrap;color:#3d4757">${esc(body.mensaje)}</div>` : ""}` +
        `<table style="width:100%;border-collapse:collapse;font-size:13.5px;color:#1a2230">${cuerpoTabla}</table>` +
        (nec.trim() ? `<h3 style="font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:#8a94a8;margin:22px 0 6px">Hay que conseguir antes</h3><ul style="margin:0;padding-left:18px;font-size:13.5px;line-height:1.6;color:#3d4757">${listas(nec)}</ul>` : "") +
        (rie.trim() ? `<h3 style="font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:#8a94a8;margin:20px 0 6px">Ojo con</h3><ul style="margin:0;padding-left:18px;font-size:13.5px;line-height:1.6;color:#3d4757">${listas(rie)}</ul>` : ""),
      pie: `${esc(remitente.nombre)} · VIVEN AG — respondiendo a este email le escribís directo.`,
      porque: "Recibís este email porque estás en el crew de este rodaje.",
    });

    if (body.dry_run) {
      return json({ ok: true, dry_run: true, asunto, html, para: destinos, sin_email: sinEmail,
                    de: remitente.nombre, responde_a: remitente.email, bloques: filas.length });
    }
    if (!destinos.length) return json({ error: "Ninguno del crew tiene email cargado en su ficha. Cargalos en Técnicos." });
    if (!RESEND) return json({ error: "Falta RESEND_API_KEY" }, 500);

    const adj = body.pdf_base64
      ? [{ filename: `${proj.ref || "proyecto"}_plan_de_rodaje.pdf`, content: String(body.pdf_base64) }]
      : [];

    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: `${remitente.nombre} (VIVEN) <info@viven.ch>`,
        to: destinos, reply_to: remitente.email, subject: asunto, html,
        ...(adj.length ? { attachments: adj } : {}),
      }),
    });
    if (!r.ok) {
      const t = await r.text();
      console.error("RESEND_FAIL_PLAN", r.status, t);
      return json({ error: `no salió (${r.status}): ${t.slice(0, 200)}` }, 502);
    }
    return json({ ok: true, para: destinos, sin_email: sinEmail });
  } catch (e) {
    console.error("FUNCTION_ERROR", String(e));
    return json({ error: String(e) }, 500);
  }
});
