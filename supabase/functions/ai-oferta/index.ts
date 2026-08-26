// Supabase Edge Function: ai-oferta
// Del playbook a una oferta. Sebastián, 26 ago 2026: "una vez llenado, podemos tocar
// crear oferta o propuesta y la hace automáticamente".
//
// Lo importante no es que escriba lindo: es que NO invente precios. La IA recibe las
// ofertas que VIVEN ya ganó como referencia de cómo cobramos, y se le pide explícitamente
// que use esas tarifas. Una oferta con precios inventados se manda una vez y se pierde
// el cliente; peor todavía, se gana al precio equivocado.
//
// La oferta entra SIEMPRE como borrador (status 'draft'). Nada se manda solo.
//
// Deploy:  supabase functions deploy ai-oferta --no-verify-jwt
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

const ESQUEMA = `{
  "title": "Sonova — video de producto New Sound (3 piezas)",
  "items": [
    {"phase":"Pre-producción","name":"Concepto y guión","qty":1,"unit":"pauschal","price":1800,"cost":0},
    {"phase":"Producción","name":"Jornada de rodaje con equipo","qty":2,"unit":"Tag","price":3800,"cost":2400},
    {"phase":"Post-producción","name":"Montaje y color, versión principal","qty":1,"unit":"pauschal","price":2600,"cost":900}
  ],
  "notes": "Supuestos y lo que NO está incluido, en frases cortas.",
  "avisos": ["lo que hubo que suponer porque el playbook no lo decía"]
}`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const auth = req.headers.get("Authorization") ?? "";
    const supabase = createClient(SB_URL, SB_ANON, { global: { headers: { Authorization: auth } } });
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return json({ error: "unauthorized" }, 401);
    if (!ANTHROPIC_API_KEY) return json({ error: "Falta ANTHROPIC_API_KEY" }, 500);

    const { lead_id, respuestas } = await req.json().catch(() => ({}));
    if (!lead_id) return json({ error: "falta lead_id" }, 400);
    if (!Array.isArray(respuestas) || !respuestas.length) {
      return json({ error: "el playbook está vacío — contestá al menos lo esencial antes de pedir la oferta" }, 400);
    }

    const admin = createClient(SB_URL, SERVICE);
    const { data: lead } = await admin.from("leads").select("*").eq("id", String(lead_id)).maybeSingle();
    if (!lead) return json({ error: "no encontré esa persona" }, 404);

    /* La empresa, si la hay: el nombre que va en la oferta sale de acá antes que del
       texto que la persona escribió en un formulario. */
    const dom = (lead.company_domain || String(lead.email || "").split("@")[1] || "").toLowerCase();
    const { data: emp } = dom
      ? await admin.from("companies").select("name,industry,city,website").eq("domain", dom).maybeSingle()
      : { data: null };

    /* REFERENCIA DE PRECIOS: las ofertas ya GANADAS. Es lo único que evita que la IA
       invente tarifas. Si no hay ninguna ganada, se avisa en la respuesta y la oferta
       sale igual pero marcada como estimación. */
    const { data: ganadas } = await admin.from("offers")
      .select("title,items,currency")
      .eq("status", "won").eq("is_template", false)
      .order("updated_at", { ascending: false }).limit(8);
    const refs = (ganadas || []).filter((o) => Array.isArray(o.items) && o.items.length);
    const sinReferencia = !refs.length;

    const tarifario = refs.map((o) => "· " + o.title + "\n" +
      (o.items as any[]).slice(0, 25).map((it) =>
        `   [${it.phase || "—"}] ${it.name} — ${it.qty ?? 1} ${it.unit || ""} × ${it.price ?? 0} ${o.currency || "CHF"}`).join("\n")
    ).join("\n");

    const cliente = emp?.name || lead.company || (dom ? dom : (lead.name || "Cliente"));
    const idioma = ({ de: "alemán", es: "español", en: "inglés" } as Record<string, string>)[String(lead.lang || "en")] || "inglés";

    const prompt = `Sos el responsable de presupuestos de VIVEN AG, una productora de video B2B en Zúrich.
A partir de una llamada de descubrimiento ya hecha, armá el borrador de una oferta.

CLIENTE: ${cliente}${emp?.industry ? " · " + emp.industry : ""}${emp?.city ? " · " + emp.city : ""}
CONTACTO: ${lead.name || lead.email || ""}${lead.job_title ? " — " + lead.job_title : ""}

LO QUE DIJERON EN LA LLAMADA:
${respuestas.map((r: any) => `P: ${r.pregunta}\nR: ${r.respuesta}`).join("\n\n")}

${sinReferencia
  ? "NO hay ofertas ganadas anteriores para usar de referencia. Usá precios de mercado suizo para producción de video B2B y AVISALO en 'avisos'."
  : `CÓMO COBRA VIVEN — estas son ofertas REALES que ya ganamos. Usá ESTAS tarifas como base.
