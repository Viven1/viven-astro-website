// Supabase Edge Function: bexio-bill
// Facturas de PROVEEDOR (el crew, alquileres) — la otra mitad de bexio-invoice, que
// hace las facturas a clientes. Sebastián, 26 ago 2026: "ideal sería poder subir
// facturas de la crew al dashboard para enviar a bexio y saber el margen real".
//
// Modos:
//   {probe:true}                → qué endpoints de compra contesta el token que tenemos
//   {bill_id, dry_run?:true}    → arma la factura de proveedor y la manda a bexio
//
// Igual que con las facturas a clientes: SIEMPRE borrador. Nada se contabiliza solo.
//
// Deploy: supabase functions deploy bexio-bill --no-verify-jwt
// Secret: BEXIO_API_TOKEN (ya seteado)

import { createClient } from "jsr:@supabase/supabase-js@2";

const BEXIO = Deno.env.get("BEXIO_API_TOKEN")!;
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

/* Cuenta contable donde caen los costos de producción. 4400 "Aufwand für Drittleistungen"
   es donde ya están las facturas de crew que se cargan a mano; se puede cambiar desde
   bexio sin tocar esto porque la factura entra en BORRADOR y se revisa igual. */
const BOOKING_ACCOUNT = Number(Deno.env.get("BEXIO_BOOKING_ACCOUNT") ?? "0") || 219;

