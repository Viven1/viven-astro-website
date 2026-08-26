// Supabase Edge Function: ai-guion
// Tres guiones del mismo brief, en A/V o cinematográfico.
//
// El PLAN DE RODAJE no está acá: ya existe (ai-breakdown, "Desglosar con IA"), y sale del
// texto del guión. El circuito es: escribir tres → elegir uno → cae en el guión del
// proyecto → desglosar → jornadas y plan. Escribir un segundo generador de planes habría
// dejado dos planes distintos del mismo rodaje.
//
// Sebastián, 26 ago 2026: "¿cómo hago para generar guiones? ¿plan de rodaje completo?"
// y "solo yo, y puedo decidir cuál mandar, o mandar los tres si quiero".
//
// Por qué TRES y no uno: un guión solo no se puede juzgar —se lee y parece bien, o
// parece mal, y no hay con qué comparar. Tres ángulos distintos del mismo material
// convierten "¿está bien?" en "¿cuál?", que es una pregunta que un cliente sí sabe
// contestar. Por eso los tres tienen que ser realmente distintos entre sí: si los tres
// abren igual, no sirvieron de nada.
//
// El material sale del Project Brief del proyecto. Sin brief no hay guión: inventar la
// historia del cliente es exactamente lo que no queremos.
//
// Deploy:  supabase functions deploy ai-guion --no-verify-jwt
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

/* Los dos formatos, con un ejemplo cada uno. El ejemplo hace más que la explicación:
   sin él, "columna de video" sale como párrafo describiendo la columna. */
const FORMA_AV = `{
  "guiones": [
    {
      "angulo": "El problema antes que el producto",
      "premisa": "Una línea explicando por qué este ángulo, para que se pueda elegir sin leer el guión entero.",
      "titulo": "Título del video",
      "duracion_seg": 90,
      "filas": [
        {"n":1,"tc":"00:00","video":"Lo que se VE. Plano, sujeto, acción. Concreto y filmable.","audio":"Lo que se ESCUCHA: locución, testimonio o texto en pantalla. Escrito como se dice."},
        {"n":2,"tc":"00:08","video":"…","audio":"…"}
      ]
    }
  ]
}`;

const FORMA_CINE = `{
  "guiones": [
    {
      "angulo": "El problema antes que el producto",
      "premisa": "Una línea explicando por qué este ángulo.",
      "titulo": "Título del video",
      "duracion_seg": 90,
      "filas": [
        {"n":1,"encabezado":"INT. LABORATORIO — DÍA","accion":"Descripción de lo que pasa en la escena, en presente.","dialogo":"NOMBRE\\nLo que dice."},
        {"n":2,"encabezado":"EXT. PLANTA — TARDE","accion":"…","dialogo":""}
      ]
    }
  ]
}`;

/* Las claves del Project Brief con su pregunta. El dashboard puede mandar `etiquetas` y
   entonces manda eso; esto es el respaldo, para que un brief traído directo de la base no
   llegue como "tema: …" sin contexto. Están en español a propósito: la pregunta es para
   que la IA entienda qué contestó el cliente, no para mostrársela a nadie. */
