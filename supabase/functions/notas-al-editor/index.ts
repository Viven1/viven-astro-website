// Supabase Edge Function: notas-al-editor
//
// Las notas del cliente, al que monta. Sebastián, 26 ago 2026: "toca poder enviar al
// editor que trabaja en eso… le envía el xml más todos los comentarios con timestamps
// para que lo vea en el email."
//
// Las dos cosas en el mismo envío, y ese "para que lo vea en el email" es el punto: el
// .xml sirve adentro de Premiere, pero el montajista lee el mail antes de abrir nada. Si
// las notas solo viajan adjuntas, la primera lectura obliga a importar un archivo.
//
// El .xml y el .edl los arma el dashboard —es el mismo generador probado que usa el
// botón de descargar— y viajan como texto. Acá se adjuntan y se manda.
//
// Deploy: supabase functions deploy notas-al-editor --no-verify-jwt
// Secret: RESEND_API_KEY

import { registrarEmail } from "../_shared/email.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const RESEND = Deno.env.get("RESEND_API_KEY")!;
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const service = createClient(SB_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const esc = (x: unknown) => String(x ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));
const b64 = (s: string) => {
  /* btoa() no acepta acentos: un comentario con "cámara" tiraba InvalidCharacterError y
     el email salía sin adjunto. Se pasa por UTF-8 primero. */
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
};

