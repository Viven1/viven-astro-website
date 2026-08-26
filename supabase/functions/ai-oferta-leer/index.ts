// Supabase Edge Function: ai-oferta-leer
//
// Lee el PDF de una oferta o propuesta y saca lo que hace falta para arrancar el
// proyecto: cliente, título, monto y las posiciones. Sebastián, 26 ago 2026: "dejame
// subir pdf con oferta o propuesta para que agarre toda la info".
//
// Por qué importa: hasta ahora, un trabajo cerrado por email obligaba a tipear a mano el
// paquete entero. Y las posiciones no son decoración — son de donde salen el crew, los
// costos y el margen real del proyecto.
//
// NO guarda nada: devuelve lo leído para que se revise antes de crear. Un PDF mal leído
// que ya creó un proyecto es más trabajo que uno que no se leyó.
//
// Deploy: supabase functions deploy ai-oferta-leer --no-verify-jwt
// Secret: ANTHROPIC_API_KEY

import { createClient } from "jsr:@supabase/supabase-js@2";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const auth = req.headers.get("Authorization") ?? "";
    const supabase = createClient(SB_URL, SB_ANON, { global: { headers: { Authorization: auth } } });
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return json({ error: "unauthorized" }, 401);
    if (!ANTHROPIC_API_KEY) return json({ error: "Falta ANTHROPIC_API_KEY" }, 500);

    const { archivo_b64, mime } = await req.json().catch(() => ({}));
    if (!archivo_b64) return json({ error: "falta el archivo" }, 400);

    /* Claude lee PDFs como documento e imágenes como imagen: no es el mismo bloque.
       (Mismo patrón que ai-bill-read, que ya lo tenía resuelto.) */
    const tipo = String(mime || "application/pdf");
    const doc = /pdf/i.test(tipo)
      ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: String(archivo_b64) } }
      : { type: "image", source: { type: "base64", media_type: tipo.replace("image/heic", "image/jpeg"), data: String(archivo_b64) } };

    const prompt = `Esta es una OFERTA o PROPUESTA que VIVEN AG (productora de video, Zúrich) le mandó a un cliente, y que el cliente aceptó.

Sacá lo necesario para abrir el proyecto. Reglas:
- Los importes son NÚMEROS, sin moneda ni separadores de miles. Coma o punto decimal → punto.
- "cliente" es la EMPRESA que recibe la oferta, no VIVEN.
- "titulo" es el nombre del proyecto tal como aparece; si no hay, armá uno corto con el cliente y el tipo de video.
- "total" es el importe acordado SIN IVA. Si la oferta tiene varios paquetes, tomá el que esté marcado como elegido o recomendado, y decilo en "dudas".
- En "items" va UNA línea por posición del presupuesto, con su cantidad, unidad y precio unitario. Es lo que después arma el crew y los costos: si el PDF las tiene, no las resumas.
- "phase" es la fase de esa línea si el PDF la indica (Pre-producción, Producción, Post-producción); si no, null.
- Lo que no puedas leer con seguridad va en null. NO adivines: un número inventado acá se convierte en el presupuesto del proyecto.
- En "confianza" poné "alta", "media" o "baja", y en "dudas" lo que no pudiste leer bien o lo que tuviste que decidir.

Respondé SOLO con JSON válido:
{"cliente":"Sonova AG","contacto":"Kaan Bulut","email":null,"titulo":"New Sound Demo 2026","fecha":"2026-07-31","moneda":"CHF","total":22358,"items":[{"phase":"Producción","name":"Jornada de rodaje","qty":2,"unit":"Tag","price":3800}],"confianza":"alta","dudas":[]}`;

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 4000, messages: [{ role: "user", content: [doc, { type: "text", text: prompt }] }] }),
    });
    if (!res.ok) {
      const t = await res.text();
      console.error("ANTHROPIC_ERROR", res.status, t);
      return json({ error: `Anthropic ${res.status}: ${t.slice(0, 300)}` }, 502);
    }
    const data = await res.json();
    let text = (Array.isArray(data.content) ? data.content : [])
      .filter((c: any) => c?.type === "text" && typeof c.text === "string")
      .map((c: any) => c.text).join("\n").trim();
    text = text.replace(/^```(?:json)?/m, "").replace(/```\s*$/m, "").trim();
    const m = text.match(/\{[\s\S]*\}/);
    if (m) text = m[0];
    let p: any = null;
    try { p = JSON.parse(text); } catch { /* abajo */ }
    if (!p) {
      console.error("PARSE_ERROR", data.stop_reason, text.slice(0, 300));
      return json({ error: "No pude leer el PDF. Probá con otro archivo o cargalo a mano.", muestra: text.slice(0, 200) }, 502);
    }

    /* Sanear: lo que va a sumarse tiene que ser número. Un precio "desde 3800" rompe el
       total del proyecto, y ese total es el que después se compara contra los costos. */
    const num = (x: unknown) => Number.isFinite(Number(x)) ? Number(x) : 0;
    const items = Array.isArray(p.items) ? p.items.slice(0, 60).map((it: any) => ({
      phase: it.phase ? String(it.phase).slice(0, 60) : null,
      name: String(it.name || "").slice(0, 160),
      qty: num(it.qty) || 1,
      unit: String(it.unit || "").slice(0, 24),
      price: num(it.price),
      cost: 0,
    })).filter((it: any) => it.name) : [];

    /* Si el total no vino pero las líneas sí, se calcula — y se avisa que salió de la
       suma y no del papel. */
    let total = num(p.total);
    const suma = items.reduce((a: number, it: any) => a + it.qty * it.price, 0);
    const dudas: string[] = Array.isArray(p.dudas) ? p.dudas.filter(Boolean).map(String) : [];
    if (!total && suma) { total = suma; dudas.unshift("El total no estaba claro en el PDF: es la suma de las posiciones."); }
    else if (total && suma && Math.abs(total - suma) / Math.max(total, suma) > 0.02) {
      dudas.unshift(`El total del PDF (${total}) no coincide con la suma de las posiciones (${Math.round(suma)}). Revisá cuál vale.`);
    }

    return json({
      ok: true,
      cliente: p.cliente ? String(p.cliente).slice(0, 160) : null,
      contacto: p.contacto ? String(p.contacto).slice(0, 120) : null,
      email: p.email ? String(p.email).toLowerCase().slice(0, 160) : null,
      titulo: p.titulo ? String(p.titulo).slice(0, 180) : null,
      fecha: p.fecha ? String(p.fecha).slice(0, 10) : null,
      moneda: p.moneda ? String(p.moneda).slice(0, 8) : "CHF",
      total, items, confianza: p.confianza || "media", dudas,
    });
  } catch (e) {
    console.error("FUNCTION_ERROR", String(e));
    return json({ error: String(e) }, 500);
  }
});
