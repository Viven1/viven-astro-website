// Supabase Edge Function: bexio-sync
// Trae de Bexio las facturas EMITIDAS abiertas (entradas esperadas) y las
// facturas de PROVEEDOR pendientes (salidas) y las vuelca a cashflow_entries
// con source='bexio' — el modelo Tresio: la proyección de liquidez se calcula
// con la facturación real. Refresh completo e idempotente: borra las filas
// bexio y re-inserta las vigentes; las partidas manuales NUNCA se tocan.
// Facturas pagadas desaparecen solas del refresh (ya no son flujo futuro).
//
// Auth: Bearer CRON_SECRET (cron diario) o JWT de usuario del dashboard.
// Secrets: BEXIO_API_TOKEN (seteado 2026-07-24). Deploy: --no-verify-jwt

import { createClient } from "jsr:@supabase/supabase-js@2";

const service = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";
const BEXIO = Deno.env.get("BEXIO_API_TOKEN") ?? "";
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } });

async function bexioGet(path: string): Promise<unknown[]> {
  const out: unknown[] = [];
  for (let offset = 0; offset < 5000; offset += 500) {
    const res = await fetch(`https://api.bexio.com/2.0/${path}?limit=500&offset=${offset}`, {
      headers: { Authorization: `Bearer ${BEXIO}`, Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`Bexio ${path} ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const page = await res.json();
    if (!Array.isArray(page) || !page.length) break;
    out.push(...page);
    if (page.length < 500) break;
  }
  return out;
}

/* Las facturas de PROVEEDOR viven en la API 4.0 (`purchase/bills`), no en `kb_bill` —
   ese endpoint devuelve 404 y siempre lo devolvió. El error se guardaba en un campo
   opcional de la respuesta que nadie leía, así que Cash Flow estuvo desde siempre sin
   una sola salida: solo entradas. Medido el 26 ago 2026: CHF 16.680 de facturas de
   proveedor pendientes, ninguna en la proyección.
   Pagina de a 500 y devuelve TODAS las filas (hay 500+ históricas). */
async function comprasPendientes(todas = false): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for (let page = 1; page <= 20; page++) {
    const r = await fetch(`https://api.bexio.com/4.0/purchase/bills?limit=500&page=${page}`, {
      headers: { Authorization: `Bearer ${BEXIO}`, Accept: "application/json" },
    });
    if (!r.ok) throw new Error(`purchase/bills ${r.status}: ${(await r.text()).slice(0, 160)}`);
    const b = await r.json();
    const arr = (b as { data?: Record<string, unknown>[] })?.data ?? [];
    out.push(...arr);
    if (arr.length < 500) break;
  }
  /* Lo que importa para la liquidez no es el estado sino cuánta plata queda por pagar.
     Una PAID con pending 0 no es flujo futuro; una DRAFT con pending sí lo es. */
  return todas ? out : out.filter((b) => Number(b.pending_amount ?? 0) > 0);
}

Deno.serve(async (req) => {
  try {
    const auth = req.headers.get("Authorization") ?? "";
    let ok = CRON_SECRET && auth === `Bearer ${CRON_SECRET}`;
    if (!ok) {
      const supa = createClient(SB_URL, SB_ANON, { global: { headers: { Authorization: auth } } });
      const { data: { user } } = await supa.auth.getUser();
      ok = !!user;
    }
    if (!ok) return json({ error: "unauthorized" }, 401);
    if (!BEXIO) return json({ error: "BEXIO_API_TOKEN no configurado" }, 500);

    /* DIAGNÓSTICO: qué hay REALMENTE en bexio, por estado. Sin esto no se puede saber
       si el cash flow está incompleto porque falta plata o porque el filtro deja cosas
       afuera — y la respuesta era la segunda. */
    const cuerpoReq = await req.json().catch(() => ({}));
    if (cuerpoReq && cuerpoReq.diag) {
      const invs = (await bexioGet("kb_invoice")) as Record<string, unknown>[];
      const porEstado: Record<string, { n: number; total: number; pendiente: number }> = {};
      for (const i of invs) {
        const k = String(i.kb_item_status_id ?? "?");
        porEstado[k] = porEstado[k] || { n: 0, total: 0, pendiente: 0 };
        porEstado[k].n++;
        porEstado[k].total += Number(i.total || 0);
        porEstado[k].pendiente += Number(i.total_remaining_payments ?? 0);
      }
      let compras: unknown = null;
      try {
        const arr = await comprasPendientes(true);
        const pe: Record<string, { n: number; total: number; pend: number }> = {};
        for (const x of arr) {
          const k = String(x.status ?? "?");
          pe[k] = pe[k] || { n: 0, total: 0, pend: 0 };
          pe[k].n++;
          pe[k].total += Number((x as { amount_man?: number }).amount_man ?? 0);
          pe[k].pend += Number((x as { pending_amount?: number }).pending_amount ?? 0);
        }
        compras = { total_filas: arr.length, por_estado: pe };
      } catch (e) { compras = { error: String(e).slice(0, 200) }; }
      let pend: unknown = [];
      try {
        pend = (await comprasPendientes()).map((b) => ({ no: b.document_no, quien: b.lastname_company,
          estado: b.status, pendiente: b.pending_amount, vence: b.due_date, fecha: b.bill_date }));
      } catch (e) { pend = { error: String(e).slice(0, 160) }; }
      return json({ ok: true, facturas_emitidas: { total: invs.length, por_estado: porEstado }, compras, pendientes: pend });
    }

    // Facturas emitidas: kb_item_status_id 8=abierta, 16=parcial (7=borrador,
    // 9=pagada, 19=anulada se excluyen). Monto pendiente real por factura.
    type Inv = { id: number; document_nr?: string; title?: string | null; kb_item_status_id?: number; is_valid_to?: string; total?: string; total_remaining_payments?: string; total_received_payments?: string };
    const invoices = (await bexioGet("kb_invoice")) as Inv[];
    /* 7 = borrador · 8 = abierta · 16 = pagada en parte. Las tres son plata que
       todavía no entró. Antes solo entraban 8 y 16, así que TODA factura creada desde
       el dashboard —que nace en borrador— era invisible en la proyección. */
    const openInv = invoices.filter((i) => [7, 8, 16].includes(Number(i.kb_item_status_id)));

    // Facturas de proveedor (salidas) — API 4.0, las que todavía deben plata.
    let bills: Record<string, unknown>[] = [];
    let billsNote = "";
    try { bills = await comprasPendientes(); }
    catch (e) { billsNote = "no se pudieron leer las facturas de proveedor: " + String(e).slice(0, 160); }

    const today = new Date().toISOString().slice(0, 10);
    const rows: Record<string, unknown>[] = [];
    /* `status` distingue lo que YA es cobrable/pagable (confirmed) de lo que todavía es
       un borrador en bexio (projected). Importa: la factura que se crea desde el
       dashboard nace SIEMPRE en borrador —así lo pidió Sebastián— y hasta ahora quedaba
       afuera del cash flow por completo. CHF 19.854 invisibles el 26 ago 2026. */
    const push = (kind: string, id: string, desc: string, amount: number, due: string | undefined, estado: string) => {
      if (!(amount > 0)) return;
      rows.push({
        kind, source: "bexio", bexio_id: id,
        description: desc.slice(0, 200),
        amount_chf: Math.round(amount * 100) / 100,
        // vencidas: proyectarlas a hoy (plata que debería entrar/salir ya)
        /* Vencidas: se proyectan a hoy, porque es plata que ya debería haber entrado o
           salido. Pero se DICE, con los días — ocho facturas de proveedor vencidas por
           CHF 16.680, la más vieja de mayo de 2025, no es un detalle de la curva: es lo
           primero que hay que mirar. */
        due_date: due && due >= today ? due : today,
        status: estado, created_by: "bexio-sync",
      });
    };
    for (const i of openInv) {
      const remaining = Number(i.total_remaining_payments ?? NaN);
      const amount = Number.isFinite(remaining) ? remaining : Number(i.total || 0) - Number(i.total_received_payments || 0);
      const borrador = Number(i.kb_item_status_id) === 7;
      const vence = i.is_valid_to?.slice(0, 10);
      const dias = vence && vence < today ? Math.floor((Date.parse(today) - Date.parse(vence)) / 864e5) : 0;
      push("income", `inv-${i.id}`,
        (borrador ? "📝 " : "") + `${i.document_nr || i.id} ${i.title || ""}`.trim()
          + (dias ? ` — vencida hace ${dias} días` : ""),
        amount, vence, borrador ? "projected" : "confirmed");
    }
    for (const b of bills) {
      const amount = Number(b.pending_amount ?? 0);
      const quien = [b.firstname_suffix, b.lastname_company].filter(Boolean).join(" ");
      const est = String(b.status ?? "");
      const borrador = est === "DRAFT" || est === "CREATED";
      const vence = String(b.due_date ?? "").slice(0, 10) || undefined;
      const dias = vence && vence < today ? Math.floor((Date.parse(today) - Date.parse(vence)) / 864e5) : 0;
      push("expense", `bill-${b.id}`,
        (borrador ? "📝 " : "") + [b.document_no, quien, b.title].filter(Boolean).join(" · ")
          + (dias ? ` — vencida hace ${dias} días` : ""),
        amount, vence, borrador ? "projected" : "confirmed");
    }

    // refresh completo de lo bexio (idempotente); lo manual no se toca
    const del = await service.from("cashflow_entries").delete().eq("source", "bexio");
    if (del.error) return json({ error: "delete: " + del.error.message }, 500);
    if (rows.length) {
      const ins = await service.from("cashflow_entries").insert(rows);
      if (ins.error) return json({ error: "insert: " + ins.error.message }, 500);
    }
    const suma = (k: string) => rows.filter((r) => r.kind === k).reduce((a, r) => a + Number(r.amount_chf), 0);
    const vencidas = rows.filter((r) => /vencida hace/.test(String(r.description)));
    return json({ ok: true,
      facturas_por_cobrar: openInv.length, entra: Math.round(suma("income")),
      facturas_de_proveedor: bills.length, sale: Math.round(suma("expense")),
      entries: rows.length,
      vencidas: vencidas.length,
      vencidas_chf: Math.round(vencidas.reduce((a, r) => a + Number(r.amount_chf), 0)),
      /* El error de las compras iba en un campo opcional que nadie miraba. Ahora viaja
         como `error_parcial`, y la pantalla lo muestra. */
      error_parcial: billsNote || null });
  } catch (e) {
    console.error("FUNCTION_ERROR", String(e));
    return json({ error: String(e) }, 500);
  }
});
