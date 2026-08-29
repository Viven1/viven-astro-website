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
import { REGLA_JORNADA } from "../_shared/jornada.ts";

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

/* ── LOS ESQUEMAS ──
   Ya no son ejemplos pegados al final del prompt: son JSON Schema que la API HACE CUMPLIR
   (`output_config.format`). "Respondé solo con JSON" funciona casi siempre, y el casi es el
   problema — un "Acá van los guiones:" adelante rompe el parseo y se pierde la tanda
   entera, después de haberla pagado.
   (Sebastián, 26 ago 2026: "que sea el desglose con IA siempre, que sale muy bien".) */
const guionComun = {
  angulo: { type: "string", description: "El nombre del ángulo. Una decisión sobre por dónde entra el espectador: «El problema antes que el producto»." },
  premisa: { type: "string", description: "Una línea explicando por qué este ángulo, para poder elegir sin leer el guion entero." },
  titulo: { type: "string" },
  duracion_seg: { type: "integer" },
};

const FORMA_AV = {
  type: "object",
  properties: {
    guiones: {
      type: "array",
      items: {
        type: "object",
        properties: {
          ...guionComun,
          filas: {
            type: "array",
            items: {
              type: "object",
              properties: {
                n: { type: "integer" },
                tc: { type: "string", description: "El minuto donde empieza la fila: «00:08»." },
                video: { type: "string", description: "Lo que se VE. Plano, sujeto, acción. Concreto y filmable con un equipo chico." },
                audio: { type: "string", description: "Lo que se ESCUCHA: locución, testimonio o texto en pantalla. Escrito como se dice." },
              },
              required: ["n", "tc", "video", "audio"],
              additionalProperties: false,
            },
          },
        },
        required: ["angulo", "premisa", "titulo", "duracion_seg", "filas"],
        additionalProperties: false,
      },
    },
  },
  required: ["guiones"],
  additionalProperties: false,
};

const FORMA_CINE = {
  type: "object",
  properties: {
    guiones: {
      type: "array",
      items: {
        type: "object",
        properties: {
          ...guionComun,
          filas: {
            type: "array",
            items: {
              type: "object",
              properties: {
                n: { type: "integer" },
                encabezado: { type: "string", description: "«INT. LABORATORIO — DÍA»." },
                accion: { type: "string", description: "Qué pasa en la escena, en presente. Los PERSONAJES en mayúscula: «LA DUEÑA revisa el teléfono»." },
                dialogo: { type: "string", description: "NOMBRE, salto de línea, lo que dice. Vacío si no habla nadie." },
              },
              required: ["n", "encabezado", "accion", "dialogo"],
              additionalProperties: false,
            },
          },
        },
        required: ["angulo", "premisa", "titulo", "duracion_seg", "filas"],
        additionalProperties: false,
      },
    },
  },
  required: ["guiones"],
  additionalProperties: false,
};

/* El plan de rodaje. No es el guion partido en pedazos: se ordena por LUGAR y por quién
   aparece, NO por el orden en que se ve el video. Ese reordenamiento es todo el valor de un
   plan — filmar en orden de guion es la forma más cara de perder un día. */