type Nota = { tc: string; autor: string; texto: string };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const auth = req.headers.get("Authorization") ?? "";
    const supabase = createClient(SB_URL, SB_ANON, { global: { headers: { Authorization: auth } } });
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return json({ error: "unauthorized" }, 401);
    if (!RESEND) return json({ error: "Falta RESEND_API_KEY" }, 500);

    const { project_id, to, version, notas, xml, edl, video_url, portal_url, dry_run } = await req.json().catch(() => ({}));
    if (!project_id) return json({ error: "falta project_id" }, 400);
    const dest = String(to || "").trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(dest)) return json({ error: "el editor no tiene un email válido" }, 400);
    const lista: Nota[] = Array.isArray(notas) ? notas : [];
    if (!lista.length) return json({ error: "no hay notas con minuto para mandar" }, 400);

    /* El montajista suele trabajar para varias productoras a la vez: si el email no dice
       de qué proyecto es, tiene que adivinar por el nombre del adjunto. Va con el número,
       el nombre, el cliente y la fecha de entrega. (Sebastián, 26 ago 2026: "que dé info
       sobre el proyecto, con su número y nombre propio… para evitar errores".) */
    const { data: p } = await service.from("projects")
      .select("title,ref,editor,lead_id,delivery_due,shoot_start,shoot_end,deliverable_url,stage")
      .eq("id", project_id).maybeSingle();
    const pr = (p ?? {}) as {
      title?: string; ref?: number; editor?: string; lead_id?: number;
      delivery_due?: string; shoot_start?: string; shoot_end?: string; deliverable_url?: string; stage?: string;
    };
    const ref = pr.ref;
    const titulo = pr.title || "Proyecto";
    const quien = pr.editor || "";

    const { data: cli } = pr.lead_id
      ? await service.from("leads").select("name,company").eq("id", pr.lead_id).maybeSingle()
      : { data: null };
    const cliente = (cli as { company?: string; name?: string } | null);
    const dmy = (d?: string) => d ? String(d).slice(0, 10).split("-").reverse().join(".") : "";

    const ficha = [
      ["Proyecto", `${ref ? "<b>" + ref + "</b> · " : ""}${esc(titulo)}`],
      ["Cliente", esc(cliente?.company || cliente?.name || "")],
      ["Versión", version ? "v" + esc(String(version)) : ""],
      ["Rodaje", pr.shoot_start ? dmy(pr.shoot_start) + (pr.shoot_end && pr.shoot_end !== pr.shoot_start ? " – " + dmy(pr.shoot_end) : "") : ""],
      ["Entrega", dmy(pr.delivery_due)],
    ].filter(([, v]) => v).map(([k, v]) => `
      <tr><td style="padding:4px 14px 4px 0;color:#8a94a8;font-size:12.5px;white-space:nowrap;vertical-align:top">${k}</td>
          <td style="padding:4px 0;font-size:13.5px;color:#1a2230">${v}</td></tr>`).join("");

    const asunto = `${ref ? ref + " · " : ""}${titulo} — ${lista.length} nota${lista.length === 1 ? "" : "s"} del cliente${version ? " (v" + version + ")" : ""}`;

    /* Cada minuto es un LINK que abre el corte en ese segundo exacto.
       Sebastián preguntó si se podían adjuntar capturas de cada nota. No se puede: el
       corte está en Vimeo, y sacar el cuadro de un segundo dado necesita el archivo o
       ffmpeg —el iframe es de otro dominio y el navegador no deja capturarlo—. Esto es
       mejor que una captura igual: se abre el video andando, en contexto, y no hay que
       adivinar si la captura es del cuadro correcto.
       Vimeo entiende #t=94s en la URL. */
    const linkTC = (tc: string) => {
      const [h, m2, sg] = tc.split(":").map((x) => parseInt(x, 10) || 0);
      const ms = (h * 3600 + m2 * 60 + sg) * 1000;
      /* Al PORTAL, no a vimeo.com. El corte está privado —solo se reproduce embebido en
         viven.ch— así que un link a vimeo.com no muestra nada. El portal lo abre en el
         segundo pedido y con las notas al lado. */
      if (portal_url) return String(portal_url) + "&tc=" + ms;
      const base = String(video_url || pr.deliverable_url || "").trim();
      if (!base) return null;
      return base.replace(/#.*$/, "") + "#t=" + Math.round(ms / 1000) + "s";
    };

    const filas = lista.map((n) => `
      <tr>
        <td style="padding:9px 12px 9px 0;border-bottom:1px solid #e9ecf1;white-space:nowrap;vertical-align:top;
                   font-family:ui-monospace,Menlo,monospace;font-size:13px;color:#2b6cff;font-weight:600">${
                     linkTC(n.tc) ? `<a href="${esc(linkTC(n.tc))}" style="color:#2b6cff;text-decoration:none">${esc(n.tc)} ↗</a>` : esc(n.tc)}</td>
        <td style="padding:9px 0;border-bottom:1px solid #e9ecf1;font-size:14px;line-height:1.55;color:#1a2230">
          ${esc(n.texto)}${n.autor ? `<span style="display:block;color:#8a94a8;font-size:12px;margin-top:2px">${esc(n.autor)}</span>` : ""}</td>
      </tr>`).join("");

    const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:640px;color:#1a2230">
      <p style="font-size:15px;margin:0 0 4px">${quien ? "Hola " + esc(quien.split(/\s+/)[0]) + "," : "Hola,"}</p>
      <p style="font-size:15px;line-height:1.65;margin:0 0 18px">
        El cliente dejó <b>${lista.length} nota${lista.length === 1 ? "" : "s"}</b> sobre el corte.
        Están abajo con su minuto, y adjunto va el <b>.xml</b> para importar en Premiere:
        cada nota entra como marcador en el timeline, en su posición.</p>
      <table style="border-collapse:collapse;margin:0 0 22px;background:#f6f8fb;border-radius:10px;padding:4px">
        ${ficha}
      </table>${(portal_url || pr.deliverable_url) ? `
      <p style="font-size:13.5px;margin:-12px 0 20px"><a href="${esc(portal_url || pr.deliverable_url)}" style="color:#2b6cff">Ver el corte ↗</a></p>` : ""}
      <table style="width:100%;border-collapse:collapse;margin:0 0 22px">${filas}</table>
      <p style="font-size:13px;color:#6b7896;line-height:1.6;margin:0">
        El <b>.xml</b> se importa desde Archivo → Importar. El <b>.edl</b> va por si tu programa
        no lee el xml.${(portal_url || video_url || pr.deliverable_url) ? " Cada minuto de arriba abre el corte en ese segundo." : ""}</p>
      <p style="font-size:12px;color:#9aa6bd;margin:22px 0 0;border-top:1px solid #e9ecf1;padding-top:14px">
        VIVEN AG · Zúrich — respondiendo a este email le escribís al equipo.</p>
    </div>`;

    if (dry_run) return json({ ok: true, dry_run: true, para: dest, asunto, html, notas: lista.length });

    /* El nombre del archivo también dice de qué proyecto es: en la carpeta de descargas
       del montajista, "1201_Sonova_New_Sound_v2_notas.xml" se distingue de otro; un
       "notas.xml" suelto, no. */
    const nombre = `${ref || "proyecto"}_${String(titulo).replace(/[^\w.\-]+/g, "_").slice(0, 40)}${version ? "_v" + version : ""}_notas`;
    const adj = [
      ...(xml ? [{ filename: nombre + ".xml", content: b64(String(xml)) }] : []),
      ...(edl ? [{ filename: nombre + ".edl", content: b64(String(edl)) }] : []),
    ];

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "VIVEN AG <info@viven.ch>", to: [dest], reply_to: "info@viven.ch",
        subject: asunto, html, attachments: adj,
      }),
    });
    if (!res.ok) {
      const t = await res.text();
      console.error("RESEND_FAIL", res.status, t);
      return json({ error: `no salió (${res.status}): ${t.slice(0, 200)}` }, 502);
    }

    /* Queda en la ficha si el editor es alguien que existe como contacto; si es un
       freelance suelto, registrarEmail lo busca por email y si no lo encuentra guarda
       la línea igual, sin persona. Mejor un registro huérfano que ninguno. */
    await registrarEmail({
      service, to: dest, subject: asunto,
      body: lista.map((n) => `${n.tc} — ${n.texto}`).join("\n"),
      source: "notas-al-editor", senderLabel: "VIVEN",
    });

    return json({ ok: true, para: dest, notas: lista.length, adjuntos: adj.length });
  } catch (e) {
    console.error("FUNCTION_ERROR", String(e));
    return json({ error: String(e) }, 500);
  }
});
