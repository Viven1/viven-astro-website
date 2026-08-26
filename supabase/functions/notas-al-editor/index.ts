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

    const { project_id, to, version, notas, xml, edl, dry_run } = await req.json().catch(() => ({}));
    if (!project_id) return json({ error: "falta project_id" }, 400);
    const dest = String(to || "").trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(dest)) return json({ error: "el editor no tiene un email válido" }, 400);
    const lista: Nota[] = Array.isArray(notas) ? notas : [];
    if (!lista.length) return json({ error: "no hay notas con minuto para mandar" }, 400);

    const { data: p } = await service.from("projects").select("title,ref,editor").eq("id", project_id).maybeSingle();
    const ref = (p as { ref?: number } | null)?.ref;
    const titulo = (p as { title?: string } | null)?.title || "Proyecto";
    const quien = (p as { editor?: string } | null)?.editor || "";

    const asunto = `${ref ? ref + " · " : ""}${titulo} — ${lista.length} nota${lista.length === 1 ? "" : "s"} del cliente${version ? " (v" + version + ")" : ""}`;

    const filas = lista.map((n) => `
      <tr>
        <td style="padding:9px 12px 9px 0;border-bottom:1px solid #e9ecf1;white-space:nowrap;vertical-align:top;
                   font-family:ui-monospace,Menlo,monospace;font-size:13px;color:#2b6cff;font-weight:600">${esc(n.tc)}</td>
        <td style="padding:9px 0;border-bottom:1px solid #e9ecf1;font-size:14px;line-height:1.55;color:#1a2230">
          ${esc(n.texto)}${n.autor ? `<span style="display:block;color:#8a94a8;font-size:12px;margin-top:2px">${esc(n.autor)}</span>` : ""}</td>
      </tr>`).join("");

    const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:640px;color:#1a2230">
      <p style="font-size:15px;margin:0 0 4px">${quien ? "Hola " + esc(quien.split(/\s+/)[0]) + "," : "Hola,"}</p>
      <p style="font-size:15px;line-height:1.65;margin:0 0 20px">
        El cliente dejó <b>${lista.length} nota${lista.length === 1 ? "" : "s"}</b> sobre
        <b>${esc(titulo)}</b>${version ? " (versión " + esc(String(version)) + ")" : ""}.
        Están abajo con su minuto, y adjunto va el <b>.xml</b> para importar en Premiere:
        cada nota entra como marcador en el timeline, en su posición.</p>
      <table style="width:100%;border-collapse:collapse;margin:0 0 22px">${filas}</table>
      <p style="font-size:13px;color:#6b7896;line-height:1.6;margin:0">
        El <b>.xml</b> se importa desde Archivo → Importar. El <b>.edl</b> va por si tu programa
        no lee el xml.</p>
      <p style="font-size:12px;color:#9aa6bd;margin:22px 0 0;border-top:1px solid #e9ecf1;padding-top:14px">
        VIVEN AG · Zúrich — respondiendo a este email le escribís al equipo.</p>
    </div>`;

    if (dry_run) return json({ ok: true, dry_run: true, para: dest, asunto, html, notas: lista.length });

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