const FORMA_PLAN = {
  type: "object",
  properties: {
    titulo: { type: "string" },
    filas: {
      type: "array",
      items: {
        type: "object",
        properties: {
          bloque: { type: "string", description: "La jornada y el momento: «Jornada 1 · Mañana». Si el rodaje es de UN SOLO día, escribí solo «Mañana», «Mediodía» o «Tarde» — poner «Jornada 1» en cada fila de un rodaje de un día es ruido." },
          hora: { type: "string", description: "«08:00»." },
          dura_min: { type: "integer", description: "Cuántos minutos dura el bloque. Realista: montar una entrevista lleva 30-45, no 10." },
          /* En un bloque de rodaje va QUÉ PASA en esas escenas —la sinopsis— no el nombre
             de la tarea. El equipo lee esto para entender qué está filmando; "Rodaje de la
             apertura: notificaciones, búsqueda en el cuaderno" es una etiqueta, no una
             escena. En los bloques que no son rodaje (llegada, almuerzo, viaje) sí va el
             nombre de la tarea, que es todo lo que hay que saber.
             (Sebastián, 26 ago 2026: "ahí va sinopsis de esa escena para entender qué
             hacemos".) */
          que: { type: "string", description: "Si se ruedan escenas: QUÉ PASA en ellas, en una o dos frases, como se lo contarías a alguien que no leyó el guion. Si no es rodaje (llegada, montaje, almuerzo, viaje): el nombre de la tarea, a secas." },
          donde: { type: "string" },
          quien: { type: "string", description: "Quién tiene que estar. Incluido el cliente cuando hace falta." },
          escenas: { type: "string", description: "Los números de escena que entran acá, o «—»." },
          lleva: { type: "string", description: "Lo que tiene que estar en ese bloque, del desglose de esas escenas. Vacío si no hace falta nada especial." },
          notas: { type: "string", description: "Por qué está en ese orden, qué puede complicarse, la luz." },
        },
        required: ["bloque", "hora", "dura_min", "que", "donde", "quien", "escenas", "lleva", "notas"],
        additionalProperties: false,
      },
    },
    necesita: { type: "array", items: { type: "string" }, description: "Lo que hay que conseguir o confirmar antes del rodaje." },
    riesgos: { type: "array", items: { type: "string" }, description: "Lo que puede tirar abajo el día, con qué hacer si pasa." },
  },
  required: ["titulo", "filas", "necesita", "riesgos"],
  additionalProperties: false,
};

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

    /* ── PLAN DE RODAJE ──
       Se puede pedir las veces que haga falta: sale mal, o el rodaje cambia, y hay que
       rehacerlo. Por eso esta rama NO GUARDA NADA. Devuelve la propuesta entera y la
       guarda el dashboard cuando Sebastián toca "usar este plan" — el plan que ya estaba,
       con lo que él editó a mano, no se pisa por pedir otra sugerencia.
       (Es la regla que ya usa Maestro: el servidor prepara la decisión al 100% y no
       escribe una fila hasta que alguien confirma.) */
    if (body.tipo === "plan") {
      const { data: elegidos } = await admin.from("project_scripts")
        .select("*").eq("project_id", proj.id).eq("tipo", "guion").eq("elegido", true).limit(1);
      const g = (elegidos || [])[0];

      /* Sin guión elegido igual se puede planificar: hay proyectos que se ruedan con un
         brief y una llamada, sin guión escrito. Lo que no se hace es inventar escenas. */
      const escenas = g
        ? (Array.isArray(g.cuerpo) ? g.cuerpo as Array<Record<string, unknown>> : [])
            .map((f) => g.formato === "cine"
              ? `${f.n}. ${f.encabezado || ""} — ${String(f.accion || "").slice(0, 220)}`
              : `${f.n}. [${f.tc || ""}] ${String(f.video || "").slice(0, 220)}`).join("\n")
        : "";

      /* El DESGLOSE, si ya se hizo. Un plan de rodaje que no sabe qué hay que llevar a cada
         bloque es una agenda, no un plan: la mitad del trabajo de producción es que las
         cosas estén donde tienen que estar a la hora que tienen que estar.
         Cada elemento viene con su ficha —cuántos, de quién, quién lo trae— así que el plan
         puede decir qué va en cada bloque en vez de repetir una lista genérica.
         (Sebastián, 26 ago 2026: "para el desglose, y plan de rodaje, escenas, pensá más
         como Maestro… cada ítem tiene su propia info adentro".) */
      const desg = proj.breakdown as { escenas?: Array<Record<string, unknown>> } | null;
      const conElementos = (desg?.escenas || [])
        .filter((e) => Array.isArray(e.elementos) && (e.elementos as unknown[]).length)
        .map((e) => {
          const els = (e.elementos as Array<Record<string, unknown>>)
            .map((el) => `   · ${el.cantidad && Number(el.cantidad) > 1 ? el.cantidad + "× " : ""}${el.que}` +
              `${el.quien ? " (de " + el.quien + ")" : ""}${el.donde ? " — " + el.donde : ""}` +
              `${el.quien_lo_consigue ? " [lo trae: " + el.quien_lo_consigue + "]" : ""}`).join("\n");
          return `Escena ${e.n} — ${e.titulo || ""}${e.locacion ? " · " + e.locacion : ""}\n${els}`;
        }).join("\n\n");

      const fechas = [proj.shoot_start ? "Arranca el " + String(proj.shoot_start).slice(0, 10) : "",
                      proj.shoot_end ? "Termina el " + String(proj.shoot_end).slice(0, 10) : ""]
                     .filter(Boolean).join(". ");

      /* El plan que ya existe entra en el prompt cuando se pide rehacerlo: si Sebastián
         corrigió horarios o agregó un bloque, una versión nueva que los ignore le hace
         perder ese trabajo. */
      const previo = Array.isArray(body.plan_actual) && body.plan_actual.length
        ? "EL PLAN QUE YA HAY (corregido a mano — respetá lo que tenga sentido y decí en 'riesgos' qué cambiaste y por qué):\n" +
          (body.plan_actual as Array<Record<string, unknown>>).slice(0, 80)
            .map((f) => `${f.bloque || ""} ${f.hora || ""} — ${f.que || ""} · ${f.donde || ""} · ${f.quien || ""}${f.notas ? " (" + f.notas + ")" : ""}`)
            .join("\n")
        : "";

      const promptPlan = `Sos director de producción de VIVEN AG, productora de video B2B en Zúrich.
Armá el plan de rodaje.

PROYECTO: ${proj.ref ? "#" + proj.ref + " · " : ""}${proj.title || ""}${proj.client_contact ? " — " + proj.client_contact : ""}
${fechas ? "FECHAS DE RODAJE: " + fechas : "FECHAS DE RODAJE: sin definir — planificá jornadas relativas (Jornada 1, 2…), no fechas."}
${g ? `GUIÓN ELEGIDO: "${g.titulo || g.angulo}" (${g.angulo}) · ~${g.duracion_seg || duracion}s\n\nESCENAS:\n${escenas}` : "NO hay guión escrito todavía: planificá con lo que dice el material de abajo y decí en 'riesgos' qué queda por definir."}

${conElementos ? `LO QUE HAY QUE LLEVAR, ESCENA POR ESCENA (sale del desglose ya hecho — no lo repitas
entero, usalo para saber qué entra en cada bloque y qué hay que pedirle al cliente):
${conElementos}

` : ""}MATERIAL DEL PROYECTO (de acá salen los accesos, los permisos y quién aparece):
${partes.join("\n\n") || "(poco material — decí en 'riesgos' qué falta saber)"}
${previo ? "\n" + previo : ""}
${pedido ? `\nINDICACIONES DE SEBASTIÁN:\n${pedido}` : ""}

${REGLA_JORNADA}

REGLAS:
- Si el rodaje es de un solo día, NO numeres jornadas: el bloque es «Mañana», «Mediodía» o
  «Tarde» a secas. Numerar la única jornada que hay es ruido en cada fila.
- Ordená por LUGAR y por quién aparece, NO por el orden del video. Todo lo de una persona
  junto, todo lo de un espacio junto. Decilo en 'notas' cuando reordenes.
- En 'que', para los bloques de rodaje, va la SINOPSIS de lo que se filma ahí: qué pasa, en
  una o dos frases. Sale del resumen de esas escenas. No es el nombre de la tarea ni una
  lista de planos — el que lo lee quiere entender qué está filmando, y el número de escena
  ya está en su columna.
- En 'lleva' va lo que tiene que ESTAR en ese bloque: las cosas del desglose de las escenas
  que se ruedan ahí, con su cantidad. No la lista entera del proyecto — solo lo de ese
  bloque. Vacío si no hace falta nada especial (llegada, comida, desmontaje).
- Equipo chico: no supongas más de 3 o 4 personas de VIVEN salvo que el material diga otra cosa.
- Bloques de tiempo realistas: montar una entrevista lleva 30–45 min, no 10.
- Incluí llegada, montaje, comida, desmontaje Y EL VIAJE DE VUELTA. El almuerzo va siempre y
  es una hora. El último bloque es el regreso: la jornada termina cuando el equipo llegó, no
  cuando se apaga la cámara.
- Todo lo que dependa del cliente —accesos, permisos, gente disponible, ropa— va en
  'necesita', que es la lista que le mandamos antes.
- Si el guión pide algo que no se puede filmar con ese equipo o ese acceso, decilo en
  'riesgos' con la alternativa. No lo saques en silencio.
- Nada de dar por cerrado lo que no sabés: si falta un dato, va en 'riesgos', no inventado
  adentro de una fila.
- Todo en español, es para uso interno.

El plan tiene que poder ejecutarse tal cual está: cada bloque con su hora, su lugar y quién
tiene que estar.`;

      const rp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-5", max_tokens: 12000,
          output_config: { effort: "medium", format: { type: "json_schema", schema: FORMA_PLAN } },
          messages: [{ role: "user", content: promptPlan }],
        }),
      });
      if (!rp.ok) {
        const t = await rp.text();
        console.error("ANTHROPIC_ERROR", rp.status, t);
        return json({ error: `Anthropic ${rp.status}: ${t.slice(0, 300)}` }, 502);
      }
      const dp = await rp.json();
      let tp = (Array.isArray(dp.content) ? dp.content : [])
        .filter((c: { type?: string; text?: string }) => c && c.type === "text" && typeof c.text === "string")
        .map((c: { text: string }) => c.text).join("\n").trim();
      let pp: Record<string, unknown> | null = null;
      try { pp = JSON.parse(tp); } catch { /* abajo */ }
      if (!pp || !Array.isArray(pp.filas) || !pp.filas.length) {
        console.error("PARSE_ERROR_PLAN", dp.stop_reason, tp.slice(0, 400));
        return json({ error: dp.stop_reason === "max_tokens"
          ? "El plan salió más largo de lo que entra en una respuesta. Probá con menos escenas."
          : "La IA no devolvió un plan válido. Probá de nuevo." });
      }
      const t2 = (x: unknown, n = 600) => String(x ?? "").slice(0, n);
      const fp = (pp.filas as Array<Record<string, unknown>>).slice(0, 80).map((f, i) => ({
        n: i + 1, bloque: t2(f.bloque, 80), hora: t2(f.hora, 12),
        dura_min: Number.isFinite(Number(f.dura_min)) ? Math.max(0, Math.round(Number(f.dura_min))) : 0,
        que: t2(f.que, 300),
        donde: t2(f.donde, 160), quien: t2(f.quien, 200), escenas: t2(f.escenas, 80),
        lleva: t2(f.lleva, 500), notas: t2(f.notas, 600),
      })).filter((f) => f.que);
      const lista = (x: unknown) => (Array.isArray(x) ? x : []).filter(Boolean).map((y) => String(y).slice(0, 400)).slice(0, 20);

      /* Se devuelve, NO se guarda. */
      return json({ ok: true, propuesta: {
        titulo: t2(pp.titulo, 200) || "Plan de rodaje",
        filas: fp, necesita: lista(pp.necesita), riesgos: lista(pp.riesgos),
        guion: g ? (g.titulo || g.angulo) : null,
      } });
    }

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
- LAS PERSONAS, EN MAYÚSCULA, siempre y en todas las filas: «LA DUEÑA revisa el teléfono»,
  «sale a recibir a un HUÉSPED que llega con valijas». Es la convención del guion y sirve
  para algo concreto: leyendo en diagonal se ve de un vistazo cuánta gente hay que convocar
  y quién aparece en qué escena. «La dueña» en minúscula se lee como decorado.
  (Sebastián, 28 ago 2026: "las personas van siempre en mayúscula para entender quiénes son".)

Los tres guiones, completos.`;

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-5", max_tokens: 16000,
        /* Escribir tres guiones distintos SÍ es razonamiento: acá el effort alto se nota,
           a diferencia del desglose, que es lectura. */
        output_config: { effort: "high", format: { type: "json_schema", schema: formato === "cine" ? FORMA_CINE : FORMA_AV } },
        messages: [{ role: "user", content: prompt }],
      }),
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
    /* Sin limpiar backticks ni buscar la primera llave: con el esquema aplicado por la
       API, la respuesta ES el JSON. */
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
