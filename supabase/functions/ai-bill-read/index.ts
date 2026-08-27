// Supabase Edge Function: ai-bill-read
// Lee una factura de proveedor (PDF o foto) y saca proveedor, número, fecha e importes.
// Es lo que convierte "subí el PDF" en una línea de costo con números de verdad.
//
// Deploy: supabase functions deploy ai-bill-read --no-verify-jwt
// Secret: ANTHROPIC_API_KEY

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

const b64 = (buf: ArrayBuffer) => {
  /* btoa() sobre una cadena de 5 MB revienta el stack si se arma con spread. De a
     pedazos no. */
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(s);
};

/* La forma la garantiza la API (`output_config.format`), no el prompt. En una factura esto
   pesa más que en cualquier otro lado: estos números terminan en la contabilidad, y un
   parseo que falla a mitad deja media factura cargada sin que nadie lo note.
   `null` está permitido en casi todo a propósito — "no lo pude leer" tiene que poder
   decirse. Un número inventado en una factura es peor que un campo vacío.
   (Sebastián, 26 ago 2026: "que sea el desglose con IA siempre, que sale muy bien".) */
const ESQUEMA = {
  type: "object",
  properties: {
    supplier: { type: ["string", "null"], description: "Quien COBRA, no VIVEN. Si es una persona, su nombre completo." },
    vendor_ref: { type: ["string", "null"], description: "El número de factura del proveedor, tal cual aparece." },
    bill_date: { type: ["string", "null"], description: "AAAA-MM-DD." },
    due_date: { type: ["string", "null"], description: "AAAA-MM-DD, o null si no hay vencimiento." },
    currency: { type: ["string", "null"] },
    net: { type: ["number", "null"], description: "Número puro, sin moneda ni separadores de miles." },
    vat: { type: ["number", "null"], description: "0 si la factura no dice IVA — muchos freelances suizos no facturan IVA." },
    gross: { type: ["number", "null"] },
    iban: { type: ["string", "null"] },
    concepto: { type: ["string", "null"], description: "Qué se cobró, en pocas palabras." },
    confianza: { type: "string", enum: ["alta", "media", "baja"] },
    dudas: { type: "array", items: { type: "string" }, description: "Lo que no se pudo leer bien." },
  },
  required: ["supplier", "vendor_ref", "bill_date", "due_date", "currency", "net", "vat", "gross", "iban", "concepto", "confianza", "dudas"],
  additionalProperties: false,
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const auth = req.headers.get("Authorization") ?? "";
    const supabase = createClient(SB_URL, SB_ANON, { global: { headers: { Authorization: auth } } });
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return json({ error: "unauthorized" }, 401);

    const { bill_id } = await req.json();
    if (!bill_id) return json({ error: "falta bill_id" }, 400);

    const admin = createClient(SB_URL, SERVICE);
    const { data: bill, error: bErr } = await admin.from("project_bills").select("*").eq("id", bill_id).maybeSingle();
    if (bErr || !bill) return json({ error: "factura no encontrada" }, 404);

    const { data: file, error: fErr } = await admin.storage.from("project-bills").download(bill.file_path);
    if (fErr || !file) return json({ error: "no se pudo bajar el archivo: " + (fErr?.message ?? "") }, 500);

    const buf = await file.arrayBuffer();
    const mime = bill.mime || file.type || "application/pdf";
    const esPdf = /pdf/i.test(mime);
    /* Claude lee PDFs como documento e imágenes como imagen: no es el mismo bloque. */
    const doc = esPdf
      ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: b64(buf) } }
      : { type: "image", source: { type: "base64", media_type: mime.replace("image/heic", "image/jpeg"), data: b64(buf) } };

    const prompt = `Esta es una factura que le mandaron a VIVEN AG (productora de video, Zúrich). Suele ser de un freelance del crew (cámara, sonido, edición) o de un alquiler de equipo.

Sacá los datos. Reglas:
- Los importes son NÚMEROS, sin moneda ni separadores de miles. Coma o punto decimal → punto.
- Si la factura no dice IVA, "vat" va en 0 y "net" igual a "gross". Muchos freelances suizos no facturan IVA.
- "supplier" es quien COBRA (no VIVEN). Si es una persona, su nombre completo.
- "vendor_ref" es el número de factura del proveedor, tal cual aparece.
- Las fechas en formato YYYY-MM-DD. Si no hay vencimiento, dejá due_date en null.
- Lo que no puedas leer con seguridad, va en null. NO adivines: un número inventado en una factura es peor que un campo vacío.
- En "confianza" poné "alta", "media" o "baja" según lo legible que esté, y en "dudas" lo que no pudiste leer bien.

Lo que no puedas leer con seguridad va en null.`;

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 2000,
        output_config: { format: { type: "json_schema", schema: ESQUEMA } },
        messages: [{ role: "user", content: [doc, { type: "text", text: prompt }] }],
      }),
    });
    if (!res.ok) {
      const t = await res.text();
      console.error("ANTHROPIC_ERROR", res.status, t);
      return json({ error: `Anthropic ${res.status}: ${t.slice(0, 300)}` }, 502);
    }
    const data = await res.json();
    /* Todos los bloques de texto, no content[0]: sonnet-5 puede devolver más de uno y
       con content[0] la lectura llegaba vacía (mismo tropiezo que en ai-breakdown). */
    let text = (Array.isArray(data.content) ? data.content : [])
      .filter((c: any) => c?.type === "text" && typeof c.text === "string")
      .map((c: any) => c.text).join("\n").trim();
    /* Sin destripar la respuesta: el esquema lo aplica la API. */
    let p: any = null;
    try { p = JSON.parse(text); } catch { /* abajo */ }
    if (!p) {
      console.error("PARSE_ERROR", data.stop_reason, text.slice(0, 300));
      return json({ error: "No se pudo leer la factura. Cargá los datos a mano.", stop_reason: data.stop_reason ?? null }, 502);
    }

    const num = (x: unknown) => (x === null || x === undefined || x === "" || !Number.isFinite(Number(x))) ? null : Number(x);
    const fecha = (x: unknown) => (typeof x === "string" && /^\d{4}-\d{2}-\d{2}$/.test(x)) ? x : null;
    const gross = num(p.gross), net = num(p.net), vat = num(p.vat);
    const patch: Record<string, unknown> = {
      supplier: p.supplier ? String(p.supplier).slice(0, 160) : null,
      vendor_ref: p.vendor_ref ? String(p.vendor_ref).slice(0, 80) : null,
      bill_date: fecha(p.bill_date),
      due_date: fecha(p.due_date),
      currency: (p.currency ? String(p.currency) : "CHF").slice(0, 3).toUpperCase(),
      net: net ?? (gross != null && vat != null ? gross - vat : gross),
      vat: vat ?? 0,
      gross: gross ?? (net != null ? net + (vat ?? 0) : null),
      iban: p.iban ? String(p.iban).replace(/\s+/g, "").slice(0, 40) : null,
      extracted: p,
      estado: "leida",
    };
    const { error: uErr } = await admin.from("project_bills").update(patch).eq("id", bill_id);
    if (uErr) return json({ ok: true, leido: patch, aviso_guardado: uErr.message });
    return json({ ok: true, leido: patch });
  } catch (e) {
    console.error("FUNCTION_ERROR", String(e));
    return json({ error: String(e) }, 500);
  }
});
