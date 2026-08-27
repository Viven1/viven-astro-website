// Supabase Edge Function: ai-breakdown
// Desglose de guión, como en Maestro: del texto del guión saca escenas, todo lo que hay
// que conseguir, la lista de planos y una propuesta de jornadas de rodaje.
//
// Pedido de Sebastián (26 ago 2026): "plan de rodaje tiene que poder ser creado en base
// al guion. Y del guion sacamos un desglose con todas las cosas necesarias vía IA".
//
// Devuelve { sinopsis, escenas[], necesidades{categoria:[]}, jornadas[], avisos[] } y lo
// guarda en projects.breakdown con su fecha. Es una FOTO: no se actualiza sola.
//
// Modelo: claude-sonnet-5 — un desglose es razonamiento sobre un texto largo, no una
// plantilla, y haiku se comía escenas en las pruebas de guiones con encabezados sucios.
//
// Deploy:  supabase functions deploy ai-breakdown --no-verify-jwt
// Secret:  ANTHROPIC_API_KEY (ya seteado)

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
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

/* El guión entero puede ser largo. Se recorta con un tope generoso y se AVISA si se
   recortó, en vez de desglosar media película en silencio. */
const TOPE = 60000;

/* ── EL ESQUEMA DE LA PRIMERA PASADA ──
   Ya no es un texto de ejemplo pegado al final del prompt: es un JSON Schema que la API
   HACE CUMPLIR (`output_config.format`). "Respondé solo con JSON" funciona casi siempre, y
   el casi es el problema — un "Acá va el desglose:" adelante rompe el parseo y se cae el
   desglose entero.
   (Sebastián, 26 ago 2026: "que sea el desglose con IA siempre, que sale muy bien".) */
const ESQUEMA = {
  type: "object",
  properties: {
    sinopsis: { type: "string", description: "Dos o tres frases de qué es esto." },
    duracion_estimada_s: { type: "integer" },
    escenas: {
      type: "array",
      items: {
        type: "object",
        properties: {
          n: { type: "integer" },
          titulo: { type: "string", description: "Corto, como se nombra una escena en una lista: «Oficina — llegada»." },
          int_ext: { type: "string", enum: ["INT", "EXT", "INT/EXT", ""] },
          dia_noche: { type: "string", description: "DÍA, NOCHE, AMANECER, ATARDECER. Vacío si el guion no lo dice." },
          locacion: { type: "string", description: "Vacío si el guion no la define — vacío es una respuesta correcta." },
          resumen: { type: "string", description: "Qué pasa, en una o dos frases." },
          duracion_s: { type: "integer" },
        },
        required: ["n", "titulo", "int_ext", "dia_noche", "locacion", "resumen", "duracion_s"],
        additionalProperties: false,
      },
    },
    jornadas: {
      type: "array",
      items: {
        type: "object",
        properties: {
          dia: { type: "integer" },
          locacion: { type: "string" },
          escenas: { type: "array", items: { type: "integer" } },
          horas_estimadas: { type: "integer", description: "Incluye montaje y desmontaje, no solo lo que se filma." },
          notas: { type: "string" },
        },
        required: ["dia", "locacion", "escenas", "horas_estimadas", "notas"],
        additionalProperties: false,
      },
    },
    avisos: {
      type: "array",
      items: { type: "string" },
      description: "Lo que el guion no dice y hay que decidir, y lo que pide y no está presupuestado.",
    },
  },
  required: ["sinopsis", "duracion_estimada_s", "escenas", "jornadas", "avisos"],
  additionalProperties: false,
};