async function bx(path: string, init?: RequestInit) {
  const url = /^\d\.\d\//.test(path) ? `https://api.bexio.com/${path}` : `https://api.bexio.com/2.0/${path}`;
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${BEXIO}`, Accept: "application/json", "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const txt = await res.text();
  let body: unknown = txt;
  try { body = JSON.parse(txt); } catch { /* bexio a veces devuelve texto plano */ }
  return { ok: res.ok, status: res.status, body };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const auth = req.headers.get("Authorization") ?? "";
    const supabase = createClient(SB_URL, SB_ANON, { global: { headers: { Authorization: auth } } });
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return json({ error: "unauthorized" }, 401);
    if (!BEXIO) return json({ error: "Falta BEXIO_API_TOKEN" }, 500);

    const body = await req.json().catch(() => ({}));

    /* PROBE: antes de prometer nada, ver qué contesta el token. La API de compras de
       bexio es v4 y su scope es distinto del de ventas — puede estar fuera del token. */
    if (body.probe) {
      const pruebas: Record<string, unknown> = {};
      for (const p of ["4.0/purchase/bills?limit=1", "3.0/accounts?limit=1", "2.0/contact?limit=1",
                       "2.0/currencies", "3.0/taxes?limit=5"]) {
        const r = await bx(p);
        pruebas[p] = { status: r.status, ok: r.ok,
          muestra: r.ok ? JSON.stringify(r.body).slice(0, 220) : String(JSON.stringify(r.body)).slice(0, 220) };
      }
      return json({ ok: true, pruebas });
    }

    /* Ver una factura de proveedor REAL entera: la forma que hay que mandar se copia de
       una que bexio ya aceptó, no de la documentación. Mismo método que se usó para las
       facturas a clientes (se copió la RE-01121). */
    if (body.muestra) {
      const lista = await bx("4.0/purchase/bills?limit=3");
      const arr = (lista.body as any)?.data ?? [];
      if (!arr.length) return json({ ok: true, aviso: "no hay ninguna factura de proveedor para mirar" });
      const una = await bx(`4.0/purchase/bills/${arr[0].id}`);
      return json({ ok: true, resumen: arr.map((b2: any) => ({ id: b2.id, nr: b2.document_no, prov: b2.lastname_company, status: b2.status })), completa: una.body });
    }

    /* ============ MANDAR UNA FACTURA DE CREW A BEXIO ============
       Siempre BORRADOR (status CREATED, que es lo que devuelve bexio para las que están
       sin contabilizar). Nada se registra solo — misma regla que las facturas a
       clientes. */
    const { bill_id, dry_run = false, crear_proveedor = false, supplier_id } = body;
    if (!bill_id) return json({ error: "falta bill_id" }, 400);

    const admin = createClient(SB_URL, SERVICE);
    const { data: f } = await admin.from("project_bills").select("*, projects(title)").eq("id", bill_id).maybeSingle();
    if (!f) return json({ error: "factura no encontrada" }, 404);
    if (f.bexio_id) return json({ error: "esta factura ya está en bexio", bexio_no: f.bexio_no }, 409);
    if (!f.gross) return json({ error: "la factura no tiene importe — revisá los datos antes de mandarla" }, 400);

    /* 1. El proveedor. Buscar por nombre y NO crear a la ligera: bexio tiene cuatro
       contactos "Sonova" por exactamente este motivo. Si hay varios candidatos se
       devuelven para que elija una persona. */
    let provId = supplier_id ?? null;
    let creado = false;
    if (!provId) {
      const nombre = String(f.supplier || "").trim();
      if (!nombre) return json({ error: "la factura no tiene proveedor — completalo antes de mandarla" }, 400);
      const q = await bx(`contact/search`, {
        method: "POST",
        body: JSON.stringify([{ field: "name_1", value: nombre, criteria: "like" }]),
      });
      const cands = Array.isArray(q.body) ? (q.body as any[]) : [];
      if (cands.length === 1) provId = cands[0].id;
      else if (cands.length > 1 && !crear_proveedor) {
        return json({ necesita_eleccion: true,
          candidatos: cands.slice(0, 8).map((c) => ({ id: c.id, nombre: [c.name_1, c.name_2].filter(Boolean).join(" "), mail: c.mail })) });
      } else if (!cands.length) {
        if (!crear_proveedor) return json({ necesita_eleccion: true, candidatos: [], sugerencia: nombre });
        /* Persona o empresa: si el nombre tiene dos palabras y ninguna suele ser razón
           social, se crea como persona (contact_type_id 2). */
        const esEmpresa = /\b(ag|gmbh|sa|sarl|ltd|inc|studio|film|production|media)\b/i.test(nombre);
        const partes = nombre.split(/\s+/);
        const alta = await bx("contact", { method: "POST", body: JSON.stringify({
          contact_type_id: esEmpresa ? 1 : 2,
          name_1: esEmpresa ? nombre : partes.slice(-1)[0],
          name_2: esEmpresa ? "" : partes.slice(0, -1).join(" "),
          user_id: 1, owner_id: 1,
        }) });
        if (!alta.ok) return json({ error: "bexio rechazó crear el proveedor", detalle: alta.body }, 502);
        provId = (alta.body as any).id; creado = true;
      }
    }

    /* 2. La factura. Una sola línea con el importe NETO y su impuesto: partirla en
       posiciones sería inventar un detalle que la factura del freelance no tiene. */
    const neto = Number(f.net ?? f.gross) || 0;
    const cuerpo = {
      supplier_id: provId,
      contact_partner_id: provId,
      vendor_ref: f.vendor_ref || null,
      title: [f.projects?.title, f.extracted?.concepto].filter(Boolean).join(" — ").slice(0, 120) || "Factura de proveedor",
      currency_code: f.currency || "CHF",
      bill_date: f.bill_date || new Date().toISOString().slice(0, 10),
      due_date: f.due_date || null,
      line_items: [{ amount: neto, booking_account_id: BOOKING_ACCOUNT, tax_id: null, position: 0,
                     title: (f.extracted?.concepto || "Servicios de producción").slice(0, 120) }],
    };
    if (dry_run) return json({ ok: true, dry_run: true, proveedor_id: provId, proveedor_creado: creado, cuerpo });

    const cr = await bx("4.0/purchase/bills", { method: "POST", body: JSON.stringify(cuerpo) });
    if (!cr.ok) return json({ error: "bexio rechazó la factura", status: cr.status, detalle: cr.body, cuerpo }, 502);
    const nueva = cr.body as any;

    await admin.from("project_bills")
      .update({ estado: "en_bexio", bexio_id: String(nueva.id ?? ""), bexio_no: nueva.document_no ?? null })
      .eq("id", bill_id);

    return json({ ok: true, bexio_id: nueva.id, bexio_no: nueva.document_no, proveedor_id: provId, proveedor_creado: creado });
  } catch (e) {
    console.error("FUNCTION_ERROR", String(e));
    return json({ error: String(e) }, 500);
  }
});
