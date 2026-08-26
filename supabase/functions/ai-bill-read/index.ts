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

Respondé SOLO con JSON válido:
{"supplier":"...","vendor_ref":"...","bill_date":"2026-08-19","due_date":null,"currency":"CHF","net":950,"vat":0,"gross":950,"iban":null,"concepto":"qué se cobró, en pocas palabras","confianza":"alta","dudas":[]}`;

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 2000,
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
    text = text.replace(/^```(?:json)?/m, "").replace(/```\s*$/m, "").trim();
    const m = text.match(/\{[\s\S]*\}/);
    if (m) text = m[0];
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
