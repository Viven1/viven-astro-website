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

const ESQUEMA = `{
  "sinopsis": "dos o tres frases de qué es esto",
  "duracion_estimada_s": 90,
  "escenas": [{
    "n": 1,
    "titulo": "Oficina — llegada",
    "int_ext": "INT",
    "dia_noche": "DÍA",
    "locacion": "Oficina cliente, Zúrich",
    "resumen": "qué pasa",
    "duracion_s": 12,
    "personajes": ["Presentadora"],
    "props": ["laptop", "audífono"],
    "vestuario": ["business casual"],
    "arte": ["plantas"],
    "maquillaje": ["natural"],
    "sonido": ["lavalier x2"],
    "equipo_especial": ["Ronin"],
    "post": ["motion graphics del producto"],
    "planos": [{"n":"1A","tipo":"Plano medio","movimiento":"Fijo","descripcion":"Ella entra y saluda","duracion_s":4}]
  }],
  "necesidades": {
    "personajes": [], "locaciones": [], "props": [], "vestuario": [], "arte": [],
    "maquillaje": ["..."], "sonido": [], "equipo_especial": [], "post": [], "permisos": []
  },
  "jornadas": [{
    "dia": 1, "locacion": "Oficina cliente, Zúrich", "escenas": [1,3],
    "horas_estimadas": 6,
    "notas": "agrupadas por locación; la 3 comparte el mismo set"
  }],
  "avisos": ["lo que el guión no dice y hace falta decidir"]
}`;

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
const sinPlanos = (esquema: string) =>
  esquema.replace(/,?\s*"planos": \[\{[^\]]*\}\]/, "");

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

Reglas, y son las que separan un desglose útil de una lista bonita:
- No inventes lo que el guión no dice. Si algo no está definido —una locación, un personaje, si es día o noche— ponelo en "avisos" como decisión pendiente en vez de rellenarlo.
- Las jornadas se agrupan por LOCACIÓN primero (mover un equipo cuesta medio día) y después por luz: todo lo de día junto, todo lo de noche junto.
- "horas_estimadas" incluye montaje y desmontaje, no solo lo que se filma.
- Si el guión pide algo que NO está en lo presupuestado, decilo en "avisos" con esa palabra exacta: "no está presupuestado". Es la plata que se escapa entre lo que se vendió y lo que hay que filmar.
- Sé conciso: cada campo, lo mínimo que sirva para producir. Esto se lee en un set, no se estudia.
- Textos en ${idioma}.
${contexto}
Respondé SOLO con JSON válido, sin texto extra, con esta forma EXACTA:
${sinPlanos(ESQUEMA)}

GUIÓN:
${texto}`;

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 12000, messages: [{ role: "user", content: prompt }] }),
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
    text = text.replace(/^```(?:json)?/m, "").replace(/```\s*$/m, "").trim();
    const m = text.match(/\{[\s\S]*\}/);
    if (m) text = m[0];
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

    /* ── SEGUNDA PASADA: los planos ──
       Por lotes de escenas y en paralelo. Cada lote es una respuesta chica que entra
       holgada, y el reloj lo marca el lote más lento, no la suma de todos.
       Si un lote falla, esas escenas quedan sin planos y el resto del desglose sale
       igual: media lista de planos sirve, un desglose que no llega no sirve para nada. */
    const escenasBase = (parsed.escenas as Array<Record<string, unknown>>).slice(0, 120);
    if (escenasBase.length) {
      const LOTE = 6;
      const lotes: Array<Array<Record<string, unknown>>> = [];
      for (let i = 0; i < escenasBase.length; i += LOTE) lotes.push(escenasBase.slice(i, i + LOTE));

      const pedirPlanos = async (lote: Array<Record<string, unknown>>) => {
        const resumen = lote.map((e) => `Escena ${e.n} — ${e.titulo}${e.int_ext ? " (" + e.int_ext + "/" + e.dia_noche + ")" : ""}` +
          `${e.locacion ? " · " + e.locacion : ""}\n   ${e.resumen || ""}` +
          `${(e.personajes as string[] || []).length ? "\n   Quién: " + (e.personajes as string[]).join(", ") : ""}`).join("\n\n");
        const pp = `Sos director de fotografía de Viven. Para cada escena, la lista de planos que se rueda.

${resumen}

REGLAS:
- Los planos que usa un director: tipo de plano, movimiento, qué pasa. Sin poesía.
- Entre 2 y 6 planos por escena. Si una escena es un solo plano, uno.
- La numeración es la de la escena más una letra: 3A, 3B, 3C.
- Textos en ${idioma}.

Respondé SOLO con JSON válido, sin texto extra:
{"escenas":[{"n":${lote[0].n},"planos":[{"n":"${lote[0].n}A","tipo":"Plano medio","movimiento":"Fijo","descripcion":"qué pasa","duracion_s":4}]}]}`;

        const r2 = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
          body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 6000, messages: [{ role: "user", content: pp }] }),
        });
        if (!r2.ok) return null;
        const d2 = await r2.json();
        let t2 = (Array.isArray(d2.content) ? d2.content : [])
          .filter((c: { type?: string; text?: string }) => c && c.type === "text" && typeof c.text === "string")
          .map((c: { text: string }) => c.text).join("\n").trim();
        t2 = t2.replace(/^```(?:json)?/m, "").replace(/```\s*$/m, "").trim();
        const mm = t2.match(/\{[\s\S]*\}/); if (mm) t2 = mm[0];
        try { return JSON.parse(t2); } catch { return null; }
      };

      const resultados = await Promise.all(lotes.map((l) => pedirPlanos(l).catch(() => null)));
      const porEscena: Record<string, unknown[]> = {};
      resultados.forEach((r3) => {
        const es = r3 && Array.isArray((r3 as { escenas?: unknown[] }).escenas) ? (r3 as { escenas: Array<Record<string, unknown>> }).escenas : [];
        es.forEach((e) => { if (Array.isArray(e.planos)) porEscena[String(e.n)] = e.planos as unknown[]; });
      });
      escenasBase.forEach((e) => { if (porEscena[String(e.n)]) e.planos = porEscena[String(e.n)]; });
      /* Cuántas escenas quedaron sin planos: se dice, no se esconde. Un desglose al que le
         faltan planos y no lo avisa se lleva al set como si estuviera completo. */
      const sinPl = escenasBase.filter((e) => !Array.isArray(e.planos) || !(e.planos as unknown[]).length).length;
      if (sinPl) parsed.aviso_planos = sinPl + (sinPl === 1 ? " escena quedó sin planos" : " escenas quedaron sin planos");
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
