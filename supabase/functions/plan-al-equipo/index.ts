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
import { htmlAPdf, pdfConfigurado } from "../_shared/pdf.ts";
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
    const base = pl && Array.isArray(pl.cuerpo) ? pl.cuerpo as Array<Record<string, unknown>> : [];
    /* La sinopsis viene resuelta de la pantalla, fila por fila, en el mismo orden. */
    const sinopsis = Array.isArray(body.filas_extra) ? body.filas_extra as Array<Record<string, unknown>> : [];
    const filas: Array<Record<string, unknown>> = base.map((f, i) =>
      ({ ...f, sinopsis: (sinopsis[i] && sinopsis[i].sinopsis) || "" }));
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

    const { data: contactos } = await service.from("project_contacts")
      .select("name,email,recibe").eq("project_id", proj.id);
    const delCliente = (contactos || []).filter((c: { email?: string }) => c.email);

    /* Al CLIENTE le va otra hoja. Un plan de rodaje trae cosas que son nuestras y no suyas:
       lo que lleva cada área, los teléfonos del crew, los riesgos, lo que puede salir mal.
       Mandarle el mismo papel es la forma más fácil de que lea algo que no le tocaba.
       Por eso son dos envíos distintos y no uno con copia.
       (Sebastián, 26 ago 2026: "mandar el plan al cliente también… o por separado para que
       vea otras cosas que el resto".) */
    const paraCliente = body.publico === true;

    const destinos: string[] = Array.isArray(body.to) && body.to.length
      ? body.to.map(String)
      : paraCliente
        ? delCliente.map((c: { email: string }) => c.email)
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
      /* Al cliente: el horario, dónde y qué se rueda. NO lo que lleva cada área ni las
         notas internas — eso es cómo trabajamos nosotros. Lo único de "llevar" que sí le
         toca es lo que trae ÉL, y va aparte, en su propia lista. */
      const suyo = paraCliente
        ? String(f.lleva || "").split("·").map((x) => x.trim())
            .filter((x) => /el cliente/i.test(x)).join(" · ")
        : String(f.lleva || "");
      return cab + `<tr>
        <td style="padding:9px 10px 9px 0;border-bottom:1px solid #e9ecf1;font-weight:700;white-space:nowrap;vertical-align:top">${esc(f.hora)}</td>
        <td style="padding:9px 10px 9px 0;border-bottom:1px solid #e9ecf1;color:#8a94a8;white-space:nowrap;vertical-align:top;font-size:12.5px">${f.dura_min ? esc(f.dura_min) + "′" : ""}</td>
        <td style="padding:9px 10px 9px 0;border-bottom:1px solid #e9ecf1;vertical-align:top">
          <b>${esc(f.que)}</b>${!paraCliente && f.escenas && f.escenas !== "—" ? `<span style="display:block;font-size:12px;color:#4e650f;font-weight:600">Esc. ${esc(f.escenas)}</span>` : ""}
          ${f.sinopsis ? `<span style="display:block;font-size:12.5px;color:#3d4757;line-height:1.5;margin-top:3px;padding-left:9px;border-left:2px solid #e6e9ef">${esc(f.sinopsis)}</span>` : ""}
          ${suyo ? `<span style="display:block;font-size:12px;color:#3d4757;margin-top:2px">${paraCliente ? "Ustedes traen: " : "Llevar: "}${esc(suyo)}</span>` : ""}
          ${!paraCliente && f.notas ? `<span style="display:block;font-size:12px;color:#8a94a8;margin-top:2px">${esc(f.notas)}</span>` : ""}</td>
        <td style="padding:9px 0;border-bottom:1px solid #e9ecf1;vertical-align:top;font-size:12.5px;color:#3d4757">
          ${esc(f.donde)}${f.quien ? `<span style="display:block;color:#8a94a8">${esc(f.quien)}</span>` : ""}</td>
      </tr>`;
    }).join("");

    const notasDia = String(body.notas_dia || "").trim();
    const listas = (t: unknown) => String(t ?? "").split("\n").map((x) => x.replace(/^[·\-\s]+/, "").trim())
      .filter(Boolean).map((x) => `<li>${esc(x)}</li>`).join("");
    const extra = String((pl as { premisa?: string })?.premisa || "");
    const nec = extra.includes("Hay que conseguir antes:") ? extra.split("Hay que conseguir antes:")[1].split("Ojo con:")[0] : "";
    const rie = extra.includes("Ojo con:") ? extra.split("Ojo con:")[1] : "";

    /* La cabecera, la sinopsis y quién viene los calcula la PANTALLA y viajan en el body:
       si el servidor los recalculara con su propio criterio, el email y el dashboard
       dirían horas distintas — que es exactamente el bug que este proyecto ya tuvo dos
       veces. Una sola fuente, la que se está mirando.
       (Sebastián, 26 ago 2026: "igual que lo que se ve en el dashboard, acá le falta
       info".) */
    const cab = (body.cabecera || {}) as Record<string, string | null>;
    const equipo = Array.isArray(body.equipo_lista)
      ? body.equipo_lista as Array<{ nombre: string; rol?: string; tel?: string; hora?: string }> : [];

    const asunto = String(body.asunto || "").trim() ||
      `${proj.ref ? proj.ref + " · " : ""}${proj.title || ""} — ${paraCliente ? "El día del rodaje" : "Plan de rodaje"}${fechas ? " · " + fechas : ""}`;

    /* De lo que hay que conseguir, al cliente solo le llega lo que depende de él. El resto
       —el trípode, el kit de luces— es problema nuestro y decírselo solo genera preguntas. */
    const necCliente = String(nec).split("\n").filter((x) => /cliente|ustedes|acceso|permiso|autorizaci/i.test(x)).join("\n");

    const html = emailViven({
      lang: "es",
      saludo: "Hola,",
      titulo: `${proj.ref ? "#" + proj.ref + " · " : ""}${esc(proj.title || "")}`,
      intro: paraCliente
        ? `Así queda el día del rodaje${fechas ? " del " + fechas : ""}${proj.location ? ", en " + esc(String(proj.location)) : ""}. Abajo están los horarios y lo que necesitamos de ustedes.`
        : `El plan del rodaje${fechas ? " del " + fechas : ""}${proj.location ? ", en " + esc(String(proj.location)) : ""}.`,
      cuerpo:
        /* Acá entra la citación personal de quien recibe el email — se reemplaza por
           destinatario, justo antes de mandar. La ficha de abajo queda igual y muestra la
           citación GENERAL del día: son dos datos distintos y los dos hacen falta. */
        "<!--CITACION-->" +
        /* La citación arriba de todo y GRANDE: es el único número que alguien busca a las
           seis de la mañana. Y dónde presentarse pegado a ella — son un solo dato
           operativo, y separarlos hace que se mire la hora sin leer la dirección. */
        `<table style="width:100%;border-collapse:collapse;border:1px solid #e6e9ef;border-radius:12px;margin:0 0 20px">
          <tr>
            <td style="padding:14px 16px;vertical-align:top;white-space:nowrap">
              <div style="font-size:10px;letter-spacing:.11em;text-transform:uppercase;color:#8a94a8;font-weight:700">Citación general</div>
              <div style="font-size:30px;font-weight:800;color:#1b2c46;line-height:1.1">${esc(cab.cita || "—")}</div>
            </td>
            <td style="padding:14px 16px;vertical-align:top">
              <div style="font-size:10px;letter-spacing:.11em;text-transform:uppercase;color:#8a94a8;font-weight:700">Dónde presentarse</div>
              <div style="font-size:14.5px;font-weight:600;color:#1a2230;line-height:1.4">${esc(proj.location || "sin locación cargada")}</div>
              ${cab.maps ? `<a href="${esc(cab.maps)}" style="font-size:12.5px;color:#2b6cff;text-decoration:none">Abrir en Maps →</a>` : ""}
              ${cab.viaje ? `<div style="font-size:12px;color:#8a94a8;margin-top:3px">${esc(cab.viaje)}</div>` : ""}
            </td>
            <td style="padding:14px 16px;vertical-align:top;white-space:nowrap;font-size:12.5px;color:#3d4757">
              ${cab.primera ? `<div><b style="color:#1b2c46">${esc(cab.primera)}</b> primera toma</div>` : ""}
              ${cab.fin ? `<div><b style="color:#1b2c46">${esc(cab.fin)}</b> fin estimado</div>` : ""}
              ${cab.luz ? `<div style="color:#8a94a8;margin-top:3px">Luz ${esc(cab.luz)}</div>` : ""}
            </td>
          </tr>
        </table>` +
        /* Las notas del día ANTES del cronograma: al final de un email largo no las lee
           nadie, y una nota que nadie lee es peor que no tenerla. */
        `${notasDia ? `<div style="background:#f3f7e8;border-left:3px solid #ddf98f;padding:12px 14px;margin:0 0 18px;border-radius:0 8px 8px 0">
          <div style="font-size:10px;letter-spacing:.11em;text-transform:uppercase;color:#4e650f;font-weight:700;margin-bottom:4px">Notas del día</div>
          <div style="font-size:14px;line-height:1.6;color:#3d4757;white-space:pre-wrap">${esc(notasDia)}</div></div>` : ""}` +
        `${body.mensaje ? `<div style="font-size:15px;line-height:1.65;margin:0 0 20px;padding:14px 16px;background:#fffbe9;border:1px solid #f0e2b0;border-radius:10px;white-space:pre-wrap;color:#3d4757">${esc(body.mensaje)}</div>` : ""}` +
        `<table style="width:100%;border-collapse:collapse;font-size:13.5px;color:#1a2230">${cuerpoTabla}</table>` +
        (paraCliente
          ? (necCliente.trim() ? `<h3 style="font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:#8a94a8;margin:22px 0 6px">Lo que necesitamos de ustedes</h3><ul style="margin:0;padding-left:18px;font-size:13.5px;line-height:1.6;color:#3d4757">${listas(necCliente)}</ul>` : "")
          : (nec.trim() ? `<h3 style="font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:#8a94a8;margin:22px 0 6px">Hay que conseguir antes</h3><ul style="margin:0;padding-left:18px;font-size:13.5px;line-height:1.6;color:#3d4757">${listas(nec)}</ul>` : "") +
            /* Los riesgos NO van al cliente: "si llueve no se puede rodar el patio" es una
               decisión nuestra, y en su bandeja se lee como una advertencia de que algo va
               a salir mal. */
            (rie.trim() ? `<h3 style="font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:#8a94a8;margin:20px 0 6px">Ojo con</h3><ul style="margin:0;padding-left:18px;font-size:13.5px;line-height:1.6;color:#3d4757">${listas(rie)}</ul>` : "") +
            /* Los teléfonos van en la misma hoja: se buscan cuando alguien no llegó, y ahí
               nadie abre otra pantalla. Al cliente no: es nuestro equipo. */
            (equipo.length ? `<h3 style="font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:#8a94a8;margin:22px 0 6px">Quién viene</h3>
              <table style="width:100%;border-collapse:collapse;font-size:13px">${equipo.map((p2) => `
                <tr><td style="padding:5px 10px 5px 0;border-bottom:1px solid #e9ecf1"><b style="color:#1a2230">${esc(p2.nombre)}</b></td>
                    <td style="padding:5px 10px 5px 0;border-bottom:1px solid #e9ecf1;color:#8a94a8;font-size:12px">${esc(p2.rol || "")}</td>
                    <td style="padding:5px 0;border-bottom:1px solid #e9ecf1;text-align:right;color:#3d4757;white-space:nowrap">${esc(p2.tel || "—")}</td></tr>`).join("")}
              </table>` : "")),
      pie: `${esc(remitente.nombre)} · VIVEN AG — respondiendo a este email le escribís directo.`,
      porque: paraCliente
        ? "Recibís este email porque estamos produciendo este video para ustedes."
        : "Recibís este email porque estás en el crew de este rodaje.",
    });

    if (body.dry_run) {
      return json({ ok: true, dry_run: true, asunto, html, para: destinos, sin_email: sinEmail,
                    de: remitente.nombre, responde_a: remitente.email, bloques: filas.length,
                    publico: paraCliente,
                    /* Para que el preview pueda decir si el email va a llevar el plan
                       adjunto, en vez de que se descubra al recibirlo. */
                    llevara_pdf: !!body.pdf_html && pdfConfigurado(),
                    equipo: conEmail.map((t: { name: string; email: string }) => ({ nombre: t.name, email: t.email })),
                    cliente: delCliente.map((c: { name?: string; email: string }) => ({ nombre: c.name || c.email, email: c.email })) });
    }
    if (!destinos.length) return json({ error: paraCliente
      ? "El proyecto no tiene contactos con email. Se agregan en el paso Cliente."
      : "Ninguno del crew tiene email cargado en su ficha. Cargalos en Técnicos." });
    if (!RESEND) return json({ error: "Falta RESEND_API_KEY" }, 500);

    /* El PDF sale del MISMO HTML que imprime el botón 📄 del dashboard, que llega en
       `pdf_html`. Se arma acá y no en el navegador porque el navegador no sabe hacer un
       PDF sin abrirle a alguien el diálogo de impresión.
       Si falla —o si todavía no están los secrets de Cloudflare— el email sale igual, sin
       adjunto: que falte el PDF no puede dejar al equipo sin el plan a las seis de la
       mañana. Se dice en la respuesta para que el dashboard lo avise. */
    let pdf64: string | null = body.pdf_base64 ? String(body.pdf_base64) : null;
    let pdfNota: string | null = null;
    if (!pdf64 && body.pdf_html) {
      if (!pdfConfigurado()) {
        pdfNota = "el adjunto en PDF todavía no está configurado";
      } else {
        pdf64 = await htmlAPdf(String(body.pdf_html));
        if (!pdf64) pdfNota = "no se pudo armar el PDF — el email salió sin adjunto";
      }
    }
    const adj = pdf64
      ? [{ filename: `${proj.ref || "proyecto"}_plan_de_rodaje.pdf`, content: pdf64 }]
      : [];

    /* UN EMAIL POR PERSONA, con SU citación arriba de todo.
       El plan es el mismo para todos, pero la hora a la que tiene que estar cada uno no:
       el DP monta a las 8 y el actor entra a las 11. Mandando un solo email a todos, cada
       uno lee la hora del encabezado como propia — y el que llegaba después llega temprano,
       o al revés.
       Es lo que Maestro hace bien: "esto de arriba es lo que [nombre] entiende sin abrir el
       PDF". El adjunto y el cuerpo son idénticos; lo único que cambia es el renglón de
       arriba.
       (Sebastián, 27 ago 2026: "calltime para cada persona para el plan de rodaje".) */
    const horaDe = new Map<string, { hora?: string; nombre?: string }>();
    for (const t of conEmail) {
      const suyo = equipo.find((e) => (e.nombre || "").trim().toLowerCase() === String(t.name || "").trim().toLowerCase());
      if (t.email) horaDe.set(String(t.email).toLowerCase(), { hora: suyo?.hora, nombre: t.name });
    }
    for (const c of delCliente) {
      if (c.email) horaDe.set(String(c.email).toLowerCase(), { hora: (c as { hora?: string }).hora, nombre: c.name });
    }

    const citaGeneral = String(body.cabecera?.cita || "").slice(0, 5);
    const encabezado = (mail: string) => {
      const d = horaDe.get(String(mail).toLowerCase());
      const h = String(d?.hora || "").slice(0, 5) || citaGeneral;
      if (!h) return "";
      const nom = String(d?.nombre || "").trim().split(/\s+/)[0];
      return `<table style="width:100%;border-collapse:collapse;margin:0 0 18px"><tr>` +
        `<td style="background:#0f1826;border-radius:12px;padding:16px 20px">` +
        `<div style="font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:#9aa6bd">` +
        `Tu citación${nom ? " · " + esc(nom) : ""}</div>` +
        `<div style="font:700 30px/1.1 -apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#ddf98f;margin-top:4px;` +
        `font-variant-numeric:tabular-nums">${esc(h)}</div>` +
        /* La aclaración de cuándo entra el resto es para el EQUIPO. Al cliente no le sirve
           —él viene a su hora— y encima puede leerla como que tendría que estar antes. */
        (!paraCliente && d?.hora && citaGeneral && String(d.hora).slice(0, 5) !== citaGeneral
          ? `<div style="font-size:12px;color:#9aa6bd;margin-top:4px">El resto del equipo entra ${esc(citaGeneral)}.</div>`
          : "") +
        `</td></tr></table>`;
    };

    const enviados: string[] = [];
    let fallo: string | null = null;
    for (const mail of destinos) {
      const r0 = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${RESEND}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: `${remitente.nombre} — VIVEN <${remitente.email}>`,
          to: [mail], reply_to: remitente.email, subject: asunto,
          html: html.replace("<!--CITACION-->", encabezado(mail)),
          ...(adj.length ? { attachments: adj } : {}),
        }),
      });
      if (r0.ok) enviados.push(mail);
      else { fallo = (await r0.text()).slice(0, 200); console.error("RESEND_FAIL_PLAN", r0.status, fallo); }
    }
    const r = { ok: enviados.length > 0, status: enviados.length ? 200 : 502,
                text: async () => fallo || "" } as unknown as Response;
    if (!r.ok) {
      const t = await r.text();
      console.error("RESEND_FAIL_PLAN", 502, t);
      return json({ error: `no salió (${r.status}): ${t.slice(0, 200)}` }, 502);
    }
    return json({ ok: true, para: enviados, sin_email: sinEmail, con_pdf: !!pdf64, pdf_nota: pdfNota });
  } catch (e) {
    console.error("FUNCTION_ERROR", String(e));
    return json({ error: String(e) }, 500);
  }
});