const PREGUNTAS: Record<string, string> = {
  tema: "¿Cuál es el tema principal del video?",
  audiencia: "¿A quién le habla el video?",
  idioma: "¿En qué idioma va el video?",
  terminos: "¿Hay términos o conceptos que el público tiene que entender?",
  accion: "Después de verlo, ¿qué querés que haga?",
  mito: "¿Qué creencia equivocada te encontrás seguido sobre lo tuyo?",
  joya: "¿Hay algo único o poco conocido que valga la pena contar?",
  desafio: "¿Qué parte de lo que hacen es especialmente difícil?",
  locaciones: "¿Qué locaciones no pueden faltar?",
  otros_espacios: "¿Hay otros espacios que podamos usar?",
  gente: "¿A quién querés ver en el video?",
  restricciones: "¿Hay restricciones o normas que tengamos que saber?",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const auth = req.headers.get("Authorization") ?? "";
    const supabase = createClient(SB_URL, SB_ANON, { global: { headers: { Authorization: auth } } });
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return json({ error: "unauthorized" }, 401);
    if (!ANTHROPIC_API_KEY) return json({ error: "Falta ANTHROPIC_API_KEY" }, 500);

    const body = await req.json().catch(() => ({}));
    const projectId = body.project_id;
    const formato = body.formato === "cine" ? "cine" : "av";
    const duracion = Number.isFinite(Number(body.duracion_seg)) ? Number(body.duracion_seg) : 90;
    const pedido = String(body.indicaciones || "").slice(0, 2000);
    /* key → texto de la pregunta. Lo manda el dashboard, que ya tiene el cuestionario
       en los tres idiomas; duplicarlo acá sería tener dos versiones que se separan. */
    const etiquetas: Record<string, string> = body.etiquetas && typeof body.etiquetas === "object" ? body.etiquetas : {};
    if (!projectId) return json({ error: "falta project_id" }, 400);
    /* Ojo con los códigos: los errores que le piden algo a Sebastián van con 200 y
       {error}, porque un 4xx llega al navegador como "non-2xx status code" y el mensaje
       que explica qué falta se pierde por el camino. Los técnicos sí van con 4xx/5xx. */

    const admin = createClient(SB_URL, SERVICE);
    const { data: proj } = await admin.from("projects").select("*").eq("id", String(projectId)).maybeSingle();
    if (!proj) return json({ error: "no encontré ese proyecto" }, 404);

    /* De dónde sale el material, en orden de calidad. El brief es lo mejor —son las 12
       preguntas contestadas por el cliente— pero muchos proyectos entran por otro lado:
       ganados por email, con una llamada de descubrimiento hecha y nada más. Antes esto
       exigía el brief y se negaba; en la práctica eso dejaba sin guión justo a los
       proyectos que ya estaban andando. Ahora usa lo que haya y DICE con qué trabajó.
       Lo que no hace nunca es inventar la historia: sin ninguna de las tres fuentes, se
       niega. */
    const fuentes: string[] = [];
    const partes: string[] = [];

    const { data: brief } = await admin.from("project_briefs")
      .select("key,value").eq("project_id", proj.id);
    const rs = (brief || []).filter((b) => String(b.value || "").trim());
    if (rs.length) {
      fuentes.push("el brief del cliente");
      partes.push("EL BRIEF QUE CONTESTÓ EL CLIENTE:\n" +
        rs.map((b) => `P: ${etiquetas[b.key] || PREGUNTAS[b.key] || b.key}\nR: ${String(b.value).trim()}`).join("\n\n"));
    }

    /* El playbook: lo que se habló en la llamada de descubrimiento. Cuelga de la persona,
       no del proyecto, así que se llega por el deal. */
    {
      let leadId = proj.lead_id ?? null;
      if (!leadId && proj.deal_id) {
        const { data: d } = await admin.from("deals").select("lead_id").eq("id", proj.deal_id).maybeSingle();
        leadId = (d as { lead_id?: number } | null)?.lead_id ?? null;
      }
      if (leadId) {
        const { data: pb } = await admin.from("playbook_answers")
          .select("key,value").eq("scope", "lead").eq("ref", String(leadId));
        const pbs = (pb || []).filter((x) => String(x.value || "").trim());
        if (pbs.length) {
          fuentes.push("la llamada de descubrimiento");
          partes.push("LO QUE DIJERON EN LA LLAMADA:\n" +
            pbs.map((x) => `${x.key}: ${String(x.value).trim()}`).join("\n"));
        }
      }
    }

    if (String(proj.notes || "").trim()) {
      fuentes.push("las notas internas del proyecto");
      partes.push("NOTAS INTERNAS DEL PROYECTO:\n" + String(proj.notes).trim().slice(0, 3000));
    }

    /* Lo que Sebastián escribe en "algo que quieras pedirle" cuenta como material: es
       información suya, no inventada. Sirve sobre todo al principio, cuando el brief
       todavía no volvió y él ya sabe de qué va el video. */
    if (pedido) fuentes.push("lo que escribiste acá");

    if (!partes.length && !pedido) {
      return json({ error: "Este proyecto no tiene brief, ni playbook, ni notas. El guión sale de ahí: sin nada de eso habría que inventar la historia del cliente. Mandá el Project Brief, escribí en las notas de qué se trata, o contámelo acá abajo en «algo que quieras pedirle»." });
    }

    /* Contexto extra que ya existe y no cuesta nada traer: qué le vendimos. Una oferta
       ganada dice cuántas piezas y de qué tipo, y eso cambia el guión. */
    const { data: ofertas } = await admin.from("offers")
      .select("title,items").eq("project_id", proj.id).order("updated_at", { ascending: false }).limit(1);
    const oferta = (ofertas || [])[0];
    const entregables = oferta && Array.isArray(oferta.items)
      ? (oferta.items as Array<Record<string, unknown>>).map((it) => `· ${it.name}`).join("\n").slice(0, 1200)
      : "";

    const prompt = `Sos guionista de VIVEN AG, una productora de video B2B en Zúrich. Trabajás para clientes
industriales, médicos y técnicos: gente que sabe muchísimo de lo suyo y desconfía del marketing vacío.

PROYECTO: ${proj.ref ? "#" + proj.ref + " · " : ""}${proj.title || ""}${proj.client_contact ? " — " + proj.client_contact : ""}

${partes.join("\n\n")}
${entregables ? `\nLO QUE LES VENDIMOS:\n${entregables}` : ""}
${pedido ? `\nINDICACIONES DE SEBASTIÁN PARA ESTA TANDA:\n${pedido}` : ""}

TU TRABAJO: tres guiones de ~${duracion} segundos, para el MISMO brief, con TRES ÁNGULOS
DISTINTOS. Distintos de verdad: si los tres abren con un plano de la fábrica y una locución
que explica quiénes son, fallaste. Un ángulo es una decisión sobre por dónde entra el
espectador — el problema, una persona, un dato, el proceso, una objeción, un contraste.
Cada uno tiene que poder defenderse solo.

REGLAS:
- Todo lo que escribas en la columna de imagen tiene que ser FILMABLE con un equipo chico
  en una jornada. Nada de multitudes, drones sobre ciudades ni actores conocidos.
- Nada de afirmaciones que el cliente no haya dicho en el brief. Si necesitás un dato que
  no está, dejá el hueco marcado así: [FALTA: qué dato hace falta].
- Los primeros 5 segundos deciden si lo ven. No arranques con el logo.
- Escribí el texto hablado como se DICE, no como se escribe. Frases cortas.
- Si el brief está en otro idioma, escribí el texto hablado en el idioma del cliente y lo
  demás (ángulo, premisa, descripciones de imagen) en español, que es para uso interno.
- Entre 8 y 20 filas por guión.

Respondé SOLO con JSON válido, sin texto extra, con esta forma EXACTA:
${formato === "cine" ? FORMA_CINE : FORMA_AV}`;

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 16000, messages: [{ role: "user", content: prompt }] }),
    });
    if (!res.ok) {
      const t = await res.text();
      console.error("ANTHROPIC_ERROR", res.status, t);
      return json({ error: `Anthropic ${res.status}: ${t.slice(0, 300)}` }, 502);
    }
    const data = await res.json();
    /* Todos los bloques de texto, no content[0]. */
    let text = (Array.isArray(data.content) ? data.content : [])
      .filter((c: { type?: string; text?: string }) => c && c.type === "text" && typeof c.text === "string")
      .map((c: { text: string }) => c.text).join("\n").trim();
    text = text.replace(/^```(?:json)?/m, "").replace(/```\s*$/m, "").trim();
    const m = text.match(/\{[\s\S]*\}/);
    if (m) text = m[0];
    let parsed: { guiones?: unknown[] } | null = null;
    try { parsed = JSON.parse(text); } catch { /* abajo */ }
    if (!parsed || !Array.isArray(parsed.guiones) || !parsed.guiones.length) {
      console.error("PARSE_ERROR", data.stop_reason, text.slice(0, 400));
      return json({
        error: data.stop_reason === "max_tokens"
          ? "Los guiones salieron más largos de lo que entra en una respuesta. Probá con una duración menor."
          : "La IA no devolvió guiones válidos. Probá de nuevo.",
        stop_reason: data.stop_reason ?? null,
        muestra: text.slice(0, 300),
      }, 502);
    }

    const txt = (x: unknown, n = 4000) => String(x ?? "").slice(0, n);
    const filas = (arr: unknown): unknown[] => (Array.isArray(arr) ? arr : []).slice(0, 60).map((f, i) => {
      const r = (f || {}) as Record<string, unknown>;
      return formato === "cine"
        ? { n: i + 1, encabezado: txt(r.encabezado, 160), accion: txt(r.accion, 1200), dialogo: txt(r.dialogo, 1200) }
        : { n: i + 1, tc: txt(r.tc, 12), video: txt(r.video, 1200), audio: txt(r.audio, 1200) };
    }).filter((r) => {
      const o = r as unknown as Record<string, string>;
      return formato === "cine" ? (o.encabezado || o.accion || o.dialogo) : (o.video || o.audio);
    });

    const tanda = crypto.randomUUID();
    const nuevos = (parsed.guiones as Array<Record<string, unknown>>).slice(0, 3).map((g) => ({
      project_id: proj.id,
      tanda,
      tipo: "guion",
      formato,
      angulo: txt(g.angulo, 120) || "Sin nombre",
      premisa: txt(g.premisa, 400),
      titulo: txt(g.titulo, 200),
      duracion_seg: Number.isFinite(Number(g.duracion_seg)) ? Number(g.duracion_seg) : duracion,
      cuerpo: filas(g.filas),
    })).filter((g) => (g.cuerpo as unknown[]).length);
    if (!nuevos.length) return json({ error: "la IA devolvió guiones vacíos" }, 502);

    const { data: ins, error: errIns } = await admin.from("project_scripts").insert(nuevos).select();
    if (errIns) return json({ error: "no se pudieron guardar: " + errIns.message }, 500);

    return json({ ok: true, tanda, guiones: ins, fuentes });
  } catch (e) {
    console.error("FUNCTION_ERROR", String(e));
    return json({ error: String(e) }, 500);
  }
});
