// Supabase Edge Function: bexio-import-clients
// IMPORT ÚNICO de la cartera histórica: contactos de Bexio con facturas
// PAGADAS (kb_item_status_id=9) → lead + deal 'ganado' con la fecha real de
// la última factura, para que el motor de reactivación (reactivation-engine)
// tenga combustible con los clientes pre-CRM.
//
// PRIVACIDAD (pedido explícito de Sebastián: "cuidado con la info que pones y
// como"): al CRM NO se importa NINGÚN monto ni dato financiero — solo nombre,
// empresa, email, título del proyecto y fecha. deal_value queda null. Los
// importes de Bexio viven únicamente en el módulo Cashflow (superadmin-only).
//
// Idempotente: se puede correr N veces — matchea leads existentes por email
// (case-insensitive) y no duplica ni leads ni deals ganados. No toca leads
// con deals abiertos (conversación comercial en curso).
//
// Auth: Bearer CRON_SECRET o JWT de usuario. Sin cron: se dispara a mano.
// Probar: -d '{"dry_run":true}'  → lista candidatos + distribución de estados,
//          sin escribir nada.

import { createClient } from "jsr:@supabase/supabase-js@2";

const service = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";
const BEXIO = Deno.env.get("BEXIO_API_TOKEN") ?? "";
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } });

