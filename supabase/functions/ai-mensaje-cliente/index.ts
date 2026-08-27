// Supabase Edge Function: ai-mensaje-cliente
// Escribe el email que le mandamos al cliente desde el proyecto: asunto y cuerpo, con el
// saludo y el cierre adentro, en el idioma del cliente.
//
// Por qué no son plantillas: las plantillas fijas dicen lo mismo para el proyecto que
// arranca y para el que va por la v4 con seis notas sin resolver. La IA acá tiene el
// material que hace que el email valga — cómo se llama, en qué etapa está, qué versión
// vio, qué contestó en el brief.
// (Sebastián, 26 ago 2026: "sin saludo, hola como andas? etc? por favor usa la IA bien
//  usada.")
//
// Deploy:  supabase functions deploy ai-mensaje-cliente
// Secret:  ANTHROPIC_API_KEY

import { createClient } from "jsr:@supabase/supabase-js@2";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

const ESQUEMA = {
  type: "object",
  properties: {
    asunto: { type: "string", description: "Lo que se lee en la bandeja. Sin el nombre del proyecto adelante si ya se entiende; nunca en MAYÚSCULAS ni con signos de exclamación." },
    mensaje: { type: "string", description: "El cuerpo entero, empezando por el saludo y terminando por el cierre. Texto plano con saltos de línea; los párrafos se separan con una línea en blanco. Sin firma: la firma la pone el email." },
  },
  required: ["asunto", "mensaje"],
  additionalProperties: false,
};

const IDIOMA: Record<string, string> = {
  es: "español rioplatense (vos, no tú)",
  en: "inglés",
  de: "alemán suizo estándar (Hochdeutsch, con ss en vez de ß)",
};

