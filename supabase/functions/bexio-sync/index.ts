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

    // Facturas emitidas: kb_item_status_id 8=abierta, 16=parcial (7=borrador,
    // 9=pagada, 19=anulada se excluyen). Monto pendiente real por factura.
    type Inv = { id: number; document_nr?: string; title?: string | null; kb_item_status_id?: number; is_valid_to?: string; total?: string; total_remaining_payments?: string; total_received_payments?: string };
    const invoices = (await bexioGet("kb_invoice")) as Inv[];
    const openInv = invoices.filter((i) => i.kb_item_status_id === 8 || i.kb_item_status_id === 16);

    // Facturas de proveedor (salidas): estados pendientes según su propio ciclo.
    type Bill = { id: number; document_nr?: string; title?: string | null; kb_item_status_id?: number; is_valid_to?: string; total?: string; total_remaining_payments?: string };
    let bills: Bill[] = [];
    let billsNote = "";
    try {
      bills = ((await bexioGet("kb_bill")) as Bill[]).filter((b) => b.kb_item_status_id === 8 || b.kb_item_status_id === 16);
    } catch (e) { billsNote = "kb_bill no disponible: " + String(e).slice(0, 120); }

    const today = new Date().toISOString().slice(0, 10);
    const rows: Record<string, unknown>[] = [];
    const push = (kind: string, id: string, desc: string, amount: number, due: string | undefined) => {
      if (!(amount > 0)) return;
      rows.push({
        kind, source: "bexio", bexio_id: id,
        description: desc.slice(0, 200),
        amount_chf: Math.round(amount * 100) / 100,
        // vencidas: proyectarlas a hoy (plata que debería entrar/salir ya)
        due_date: due && due >= today ? due : today,
        status: "projected", created_by: "bexio-sync",
      });
    };
    for (const i of openInv) {
      const remaining = Number(i.total_remaining_payments ?? NaN);
      const amount = Number.isFinite(remaining) ? remaining : Number(i.total || 0) - Number(i.total_received_payments || 0);
      push("income", `inv-${i.id}`, `${i.document_nr || i.id} ${i.title || ""}`.trim(), amount, i.is_valid_to?.slice(0, 10));
    }
    for (const b of bills) {
      const remaining = Number(b.total_remaining_payments ?? NaN);
      const amount = Number.isFinite(remaining) ? remaining : Number(b.total || 0);
      push("expense", `bill-${b.id}`, `${b.document_nr || b.id} ${b.title || ""}`.trim(), amount, b.is_valid_to?.slice(0, 10));
    }

    // refresh completo de lo bexio (idempotente); lo manual no se toca
    const del = await service.from("cashflow_entries").delete().eq("source", "bexio");
    if (del.error) return json({ error: "delete: " + del.error.message }, 500);
    if (rows.length) {
      const ins = await service.from("cashflow_entries").insert(rows);
      if (ins.error) return json({ error: "insert: " + ins.error.message }, 500);
    }
    return json({ ok: true, invoices_open: openInv.length, bills_open: bills.length, entries: rows.length, note: billsNote || undefined });
  } catch (e) {
    console.error("FUNCTION_ERROR", String(e));
    return json({ error: String(e) }, 500);
  }
});