const TEST = /@viven\.ch$|@entropia|@example\.|test/i;

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
    const body = await req.json().catch(() => ({}));
    const dryRun = !!body.dry_run;

    // ---- facturas pagadas, agrupadas por contacto (sin montos) ----
    type Inv = { id: number; contact_id?: number; title?: string | null; document_nr?: string; kb_item_status_id?: number; is_valid_from?: string };
    const invoices = (await bexioGet("kb_invoice")) as Inv[];
    const statusCounts: Record<string, number> = {};
    for (const i of invoices) statusCounts[String(i.kb_item_status_id)] = (statusCounts[String(i.kb_item_status_id)] ?? 0) + 1;
    const paid = invoices.filter((i) => i.kb_item_status_id === 9 && i.contact_id);
    const byContact = new Map<number, Inv[]>();
    for (const i of paid) {
      if (!byContact.has(i.contact_id!)) byContact.set(i.contact_id!, []);
      byContact.get(i.contact_id!)!.push(i);
    }

    // ---- contactos de Bexio: typ 1=empresa, 2=persona ----
    type Contact = { id: number; contact_type_id?: number; name_1?: string; name_2?: string; mail?: string | null };
    const contacts = (await bexioGet("contact")) as Contact[];
    const contactById = new Map<number, Contact>(contacts.map((c) => [c.id, c]));

    type Cand = {
      contact_id: number; name: string; first_name: string | null; last_name: string | null;
      company: string | null; email: string; invoices: number; last_paid: string; project: string;
    };
    const cands: Cand[] = [];
    const skipped: { contact_id: number; who: string; reason: string }[] = [];
    for (const [cid, invs] of byContact) {
      const c = contactById.get(cid);
      const who = c ? [c.name_2, c.name_1].filter(Boolean).join(" ") : `contacto ${cid}`;
      if (!c) { skipped.push({ contact_id: cid, who, reason: "contacto no encontrado" }); continue; }
      const email = (c.mail || "").trim().toLowerCase();
      if (!email || !email.includes("@")) { skipped.push({ contact_id: cid, who, reason: "sin email" }); continue; }
      if (TEST.test(email)) { skipped.push({ contact_id: cid, who, reason: "email interno/test" }); continue; }
      invs.sort((a, b) => String(b.is_valid_from || "").localeCompare(String(a.is_valid_from || "")));
      const last = invs[0];
      const isPerson = c.contact_type_id === 2;
      const first = isPerson ? (c.name_2 || null) : null;
      const lastName = isPerson ? (c.name_1 || null) : null;
      const name = isPerson ? [c.name_2, c.name_1].filter(Boolean).join(" ") : String(c.name_1 || "");
      const project = String(last.title || "").trim() || `Proyecto ${String(last.is_valid_from || "").slice(0, 4) || "anterior"}`;
      cands.push({
        contact_id: cid, name: name || email, first_name: first, last_name: lastName,
        company: isPerson ? null : String(c.name_1 || "") || null,
        email, invoices: invs.length, last_paid: String(last.is_valid_from || "").slice(0, 10), project,
      });
    }
    cands.sort((a, b) => b.last_paid.localeCompare(a.last_paid));

    if (dryRun) {
      return json({ ok: true, dry_run: true, invoice_status_counts: statusCounts, paid_invoices: paid.length,
        candidates: cands, skipped });
    }

    // ---- import idempotente ----
    const { data: allLeads } = await service.from("leads").select("id,email");
    const leadByEmail = new Map<string, number>();
    for (const l of allLeads ?? []) { if (l.email) leadByEmail.set(String(l.email).trim().toLowerCase(), Number(l.id)); }
    const { data: allDeals } = await service.from("deals").select("id,lead_id,stage,archived").eq("archived", false);
    const wonLeads = new Set((allDeals ?? []).filter((d) => d.stage === "ganado").map((d) => Number(d.lead_id)));
    const openLeads = new Set((allDeals ?? []).filter((d) => ["nuevo", "contactado", "videocall", "propuesta"].includes(d.stage)).map((d) => Number(d.lead_id)));

    let created = 0, linked = 0, skippedRun = 0;
    const report: { email: string; action: string }[] = [];
    for (const c of cands) {
      let leadId = leadByEmail.get(c.email) ?? null;
      if (leadId && wonLeads.has(leadId)) { skippedRun++; report.push({ email: c.email, action: "ya tiene deal ganado" }); continue; }
      if (leadId && openLeads.has(leadId)) { skippedRun++; report.push({ email: c.email, action: "deal abierto en curso — no se toca" }); continue; }
      const wonAt = c.last_paid ? new Date(c.last_paid + "T12:00:00Z").toISOString() : new Date().toISOString();
      if (!leadId) {
        // idioma por dominio del email: DACH+LI → de, resto → en (el motor de
        // reactivación escribe en lead.lang; a un cliente de Irlanda o Corea
        // no le puede llegar alemán)
        const langGuess = /\.(ch|de|at|li)$/i.test(c.email.split("@")[1] ?? "") ? "de" : "en";
        const { data: nl, error: lerr } = await service.from("leads").insert({
          name: c.name, first_name: c.first_name, last_name: c.last_name, company: c.company,
          email: c.email, lang: langGuess, channel: "bexio-import", status: "ganado", won_at: wonAt,
        }).select("id").single();
        if (lerr) { skippedRun++; report.push({ email: c.email, action: "error lead: " + lerr.message.slice(0, 80) }); continue; }
        leadId = Number(nl.id);
        created++;
        report.push({ email: c.email, action: "lead + deal ganado creados" });
      } else {
        linked++;
        report.push({ email: c.email, action: "lead existente → deal ganado agregado" });
      }
      // deal_value null a propósito: cero datos financieros en el CRM
      const { error: derr } = await service.from("deals").insert({
        lead_id: leadId, title: c.project.slice(0, 140), stage: "ganado", won_at: wonAt, archived: false,
      });
      if (derr) { report.push({ email: c.email, action: "error deal: " + derr.message.slice(0, 80) }); continue; }
      await service.from("lead_notes").insert({
        lead_id: String(leadId), author: "Sistema",
        body: `📦 Cliente histórico importado de Bexio — ${c.invoices} factura(s) pagada(s), última ${c.last_paid.slice(0, 7)}. Proyecto: "${c.project.slice(0, 100)}". Sin datos financieros por diseño.`,
      }).then(() => {}, () => {});
    }
    return json({ ok: true, created, linked_existing: linked, skipped: skippedRun, total_candidates: cands.length, report });
  } catch (e) {
    console.error("IMPORT_ERROR", String(e));
    return json({ error: String(e) }, 500);
  }
});