const QUE: Record<string, string> = {
  portal: "Avisarle que su portal está listo y que ahí ve el corte, comenta y baja los archivos.",
  version: "Avisarle que hay una versión nueva para ver, y pedirle los comentarios.",
  brief: "Pedirle que conteste el Project Brief, que es de donde sale el guion.",
  factura: "Avisarle que le mandamos la factura de este proyecto.",
  notas: "Contarle en qué quedaron sus notas: qué se cambió y qué falta.",
  libre: "Escribirle sobre el estado del proyecto, con lo que sea más útil que sepa ahora.",
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
    if (!body.project_id) return json({ error: "falta project_id" }, 400);
    const intencion = String(body.intencion || "libre");
    const lang = ["es", "en", "de"].includes(String(body.lang)) ? String(body.lang) : "en";

    const service = createClient(SB_URL, SERVICE);
    const { data: proj } = await service.from("projects")
      .select("id,ref,title,stage,shoot_start,shoot_end,delivery_due,delivered_at,brief_sent_at,brief_done_at,lead_id")
      .eq("id", String(body.project_id)).maybeSingle();
    if (!proj) return json({ error: "no encontré ese proyecto" }, 404);

    /* El material real del proyecto. Nada de esto es opcional-pero-lindo: es la diferencia
       entre "te escribo por el proyecto" y un email que el cliente reconoce como suyo. */
    const [briefQ, versQ, comsQ, leadQ] = await Promise.all([
      service.from("project_briefs").select("key,value").eq("project_id", proj.id),
      service.from("project_versions").select("n,created_at,approved_at,notes_done_at").eq("project_id", proj.id).order("n", { ascending: false }).limit(3),
      service.from("project_comments").select("body,resolved,from_client").eq("project_id", proj.id).eq("from_client", true).eq("resolved", false).limit(12),
      proj.lead_id ? service.from("leads").select("name,company,lang").eq("id", String(proj.lead_id)).maybeSingle() : Promise.resolve({ data: null }),
    ]);

    const nombres: string[] = Array.isArray(body.destinatarios)
      ? body.destinatarios.map((n: unknown) => String(n || "").trim()).filter(Boolean)
      : [];
    const lead = (leadQ as { data?: { name?: string; company?: string } }).data || {};
    const vers = versQ.data || [];
    const ultima = vers[0];
    const notas = (comsQ.data || []).map((c: { body: string }) => String(c.body || "").slice(0, 160));
    const brief = (briefQ.data || []).filter((b: { value?: string }) => String(b.value || "").trim())
      .map((b: { key: string; value: string }) => `- ${b.key}: ${String(b.value).slice(0, 300)}`).join("\n");

    const dmy = (d?: string | null) => d ? String(d).slice(0, 10).split("-").reverse().join(".") : "";
    const ficha = [
      `Proyecto: ${proj.title || ""}${proj.ref ? ` (ref ${proj.ref})` : ""}`,
      lead.company ? `Empresa del cliente: ${lead.company}` : "",
      nombres.length ? `Le escribimos a: ${nombres.join(", ")}` : "",
      `Etapa: ${proj.stage || "—"}`,
      proj.shoot_start ? `Rodaje: ${dmy(proj.shoot_start)}${proj.shoot_end && proj.shoot_end !== proj.shoot_start ? " – " + dmy(proj.shoot_end) : ""}` : "",
      proj.delivery_due ? `Entrega prevista: ${dmy(proj.delivery_due)}` : "",
      proj.delivered_at ? `Ya entregado el ${dmy(proj.delivered_at)}` : "",
      ultima ? `Última versión: v${ultima.n}${ultima.approved_at ? " (aprobada)" : " (sin aprobar)"}` : "Todavía no hay ninguna versión subida",
      notas.length ? `Notas del cliente sin resolver (${notas.length}):\n${notas.map((n) => "  · " + n).join("\n")}` : "",
      proj.brief_done_at ? "El brief está contestado y cerrado." : proj.brief_sent_at ? "El brief se mandó pero no está terminado." : "El brief todavía no se mandó.",
    ].filter(Boolean).join("\n");

    const quien = String(body.de_nombre || "").trim() || "el equipo de VIVEN";

    const prompt = `Sos ${quien}, de VIVEN AG, una productora de video en Zúrich. Escribís un email a un cliente sobre un proyecto en curso.

QUÉ HAY QUE DECIRLE
${QUE[intencion] || QUE.libre}
${body.pedido ? `\nY además, con estas palabras del productor: "${String(body.pedido).slice(0, 500)}"` : ""}

EL PROYECTO
${ficha}
${brief ? `\nLO QUE EL CLIENTE CONTÓ EN EL BRIEF\n${brief}` : ""}

CÓMO SE ESCRIBE
- En ${IDIOMA[lang]}. El cliente lo lee en ese idioma; no mezcles.
- Empezá con el saludo por el nombre de pila de quien recibe, y terminá con un cierre corto. Sin firma: la pone el email.
- Tres párrafos como mucho. Un email que se lee en el teléfono entre dos reuniones.
- Concreto sobre ESTE proyecto: si tenés el nombre de la marca, la versión o lo que contó en el brief, usalo. Un email que serviría para cualquier cliente no sirve para ninguno.
- Prohibido: "espero que estés bien", "espero que este email te encuentre bien", "no dudes en contactarnos", signos de exclamación, mayúsculas para enfatizar, emojis.
- Prohibido decir que vimos lo que hizo el cliente ("vi que abriste", "noté que todavía no entraste"). Sabemos cosas que a él le resultan invasivas si se las decimos.
- Nunca inventes fechas, precios, plazos ni nombres que no estén acá arriba. Si algo falta, no lo menciones.
- No describas el botón ni pegues links: el email ya lleva su botón.
- Pedí una sola cosa, la que importa.

Escribí el asunto y el mensaje.`;

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-5", max_tokens: 2000,
        output_config: { effort: "medium", format: { type: "json_schema", schema: ESQUEMA } },
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) {
      const t = await res.text();
      console.error("ANTHROPIC_ERROR", res.status, t);
      return json({ error: `Anthropic ${res.status}: ${t.slice(0, 300)}` }, 502);
    }
    const data = await res.json();
    const text = (Array.isArray(data.content) ? data.content : [])
      .filter((c: { type?: string; text?: string }) => c && c.type === "text" && typeof c.text === "string")
      .map((c: { text: string }) => c.text).join("\n").trim();
    let parsed: { asunto?: string; mensaje?: string } | null = null;
    try { parsed = JSON.parse(text); } catch { /* abajo */ }
    if (!parsed || !parsed.mensaje) {
      console.error("PARSE_ERROR", data.stop_reason, text.slice(0, 300));
      return json({ error: "La IA no devolvió un mensaje válido. Probá de nuevo." }, 502);
    }

    return json({ ok: true, asunto: parsed.asunto || proj.title || "", mensaje: parsed.mensaje });
  } catch (e) {
    console.error("AI_MENSAJE_ERROR", String(e));
    return json({ error: String(e) }, 500);
  }
});