NO inventes precios nuevos si acá hay una línea equivalente:
${tarifario}`}

REGLAS:
- Moneda CHF. Precios sin IVA.
- Agrupá en fases: Pre-producción, Producción, Post-producción. Si la llamada nombró otras fases, usá las de ellos.
- Una línea por entregable real, no por tarea interna. Entre 4 y 12 líneas.
- 'price' es lo que se le cobra al cliente. 'cost' es lo que nos cuesta a nosotros (freelance, alquiler); si no lo sabés, poné 0.
- El título de la oferta en español, para uso interno. Los nombres de las líneas en ${idioma}, que es el idioma del cliente.
- Si el presupuesto que dijo el cliente no alcanza para lo que pidió, armá la oferta por lo que SÍ entra y decilo en 'avisos'. No recortes en silencio.
- Todo lo que tuviste que suponer va en 'avisos'. Un supuesto a la vista se corrige; uno escondido se factura mal.

Respondé SOLO con JSON válido, sin texto extra, con esta forma EXACTA:
${ESQUEMA}`;

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 8000, messages: [{ role: "user", content: prompt }] }),
    });
    if (!res.ok) {
      const t = await res.text();
      console.error("ANTHROPIC_ERROR", res.status, t);
      return json({ error: `Anthropic ${res.status}: ${t.slice(0, 300)}` }, 502);
    }
    const data = await res.json();
    /* Todos los bloques de texto, no content[0]: sonnet puede devolver más de uno y el
       primero no siempre es el texto. Ya nos pasó en ai-breakdown. */
    let text = (Array.isArray(data.content) ? data.content : [])
      .filter((c: any) => c && c.type === "text" && typeof c.text === "string")
      .map((c: any) => c.text).join("\n").trim();
    text = text.replace(/^```(?:json)?/m, "").replace(/```\s*$/m, "").trim();
    const m = text.match(/\{[\s\S]*\}/);
    if (m) text = m[0];
    let parsed: any = null;
    try { parsed = JSON.parse(text); } catch { /* abajo */ }
    if (!parsed || !Array.isArray(parsed.items) || !parsed.items.length) {
      console.error("PARSE_ERROR", data.stop_reason, text.slice(0, 400));
      return json({
        error: data.stop_reason === "max_tokens"
          ? "La oferta salió más larga de lo que entra en una respuesta. Probá con menos detalle en el playbook."
          : "La IA no devolvió una oferta válida. Probá de nuevo.",
        stop_reason: data.stop_reason ?? null,
        muestra: text.slice(0, 300),
      }, 502);
    }

    /* Sanear: lo que va a sumarse tiene que ser número. Un price "desde 3800" rompe el
       total de la oferta y el número equivocado es el que ve el cliente. */
    const num = (x: unknown, d = 0) => Number.isFinite(Number(x)) ? Number(x) : d;
    const items = parsed.items.slice(0, 40).map((it: any) => ({
      phase: String(it.phase || "").slice(0, 60),
      name: String(it.name || "").slice(0, 160),
      qty: num(it.qty, 1),
      unit: String(it.unit || "").slice(0, 24),
      price: num(it.price, 0),
      cost: num(it.cost, 0),
    })).filter((it: any) => it.name);
    if (!items.length) return json({ error: "la IA devolvió líneas vacías" }, 502);

    const avisos: string[] = Array.isArray(parsed.avisos) ? parsed.avisos.filter(Boolean).map(String).slice(0, 10) : [];
    if (sinReferencia) avisos.unshift("No hay ninguna oferta ganada en el sistema: los precios son de mercado, no los nuestros. Revisalos uno por uno.");

    const notas = [
      String(parsed.notes || "").trim(),
      avisos.length ? "\n⚠️ Supuestos de la IA:\n" + avisos.map((a) => "· " + a).join("\n") : "",
      "\n(Borrador generado desde el playbook el " + new Date().toISOString().slice(0, 10) + ". Revisar antes de mandar.)",
    ].filter(Boolean).join("\n");

    const { data: nueva, error: errIns } = await admin.from("offers").insert({
      title: String(parsed.title || `${cliente} — oferta`).slice(0, 200),
      client: cliente,
      lead_id: String(lead_id),
      currency: "CHF",
      status: "draft",
      items,
      notes: notas,
    }).select().single();
    if (errIns) return json({ error: "no se pudo guardar la oferta: " + errIns.message }, 500);

    return json({ ok: true, offer_id: nueva.id, title: nueva.title, lineas: items.length, avisos, sin_referencia: sinReferencia });
  } catch (e) {
    console.error("FUNCTION_ERROR", String(e));
    return json({ error: String(e) }, 500);
  }
});
