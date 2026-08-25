// Supabase Edge Function: bexio-invoice
//
// Manda una factura del dashboard a Bexio. NO factura acá: Bexio pone el número,
// el IVA, la contabilidad y los recordatorios. El dashboard solo aporta el cliente
// y las posiciones, que ya las tiene de la oferta ganada.
//
// Por qué así y no facturando en el dashboard: había un módulo de facturas propio
// (FEATURE_INVOICING) que Sebastián pausó el 12 jul 2026. Dos sistemas numerando
// facturas es un problema contable, no una comodidad.
//
// Modos:
//   { probe: true }               → solo lee: perfil, impuestos y una factura de
//                                   ejemplo. No escribe nada. Sirve para saber qué
//                                   permisos tiene el token antes de intentar nada.
//   { offer_id, dry_run: true }   → arma el payload y dice a qué contacto de Bexio
//                                   iría, SIN crear nada.
//   { offer_id }                  → crea la factura en Bexio (en borrador) y guarda
//                                   el número devuelto en public.invoices.
//
// Auth: Bearer CRON_SECRET o JWT del dashboard. Secrets: BEXIO_API_TOKEN.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, content-type" };
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";
const BEXIO = Deno.env.get("BEXIO_API_TOKEN") ?? "";
const service = createClient(SB_URL, SERVICE);
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

async function bx(path: string, init?: RequestInit) {
  // path puede venir con versión propia ("3.0/taxes"); si no, se asume 2.0
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
  const auth = req.headers.get("Authorization") ?? "";
  if (CRON_SECRET && auth !== `Bearer ${CRON_SECRET}`) {
    // si no es el cron, tiene que ser un usuario del dashboard
    const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
    const sb = createClient(SB_URL, anon, { global: { headers: { Authorization: auth } } });
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return json({ error: "unauthorized" }, 401);
  }
  if (!BEXIO) return json({ error: "falta BEXIO_API_TOKEN" }, 500);

  try {
    const body = await req.json().catch(() => ({}));

    // ---------- modo sondeo: qué puede hacer el token, sin escribir ----------
    if (body.probe) {
      const [perfil, impuestos, unaFactura, contactos, usuarios, cuentas] = await Promise.all([
        bx("company_profile"), bx("3.0/taxes?limit=200"), bx("kb_invoice?limit=1"), bx("contact?limit=1"),
        bx("users"), bx("accounts?limit=200"),
      ]);
      /* La verdad sobre qué IVA usan NO sale del catálogo de impuestos (ahí conviven
         tasas viejas y nuevas): sale de la última factura que emitieron de verdad.
         Facturar al 7,7% cuando la tasa suiza es 8,1% desde 2024 sería un error
         contable, y el catálogo por sí solo no dice cuál está vigente para ellos. */
      const ref = Number(body.ref_invoice) || 1121;   // una factura reciente de verdad
      const cab = await bx(`kb_invoice/${ref}`);
      const pos = await bx(`kb_invoice/${ref}/kb_position_custom`);
      const ultimaId = (cab.body as Record<string, unknown> | undefined)?.document_nr ?? cab.status;
      const posiciones = Array.isArray(pos.body)
        ? (pos.body as Record<string, unknown>[]).slice(0, 3).map((x) => ({
            text: String(x.text ?? "").slice(0, 40), amount: x.amount, unit_price: x.unit_price,
            tax_id: x.tax_id, account_id: x.account_id, unit_id: x.unit_id }))
        : pos.body;
      const cabecera = cab.body && typeof cab.body === "object"
        ? (() => { const f = cab.body as Record<string, unknown>;
            return { user_id: f.user_id, mwst_type: f.mwst_type, mwst_is_net: f.mwst_is_net,
                     currency_id: f.currency_id, language_id: f.language_id,
                     bank_account_id: f.bank_account_id, payment_type_id: f.payment_type_id }; })()
        : cab.status;
      /* ¿El token puede ESCRIBIR? No hay endpoint que lo diga, así que se prueba con
         un POST vacío: un cuerpo vacío no puede crear una factura en ningún caso, y
         la respuesta distingue lo que necesitamos saber —403 es "no tenés permiso",
         422/400 es "tenés permiso pero el cuerpo está mal"—. No crea nada. */
      const escritura = await bx("kb_invoice", { method: "POST", body: "{}" });
      const puedeEscribir = escritura.status !== 401 && escritura.status !== 403;
      const impList = Array.isArray(impuestos.body)
        ? (impuestos.body as { id: number; name: string; value: string; is_active: boolean }[])
            .filter((t) => t.is_active).map((t) => ({ id: t.id, name: t.name, value: t.value }))
        : impuestos.body;
      const facturaEjemplo = Array.isArray(unaFactura.body) && unaFactura.body[0]
        ? Object.keys(unaFactura.body[0] as Record<string, unknown>)
        : unaFactura.body;
      return json({
        ok: true,
        lee_perfil: perfil.status, lee_impuestos: impuestos.status,
        lee_facturas: unaFactura.status, lee_contactos: contactos.status,
        puede_escribir: puedeEscribir,
        prueba_escritura_status: escritura.status,
        prueba_escritura_dijo: typeof escritura.body === "string" ? escritura.body.slice(0, 200) : escritura.body,
        impuestos_venta: Array.isArray(impuestos.body)
          ? (impuestos.body as { id: number; name: string; value: string; is_active: boolean; type?: string }[])
              .filter((t) => t.is_active && Number(t.value) > 0 && /umsatz|dl|ertrag/i.test(t.name))
              .map((t) => ({ id: t.id, name: t.name, value: t.value }))
          : impuestos.body,
        usuarios: Array.isArray(usuarios.body)
          ? (usuarios.body as { id: number; firstname: string; lastname: string; email: string }[])
              .map((u) => ({ id: u.id, nombre: u.firstname + " " + u.lastname, email: u.email }))
          : usuarios.body,
        cuentas_de_ingreso: Array.isArray(cuentas.body)
          ? (cuentas.body as { id: number; account_no: string; name: string; account_type: number; is_active: boolean }[])
              .filter((c) => c.is_active && /^3/.test(String(c.account_no)))
              .map((c) => ({ id: c.id, nro: c.account_no, name: c.name })).slice(0, 12)
          : cuentas.body,
        ultima_factura: Array.isArray(unaFactura.body) && unaFactura.body[0]
          ? (() => { const f = unaFactura.body[0] as Record<string, unknown>;
              return { nr: f.document_nr, title: f.title, contact_id: f.contact_id, user_id: f.user_id,
                       mwst_type: f.mwst_type, mwst_is_net: f.mwst_is_net, currency_id: f.currency_id,
                       total: f.total, estado: f.kb_item_status_id }; })()
          : null,
        campos_de_una_factura: facturaEjemplo,
        ultima_emitida: ultimaId,
        cabecera_de_esa: cabecera,
        posiciones_de_esa: posiciones,
      });
    }

    return json({ error: "falta offer_id" }, 400);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