/* ── EL DESGLOSE VA EN DOS PASADAS ──
   La lista de planos es, sola, más de la mitad de lo que hay que escribir: cuatro campos
   por plano y varios planos por escena. Pedir todo junto hacía que la respuesta se pasara
   del límite y volviera cortada — desde afuera, "Edge Function returned a non-2xx status
   code".
   La salida fácil era pedir menos. Sebastián la descartó: "no achiques la cantidad de
   cosas que puede pedir, es más importante". Tiene razón — los planos son la mitad del
   valor del desglose.
   Así que se pide lo MISMO, en dos veces: primero las escenas con todo lo que hay que
   conseguir y las jornadas; después los planos, en lotes de escenas y EN PARALELO. Cada
   respuesta entra holgada y el reloj lo marca el lote más lento, no la suma.
   (26 ago 2026.) */
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const auth = req.headers.get("Authorization") ?? "";
    const supabase = createClient(SB_URL, SB_ANON, { global: { headers: { Authorization: auth } } });
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return json({ error: "unauthorized" }, 401);

    const { project_id, script = "", lang = "es" } = await req.json();
    const guion = String(script || "").trim();
    /* Con 200 y {error}: un 4xx llega al navegador como "non-2xx status code" y el
       mensaje que explica qué falta se pierde por el camino. */
    if (guion.length < 80) return json({ error: "El guión está vacío o es muy corto para desglosar." });

    const recortado = guion.length > TOPE;
    const texto = recortado ? guion.slice(0, TOPE) : guion;

    /* Contexto real del proyecto: si ya hay presupuesto, el desglose puede señalar lo
       que el guión pide y NO está vendido — que es la plata que se escapa. */
    let contexto = "";
    if (project_id) {
      const admin = createClient(SB_URL, SERVICE);
      const { data: p } = await admin.from("projects")
        .select("title, items, shoot_start, shoot_end, location").eq("id", project_id).maybeSingle();
      if (p) {
        const pos = (Array.isArray(p.items) ? p.items : []).map((i: any) => `${i.name} (${i.qty} ${i.unit})`).join(", ");
        contexto = `\nCONTEXTO DEL PROYECTO\nTítulo: ${p.title || "—"}\n`
          + `Días de rodaje previstos: ${p.shoot_start || "sin definir"}${p.shoot_end ? " → " + p.shoot_end : ""}\n`
          + `Locación prevista: ${p.location || "sin definir"}\n`
          + `Ya está PRESUPUESTADO: ${pos || "(nada)"}\n`;
      }
    }

    const idioma = lang === "de" ? "alemán" : lang === "en" ? "inglés" : "español";
    const prompt = `Sos jefe de producción de Viven, una productora de video en Zúrich. Te dan un guión y hacés el DESGLOSE, como se hace antes de un rodaje.

Desglosá escena por escena y sacá TODO lo que hay que conseguir. Después proponé cómo agrupar las escenas en jornadas.

${REGLA_JORNADA}

Reglas, y son las que separan un desglose útil de una lista bonita:
- No inventes lo que el guión no dice. Si algo no está definido —una locación, un personaje, si es día o noche— ponelo en "avisos" como decisión pendiente en vez de rellenarlo.
- Las jornadas se agrupan por LOCACIÓN primero (mover un equipo cuesta medio día) y después por luz: todo lo de día junto, todo lo de noche junto.
- "horas_estimadas" incluye montaje y desmontaje, no solo lo que se filma, y NO incluye el
  almuerzo (que es una hora aparte y va siempre).
- Si el guión pide algo que NO está en lo presupuestado, decilo en "avisos" con esa palabra exacta: "no está presupuestado". Es la plata que se escapa entre lo que se vendió y lo que hay que filmar.
- Sé conciso: cada campo, lo mínimo que sirva para producir. Esto se lee en un set, no se estudia.
- Textos en ${idioma}.
${contexto}
Las cosas que hay que conseguir NO van acá: se sacan escena por escena en un segundo paso.
Acá van las escenas, cómo se agrupan en jornadas, y lo que falta decidir.

GUIÓN:
${texto}`;

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 12000,
        /* La forma la garantiza la API. `effort: medium` alcanza: partir un guion en
           escenas es lectura, no razonamiento. */
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
    /* No alcanza con content[0].text: claude-sonnet-5 puede devolver más de un bloque y
       el primero no siempre es el texto (con razonamiento activado, por ejemplo). Con
       content[0] la respuesta llegaba vacía y el error decía "la IA no devolvió un
       desglose válido" cuando en realidad había devuelto uno perfecto en el bloque
       siguiente. Se juntan TODOS los bloques de texto. */
    let text = (Array.isArray(data.content) ? data.content : [])
      .filter((c: any) => c && c.type === "text" && typeof c.text === "string")
      .map((c: any) => c.text).join("\n").trim();
    /* Sin limpiar backticks ni buscar la primera llave: con el esquema aplicado por la
       API, la respuesta ES el JSON. Esa limpieza existía para tapar el "Acá va:". */
    let parsed: any = null;
    try { parsed = JSON.parse(text); } catch { /* abajo */ }
    if (!parsed || !Array.isArray(parsed.escenas)) {
      /* La causa casi siempre es que la respuesta se cortó por max_tokens: un desglose
         con shot list es largo y el JSON queda sin cerrar. Decirlo con el motivo real
         (y un pedazo de lo que llegó) evita el "probá de nuevo" a ciegas. */
      const corte = data.stop_reason === "max_tokens";
      console.error("PARSE_ERROR", data.stop_reason, text.slice(0, 400));
      return json({
        error: corte
          ? "El desglose salió más largo de lo que entra en una respuesta, incluso partido en dos. Probá con menos guión."
          : "La IA no devolvió un desglose válido. Probá de nuevo.",
        stop_reason: data.stop_reason ?? null,
        bloques: (Array.isArray(data.content) ? data.content : []).map((c: any) => c?.type),
        muestra: text.slice(0, 300),
      });
    }

    /* ══ SEGUNDA PASADA: LOS ELEMENTOS DE CADA ESCENA ══
       Antes cada escena traía listas de palabras sueltas: props ["laptop","audífono"].
       Eso alcanza para contar, no para producir: no dice cuántos, de quién, dónde entra
       ni quién lo consigue, y en el set esas cuatro preguntas son las únicas que importan.
       Ahora cada elemento es una ficha. Es el modelo de Maestro, que Sebastián ya resolvió
       ahí: "todo dentro de cada escena; cada ítem tiene su propia info dentro, para saber
       qué, quién, dónde, cuánto".

       Tres cosas se traen de Maestro porque son las que hacen que sirva:
       · EVIDENCIA OBLIGATORIA — la frase exacta del guion que justifica el elemento. Si no
         se puede copiar, no se propone. Es lo que corta las invenciones.
       · UN DEPARTAMENTO QUE LA ESCENA NO NECESITA SE DEJA VACÍO. Tener diez categorías no
         es una lista para completar; cada propuesta de más le cuesta una decisión a quien
         la revisa.
       · LA FORMA LA GARANTIZA LA API (output_config.format), no el prompt. "Respondé solo
         con JSON" funciona casi siempre, y el casi es el problema: un "Acá va:" adelante
         rompe el parseo y la escena se cae entera.

       Va en lotes y en paralelo: cada respuesta entra holgada y el reloj lo marca el lote
       más lento, no la suma. */
    const CATS = ["personajes", "props", "vestuario", "arte", "maquillaje", "sonido",
                  "equipo_especial", "locacion", "permisos", "post"] as const;

    const esquemaElementos = {
      type: "object",
      properties: {
        escenas: {
          type: "array",
          items: {
            type: "object",
            properties: {
              n: { type: "integer", description: "El número de la escena, tal cual se lo dieron." },
              elementos: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    tipo: { type: "string", enum: [...CATS] },
                    que: { type: "string", description: "Sustantivo concreto y corto, como lo escribiría el jefe de ese departamento en su lista. «Cuaderno de reservas», no «el cuaderno lleno de tachones que ella hojea»." },
                    cantidad: { type: "integer", description: "Cuántos hacen falta. 1 si no se dice." },
                    quien: { type: "string", description: "De quién es o quién lo usa: un nombre o un rol («la dueña de la hostería», «el técnico»). NUNCA un pronombre — «ella» no le dice a nadie qué buscar. Cadena vacía si no aplica." },
                    donde: { type: "string", description: "Dónde entra en cuadro o dónde tiene que estar. Cadena vacía si no se dice." },
                    /* Lista CERRADA. Estaba libre y devolvía cosas como "ella" — que en una
                       hoja de rodaje no le dice a nadie qué tiene que hacer. Quién lo trae
                       es un ÁREA, siempre; de quién es la cosa va en "quien". */
                    quien_lo_consigue: {
                      type: "string",
                      enum: ["Arte", "Vestuario", "Maquillaje", "Sonido", "Cámara", "Luces", "Producción", "Post", "El cliente"],
                      description: "El área que tiene que conseguirlo o traerlo. «El cliente» cuando hay que pedírselo a él: un acceso, una persona suya, su producto.",
                    },
                    evidencia: { type: "string", description: "La frase EXACTA del guion que lo justifica, copiada tal cual." },
                    notas: { type: "string", description: "Solo si hace falta algo que el resto no dice. Cadena vacía si no." },
                  },
                  required: ["tipo", "que", "cantidad", "quien", "donde", "quien_lo_consigue", "evidencia", "notas"],
                  additionalProperties: false,
                },
              },
              planos: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    n: { type: "string", description: "El número de la escena más una letra: 3A, 3B." },
                    tipo: { type: "string", description: "Plano general, plano medio, primer plano, detalle…" },
                    movimiento: { type: "string", description: "Fijo, paneo, travelling, mano…" },
                    descripcion: { type: "string", description: "Qué pasa en el plano." },
                    duracion_s: { type: "integer" },
                  },
                  required: ["n", "tipo", "movimiento", "descripcion", "duracion_s"],
                  additionalProperties: false,
                },
              },
            },
            required: ["n", "elementos", "planos"],
            additionalProperties: false,
          },
        },
      },
      required: ["escenas"],
      additionalProperties: false,
    };

    const escenasBase = (parsed.escenas as Array<Record<string, unknown>>).slice(0, 120);
    if (escenasBase.length) {
      const LOTE = 5;
      const lotes: Array<Array<Record<string, unknown>>> = [];
      for (let i = 0; i < escenasBase.length; i += LOTE) lotes.push(escenasBase.slice(i, i + LOTE));

      const pedirDetalle = async (lote: Array<Record<string, unknown>>) => {
        const detalle = lote.map((e) =>
          `ESCENA ${e.n} — ${e.titulo}${e.int_ext ? " (" + e.int_ext + "/" + e.dia_noche + ")" : ""}` +
          `${e.locacion ? "\nLocación: " + e.locacion : ""}` +
          `\n${e.resumen || ""}`).join("\n\n");

        const pp = `Sos jefe de producción de VIVEN, una productora de video en Zúrich. Para cada escena,
sacá TODO lo que hay que conseguir y la lista de planos.

${detalle}

EL GUION COMPLETO, por si hace falta el contexto:
${guion.slice(0, 6000)}

REGLAS, en orden de importancia:

1. Solo lo que la escena dice. Si algo no aparece ahí, no existe para vos. Cada elemento va
   con la frase EXACTA de la escena que lo justifica, copiada tal cual en "evidencia". Si no
   podés copiar la frase, no lo pongas.

2. UN DEPARTAMENTO QUE LA ESCENA NO NECESITA SE DEJA VACÍO. La mayoría de las escenas no
   tienen maquillaje especial, ni permisos, ni equipo raro. Tener diez categorías no es una
   lista para completar: es un vocabulario para nombrar lo que de verdad está ahí. Cada
   elemento de más le cuesta una decisión a quien lo revisa. Si dudás, no.

3. No inventes cantidades, marcas, colores ni épocas que la escena no diga. "Una lámpara"
   es un elemento; "lámpara años 70 con pantalla beige" es una invención.

4. "que" se nombra como lo escribiría el jefe de ese departamento en su lista: sustantivo
   concreto y corto, no la frase entera.

5. "quien" es de quién es o quién lo usa —solo si la escena lo dice—. "donde" es dónde entra
   en cuadro. Los dos van vacíos si no se dicen: vacío es una respuesta correcta.

6. "quien_lo_consigue" es el ÁREA que lo trae, de la lista cerrada. «El cliente» cuando hay
   que pedírselo a él: un acceso, una persona suya, su producto. Nunca una persona suelta.
   Si algo lo trae la persona que aparece en cámara, eso es «El cliente» (o «Producción» si
   lo conseguimos nosotros), y de quién es va en "quien".

7. NADA DE PRONOMBRES. "quien" va con un nombre o un rol —«la dueña de la hostería»,
   «el técnico de mantenimiento»—, nunca «ella» ni «él». La hoja se lee a las seis de la
   mañana, en el teléfono, por alguien que no leyó el guion: «ella» no le dice a nadie qué
   tiene que buscar ni a quién.

8. Si el mismo objeto aparece dos veces en la escena, es UN elemento con cantidad 2, no dos.

9. Los planos son los que usa un director: tipo, movimiento, qué pasa. Entre 2 y 6 por
   escena. Sin poesía.

10. Todo en ${idioma}.`;

        const r2 = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
          body: JSON.stringify({
            /* Opus para la extracción: un elemento mal leído manda a alguien a buscar algo
               que no existe, o deja afuera algo que sí hacía falta. Es la misma razón por
               la que Maestro usa Opus acá y Sonnet para conversar. */
            model: "claude-opus-5",
            max_tokens: 16000,
            /* La forma la garantiza la API, no el prompt. `effort: medium` alcanza: esto es
               extracción sobre un texto corto, no razonamiento. */
            output_config: { effort: "medium", format: { type: "json_schema", schema: esquemaElementos } },
            messages: [{ role: "user", content: pp }],
          }),
        });
        if (!r2.ok) { console.error("DETALLE_FAIL", r2.status, (await r2.text()).slice(0, 200)); return null; }
        const d2 = await r2.json();
        if (d2.stop_reason === "refusal") return null;
        let t2 = (Array.isArray(d2.content) ? d2.content : [])
          .filter((c: { type?: string; text?: string }) => c && c.type === "text" && typeof c.text === "string")
          .map((c: { text: string }) => c.text).join("").trim();
        try { return JSON.parse(t2); } catch { return null; }
      };

      const resultados = await Promise.all(lotes.map((l) => pedirDetalle(l).catch(() => null)));
      const porEscena: Record<string, Record<string, unknown>> = {};
      resultados.forEach((r3) => {
        const es = r3 && Array.isArray((r3 as { escenas?: unknown[] }).escenas) ? (r3 as { escenas: Array<Record<string, unknown>> }).escenas : [];
        es.forEach((e) => { porEscena[String(e.n)] = e; });
      });

      const txt = (x: unknown, n = 240) => String(x ?? "").trim().slice(0, n);
      escenasBase.forEach((e) => {
        const det = porEscena[String(e.n)];
        if (!det) return;
        /* La evidencia se verifica contra el texto de la escena. Si el modelo no pudo
           copiar una frase que esté de verdad ahí, ese elemento se cae: es la diferencia
           entre un desglose y una lista de cosas plausibles. */
        const suelo = (String(e.titulo || "") + " " + String(e.resumen || "") + " " + String(e.locacion || "")).toLowerCase();
        const enGuion = guion.toLowerCase();
        e.elementos = (Array.isArray(det.elementos) ? det.elementos as Array<Record<string, unknown>> : [])
          .slice(0, 30)
          .map((el) => ({
            tipo: txt(el.tipo, 24) || "props",
            que: txt(el.que, 120),
            cantidad: Number.isFinite(Number(el.cantidad)) && Number(el.cantidad) > 0 ? Math.round(Number(el.cantidad)) : 1,
            quien: txt(el.quien, 80),
            donde: txt(el.donde, 120),
            quien_lo_consigue: txt(el.quien_lo_consigue, 40),
            evidencia: txt(el.evidencia, 200),
            notas: txt(el.notas, 200),
          }))
          .filter((el) => {
            if (!el.que) return false;
            if (!el.evidencia) return false;
            const ev = el.evidencia.toLowerCase();
            return suelo.includes(ev) || enGuion.includes(ev);
          });
        e.planos = (Array.isArray(det.planos) ? det.planos as Array<Record<string, unknown>> : [])
          .slice(0, 40).map((s2, j) => ({
            n: txt(s2.n, 10) || (String(e.n) + String.fromCharCode(65 + j)),
            tipo: txt(s2.tipo, 60), movimiento: txt(s2.movimiento, 60),
            descripcion: txt(s2.descripcion, 240),
            duracion_s: Number.isFinite(Number(s2.duracion_s)) ? Number(s2.duracion_s) : 0,
          }));
      });

      /* Lo que quedó incompleto se dice, no se esconde: un desglose al que le faltan
         escenas y no lo avisa se lleva al set como si estuviera entero. */
      const sinDet = escenasBase.filter((e) => !(e.elementos as unknown[] || []).length && !(e.planos as unknown[] || []).length).length;
      if (sinDet) parsed.aviso_planos = sinDet + (sinDet === 1 ? " escena quedó sin detallar" : " escenas quedaron sin detallar");

      /* "Todo lo que hay que conseguir" se arma DESDE los elementos, no aparte: así el
         resumen y el detalle no pueden contradecirse. Cada línea dice de qué escenas sale. */
      const bolsa: Record<string, Record<string, { cantidad: number; escenas: number[]; quien: string; area: string }>> = {};
      escenasBase.forEach((e) => {
        (e.elementos as Array<Record<string, unknown>> || []).forEach((el) => {
          const cat = String(el.tipo);
          const clave = String(el.que).toLowerCase();
          bolsa[cat] = bolsa[cat] || {};
          const y = bolsa[cat][clave];
          if (y) { y.cantidad = Math.max(y.cantidad, Number(el.cantidad) || 1); y.escenas.push(Number(e.n)); }
          else bolsa[cat][clave] = { cantidad: Number(el.cantidad) || 1, escenas: [Number(e.n)],
                                     quien: String(el.quien || ""), area: String(el.quien_lo_consigue || "") };
        });
      });
      parsed.necesidades_detalle = Object.fromEntries(Object.keys(bolsa).map((cat) => [cat,
        Object.keys(bolsa[cat]).map((k) => ({
          que: k.charAt(0).toUpperCase() + k.slice(1),
          cantidad: bolsa[cat][k].cantidad,
          escenas: [...new Set(bolsa[cat][k].escenas)].sort((a, b) => a - b),
          quien: bolsa[cat][k].quien,
          area: bolsa[cat][k].area,
        }))]));
      /* El formato viejo se mantiene: lo leen la pantalla actual y el plan de rodaje. */
      parsed.necesidades = Object.fromEntries(Object.keys(bolsa).map((cat) => [cat,
        Object.keys(bolsa[cat]).map((k) => k.charAt(0).toUpperCase() + k.slice(1))]));
    }

    /* Sanear: los números que van a sumarse tienen que ser números, y las listas,
       listas. Un "duracion_s": "unos 12 segundos" rompe la suma en la pantalla. */
    const lista = (x: unknown) => Array.isArray(x) ? x.filter(Boolean).map(String) : [];
    const num = (x: unknown, d = 0) => Number.isFinite(Number(x)) ? Number(x) : d;
    parsed.escenas = parsed.escenas.slice(0, 120).map((e: any, i: number) => ({
      n: num(e.n, i + 1),
      titulo: String(e.titulo || "Escena " + (i + 1)).slice(0, 120),
      int_ext: String(e.int_ext || "").slice(0, 8),
      dia_noche: String(e.dia_noche || "").slice(0, 12),
      locacion: String(e.locacion || "").slice(0, 120),
      resumen: String(e.resumen || "").slice(0, 400),
      duracion_s: num(e.duracion_s),
      personajes: lista(e.personajes), props: lista(e.props), vestuario: lista(e.vestuario),
      arte: lista(e.arte), maquillaje: lista(e.maquillaje), sonido: lista(e.sonido),
      equipo_especial: lista(e.equipo_especial), post: lista(e.post),
      /* Los elementos con su ficha. Este saneo reconstruye cada escena campo por campo,
         así que lo que no se nombre acá se pierde — y perder los elementos dejaría el
         desglose otra vez en listas de palabras. */
      elementos: Array.isArray(e.elementos) ? e.elementos : [],
      planos: Array.isArray(e.planos) ? e.planos.slice(0, 40).map((s: any, j: number) => ({
        n: String(s.n || (num(e.n, i + 1) + String.fromCharCode(65 + j))),
        tipo: String(s.tipo || "").slice(0, 60),
        movimiento: String(s.movimiento || "").slice(0, 60),
        descripcion: String(s.descripcion || "").slice(0, 240),
        duracion_s: num(s.duracion_s),
      })) : [],
    }));
    const nec = parsed.necesidades && typeof parsed.necesidades === "object" ? parsed.necesidades : {};
    parsed.necesidades = Object.fromEntries(Object.keys(nec).map((k) => [k, lista((nec as any)[k])]));
    /* `necesidades_detalle` ya viene saneado de la segunda pasada y NO pasa por `lista()`:
       son fichas, no cadenas, y convertirlas las aplastaría a "[object Object]". */
    parsed.jornadas = Array.isArray(parsed.jornadas) ? parsed.jornadas.slice(0, 30).map((j: any, i: number) => ({
      dia: num(j.dia, i + 1),
      locacion: String(j.locacion || "").slice(0, 120),
      escenas: Array.isArray(j.escenas) ? j.escenas.map((x: any) => num(x)).filter(Boolean) : [],
      horas_estimadas: num(j.horas_estimadas),
      notas: String(j.notas || "").slice(0, 300),
    })) : [];
    parsed.avisos = lista(parsed.avisos).slice(0, 20);
    if (recortado) parsed.avisos.unshift(`El guión se recortó a ${TOPE.toLocaleString("de-CH")} caracteres para desglosarlo — lo que sigue después de ese punto NO está en este desglose.`);
    parsed.sinopsis = String(parsed.sinopsis || "").slice(0, 600);
    parsed.duracion_estimada_s = num(parsed.duracion_estimada_s);
    parsed.generado_at = new Date().toISOString();

    if (project_id) {
      const admin = createClient(SB_URL, SERVICE);
      const { error: uErr } = await admin.from("projects")
        .update({ script_text: guion, breakdown: parsed, breakdown_at: new Date().toISOString() })
        .eq("id", project_id);
      /* Si el guardado falla el desglose ya existe: se devuelve igual y se avisa, en vez
         de perder la corrida (que costó plata) por un error de escritura. */
      if (uErr) return json({ ok: true, breakdown: parsed, aviso_guardado: uErr.message, aviso_planos: parsed.aviso_planos ?? null });
    }
    return json({ ok: true, breakdown: parsed, aviso_planos: parsed.aviso_planos ?? null });
  } catch (e) {
    console.error("FUNCTION_ERROR", String(e));
    return json({ error: String(e) }, 500);
  }
});
