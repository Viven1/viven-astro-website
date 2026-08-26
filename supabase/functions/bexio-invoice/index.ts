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

/* La lista TIENE que incluir x-client-info y apikey: son los que manda el cliente de
   supabase-js en cada invoke(). Con solo "authorization, content-type" el navegador
   bloquea el POST y en pantalla se lee "Failed to send a request to the Edge Function",
   que no menciona CORS por ningún lado. Pasó el 26 ago 2026 con las facturas de bexio. */
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
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

    /* Borrar una factura que se creó por error. Pide el número exacto para no llevarse
       puesta otra, y solo funciona con borradores — una factura enviada no se borra, se
       anula desde bexio. */
    /* Catálogos de bexio que hacen falta para NO inventar datos del contacto. */
    if (body.catalogos) {
      const [langs, paises] = await Promise.all([bx("language"), bx("country?limit=300")]);
      return json({ ok: true,
        idiomas: langs.body,
        paises_muestra: Array.isArray(paises.body)
          ? (paises.body as Record<string, unknown>[]).filter((c) =>
              ["CH","AU","DE","AT","US","GB","ES","FR","IT","LI"].includes(String(c.iso_3166_alpha2)))
          : paises.body });
    }

    /* Borrar por NÚMERO, que es lo único que se ve en pantalla. El id interno de bexio
       no lo guardamos en la tabla `invoices`, así que sin esto había que ir a buscarlo a
       mano. Solo borra BORRADORES: una factura ya emitida no se borra, se anula en bexio.
       (Nació de un error mío: creé la RE-01122 de Mahlab al 100% cuando Sebastián había
       marcado dos fases.) */
    if (body.borrar_por_numero) {
      const nr = String(body.borrar_por_numero).trim();
      const q = await bx(`kb_invoice/search`, {
        method: "POST",
        body: JSON.stringify([{ field: "document_nr", value: nr, criteria: "=" }]),
      });
      const arr = Array.isArray(q.body) ? (q.body as any[]) : [];
      if (!arr.length) return json({ error: `bexio no tiene ninguna factura ${nr}` }, 404);
      if (arr.length > 1) return json({ error: `hay ${arr.length} facturas con el número ${nr} — resolvelo en bexio` }, 409);
      const f = arr[0];
      /* 7 = borrador (DRAFT) en bexio. Cualquier otro estado ya salió: no se toca. */
      if (Number(f.kb_item_status_id) !== 7) {
        return json({ error: `la ${nr} ya no es un borrador (estado ${f.kb_item_status_id}) — anulala desde bexio, borrarla dejaría un hueco en la numeración` }, 409);
      }
      const d = await bx(`kb_invoice/${f.id}`, { method: "DELETE" });
      if (!d.ok) return json({ error: `bexio no la borró (${d.status}): ${JSON.stringify(d.body).slice(0, 200)}` }, 502);
      await service.from("invoices").delete().eq("number", nr);
      return json({ ok: true, borrada: nr, bexio_id: f.id });
    }

    if (body.borrar_factura) {
      const id = Number(body.borrar_factura);
      const f = await bx(`kb_invoice/${id}`);
      if (!f.ok) return json({ error: "no existe esa factura", detalle: f.body }, 404);
      const nr = (f.body as { document_nr?: string }).document_nr;
      if (body.confirmar_numero !== nr) return json({ error: "el número no coincide", es: nr }, 400);
      const d = await bx(`kb_invoice/${id}`, { method: "DELETE" });
      if (d.ok) await service.from("invoices").delete().eq("number", nr);
      return json({ ok: d.ok, status: d.status, borrada: nr, detalle: d.body });
    }

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
      // ¿qué tasa es cada id? Se listan TODAS las activas con su valor, sin filtrar
      const todas = await bx("3.0/taxes?limit=300");
      const enCero = Array.isArray(todas.body)
        ? (todas.body as { id: number; name?: string; code?: string; value: string; is_active: boolean; type?: string }[])
            .filter((t) => t.is_active && Number(t.value) === 0)
            .map((t) => ({ id: t.id, name: t.name, code: t.code, type: t.type }))
        : todas.body;
      const conValor = Array.isArray(todas.body)
        ? (todas.body as { id: number; name: string; value: string; is_active: boolean }[])
            .filter((t) => t.is_active && Number(t.value) > 0)
            .map((t) => ({ id: t.id, name: t.name, value: Number(t.value) }))
            .sort((a, b) => b.value - a.value)
        : todas.body;
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
        impuestos_con_valor: conValor,
        impuestos_en_cero: enCero,
        ultima_emitida: ultimaId,
        cabecera_de_esa: cabecera,
        posiciones_de_esa: posiciones,
      });
    }

    // ================= CREAR LA FACTURA =================
    /* Parámetros de cabecera y de posición: NO se eligen de un catálogo, se copian
       de una factura que Viven emitió de verdad (RE-01121). El catálogo de impuestos
       de bexio tiene tasas viejas y nuevas activas al mismo tiempo —7,7% y 2,5%
       conviviendo— así que elegir de ahí era arriesgarse a facturar con la tasa
       equivocada. Copiando lo que ya usan no hay nada que adivinar.
       Si algún día cambian de banco, de cuenta o de tasa, se cambia acá. */
    const BX = { user_id: 1, mwst_type: 0, mwst_is_net: true, currency_id: 1,
                 language_id: 1, bank_account_id: 13, payment_type_id: 4,
                 tax_id: 66, account_id: 326, unit_id: 1 };

    /* ===== EL IVA: 8,1% O SIN IVA, SEGÚN EL CLIENTE =====
       Primero lo hice siempre al 8,1%. Sebastián lo corrigió: "algunos clientes son
       sin IVA ya que son extranjeros". Una exportación de servicios no lleva IVA
       suizo, y facturárselo a un cliente alemán es un error que después hay que
       corregir con una nota de crédito.
       Ninguno de los dos ids se hardcodea. Se buscan por lo que SON:
         · con IVA  → la tasa de venta (Umsatz) activa al 8,1%
         · sin IVA  → la de exportación, que en bexio es la de tipo
                      "not_taxable_turnover" (id 3 hoy: sales_export)
       En su catálogo hay siete ids activos al 8,1% y cinco al 7,7% conviviendo, así
       que elegir por número era jugar a la lotería: un id equivocado no rompe nada
       visible, emite con la tasa vieja y el error aparece en la contabilidad, tarde.
       Si falta cualquiera de las dos, la función se niega a facturar en vez de usar
       la que sea. */
    const IVA_ESPERADO = 8.1;
    let taxConIva: number | null = null, taxSinIva: number | null = null;
    {
      const tx = await bx("3.0/taxes?limit=300");
      const act = Array.isArray(tx.body)
        ? (tx.body as { id: number; name?: string; value: string; is_active: boolean; type?: string }[]).filter((t) => t.is_active)
        : [];
      const al81 = act.filter((t) => Math.abs(Number(t.value) - IVA_ESPERADO) < 0.01);

      /* ===== EL tax_id SALE DE UNA FACTURA REAL, NO DEL CATÁLOGO =====
         El catálogo tiene NUEVE tasas activas al 8,1% ("Umsatz (NS)", "Bezugsteuer
         Mat/DL", "Mat/DL (NS)", varias sin nombre...). Elegir por nombre daba la 54,
         "Umsatz (NS)", que parece la correcta y bexio RECHAZA en las posiciones de una
         factura: 422 "Diese Eingabe ist nicht korrekt" en las doce líneas. La que sí
         acepta es la 66, que es la que usa RE-01121 — una factura que ellos emitieron
         de verdad. Mismo criterio que ya se usó para los parámetros de cabecera:
         copiarlos de una factura que bexio aceptó, no deducirlos del catálogo. */
      const ult = await bx("kb_invoice?order_by=id_desc&limit=1");
      const ultId = Array.isArray(ult.body) ? (ult.body as { id: number }[])[0]?.id : null;
      if (ultId) {
        const det = await bx(`kb_invoice/${ultId}`);
        const pos = (det.body as { positions?: { tax_id?: number }[] } | undefined)?.positions ?? [];
        const idUsado = pos.map((x) => x.tax_id).find((x) => x != null);
        /* Solo se acepta si esa tasa sigue activa y sigue siendo del 8,1%: si el año que
           viene cambia la tasa suiza, esto NO debe arrastrar la vieja en silencio. */
        if (idUsado != null && al81.some((t) => t.id === idUsado)) taxConIva = idUsado;
      }
      if (taxConIva == null) {
        taxConIva = (al81.find((t) => /umsatz/i.test(t.name ?? "")) || al81.find((t) => t.id === BX.tax_id) || al81[0])?.id ?? null;
      }
      taxSinIva = act.find((t) => Number(t.value) === 0 && t.type === "not_taxable_turnover")?.id ?? null;
      if (tx.ok && !taxConIva) return json({ error: `no encontré una tasa de venta activa al ${IVA_ESPERADO}% en bexio — no facturo con otra` }, 502);
      if (!taxConIva) taxConIva = BX.tax_id;   // la consulta falló: respaldo
    }

    /* Cuál se usa: lo decide Sebastián en la pantalla. Lo que hace la función es
       SUGERIR según el país del contacto de bexio —fuera de Suiza y Liechtenstein,
       exportación— para que el caso raro no dependa de acordarse. */
    let paisContacto: number | null = null;
    if (Number(body.contact_id)) {
      const c = await bx(`contact/${Number(body.contact_id)}`);
      paisContacto = (c.body as { country_id?: number } | undefined)?.country_id ?? null;
    }
    const sugerirSinIva = paisContacto != null && paisContacto !== 1 && paisContacto !== 2;   // 1 CH · 2 LI
    const sinIva = body.iva === "no" || (body.iva === undefined && sugerirSinIva);
    if (sinIva && !taxSinIva) return json({ error: "no encontré la tasa de exportación (0%) en bexio — no facturo sin IVA sin ella" }, 502);
    const taxId = sinIva ? taxSinIva! : taxConIva!;

    const tipo = body.tipo === "propuesta" ? "propuesta" : "oferta";
    const docId = body.id;
    const pct = Math.max(1, Math.min(100, Number(body.pct) || 100));
    const dry = !!body.dry_run;
    if (!docId) return json({ error: "falta el id del documento" }, 400);

    // ---------- 1. el documento y su gente ----------
    const tabla = tipo === "propuesta" ? "proposals" : "offers";
    const { data: doc } = await service.from(tabla).select("*").eq("id", docId).maybeSingle();
    if (!doc) return json({ error: "no encontré " + (tipo === "propuesta" ? "la propuesta" : "la oferta") }, 404);
    const { data: lead } = doc.lead_id
      ? await service.from("leads").select("*").eq("id", doc.lead_id).maybeSingle()
      : { data: null };

    // ---------- 2. posiciones ----------
    /* La oferta guarda items sueltos; la propuesta guarda paquetes y hay que tomar
       el que el cliente ACEPTÓ, no el recomendado — son cosas distintas y confundirlas
       facturaría un paquete que nadie compró. */
    type It = { name?: string; qty?: number; price?: number; unit?: string; phase?: string };
    let items: It[] = [];
    if (tipo === "oferta") items = (doc.items ?? []) as It[];
    else {
      const tiers = ((doc.content ?? {}).tiers ?? []) as { name?: string; items?: It[] }[];
      const elegido = tiers.find((t) => t.name && doc.accepted_tier && t.name === doc.accepted_tier)
        || tiers.find((t) => (t as { recommended?: boolean }).recommended) || tiers[0];
      items = (elegido?.items ?? []) as It[];
    }
    const bruto = items.reduce((a, it) => a + (Number(it.qty) || 0) * (Number(it.price) || 0), 0);
    const descuento = Number(doc.discount_pct) || 0;
    const totalDoc = tipo === "propuesta" && Number(doc.accepted_total)
      ? Number(doc.accepted_total)
      : bruto * (1 - descuento / 100);
    if (!totalDoc) return json({ error: "el documento no tiene importe" }, 400);

    const titulo = String(doc.title || (tipo === "propuesta" ? "Propuesta" : "Oferta")) .slice(0, 180);
    const detalle = items.map((it) => `• ${it.name ?? ""} — ${Number(it.qty) || 0} ${it.unit ?? ""} × CHF ${Number(it.price) || 0}`).join("<br />");

    /* ===== UNA FACTURA O DOS =====
       Con 100% va una sola, con el detalle completo. Con un parcial se arman LAS DOS:
       el acconto para mandar ahora y el saldo ya preparado como borrador — pedido de
       Sebastián: "si ponemos 50% que arme ambas, así mandamos una y la segunda ya
       queda preparada". Las dos quedan en borrador; él decide cuándo sale cada una.
       El saldo se calcula como total − acconto (no como total × (100−pct)), así los
       dos importes suman exactamente el total sin que sobre ni falte un centavo. */
    const acconto = Math.round(totalDoc * pct) / 100;
    const saldo = Math.round((totalDoc - acconto) * 100) / 100;
    type Tramo = { etiqueta: string; posiciones: { text: string; amount: number; unit_price: number }[]; header: string; suf: string; importe: number };
    const tramos: Tramo[] = [];
    if (pct >= 100) {
      /* ===== UNA LÍNEA POR FASE, NO UNA POR ÍTEM =====
         Sebastián, 26 ago 2026: "que la divida por fase de proyecto —pre, production,
         post, o las fases denominadas en la oferta— así no es item by item, y es más
         fácil". Una factura de trece renglones se lee peor que una de tres, y al cliente
         no le sirve saber cuántas horas de 1st AC hubo: eso es la oferta, no la factura.
         Las fases salen de la propia oferta (`phase` de cada posición) y se respetan tal
         como estén escritas; el detalle de cada fase queda ABAJO de su línea, así el que
         quiera mirarlo lo tiene sin que domine el documento.
         Los ítems sin fase van juntos al final, en vez de perderse. */
      const conImporte = items.filter((it) => (Number(it.qty) || 0) * (Number(it.price) || 0) > 0);
      const orden: string[] = [];
      const porFase = new Map<string, typeof conImporte>();
      for (const it of conImporte) {
        const f = String(it.phase ?? "").trim() || "Otros";
        if (!porFase.has(f)) { porFase.set(f, []); orden.push(f); }
        porFase.get(f)!.push(it);
      }
      const pos = orden.map((f) => {
        const lista = porFase.get(f)!;
        const total = lista.reduce((a, it) => a + (Number(it.qty) || 0) * (Number(it.price) || 0), 0);
        const detalleFase = lista.map((it) =>
          `${(it.name ?? "").slice(0, 120)} — ${Number(it.qty) || 0} ${it.unit ?? ""}`).join("<br />");
        return {
          text: `<strong>${f}</strong><br />${detalleFase}`,
          amount: 1,
          unit_price: Math.round(total * 100) / 100,
        };
      });
      /* Un centavo de diferencia en una factura es una llamada del contador. El
         redondeo por fase puede no dar el total exacto: si sobra o falta, se ajusta en
         la última línea, que es donde menos se nota y donde es verdad. */
      const sumaFases = pos.reduce((a, x) => a + x.unit_price, 0);
      const dif = Math.round((totalDoc - sumaFases) * 100) / 100;
      if (dif !== 0 && pos.length) pos[pos.length - 1].unit_price = Math.round((pos[pos.length - 1].unit_price + dif) * 100) / 100;
      tramos.push({ etiqueta: "", posiciones: pos, header: titulo, suf: "", importe: totalDoc });
    } else {
      tramos.push({ etiqueta: `Akontozahlung ${pct}%`,
        posiciones: [{ text: `<strong>Akontozahlung ${pct}% — ${titulo}</strong><br />Gemäss Offerte über CHF ${totalDoc.toFixed(2)}`,
                       amount: 1, unit_price: acconto }],
        header: `${titulo}<br /><br />${detalle}`, suf: ` (${pct}%)`, importe: acconto });
      if (saldo > 0) tramos.push({ etiqueta: `Schlussrechnung ${100 - pct}%`,
        posiciones: [{ text: `<strong>Schlussrechnung ${100 - pct}% — ${titulo}</strong><br />Restbetrag gemäss Offerte über CHF ${totalDoc.toFixed(2)}`,
                       amount: 1, unit_price: saldo }],
        header: `${titulo}<br /><br />${detalle}`, suf: ` (saldo ${100 - pct}%)`, importe: saldo });
    }
    if (!tramos.length || !tramos[0].posiciones.length) return json({ error: "no hay posiciones con importe" }, 400);
    const posiciones = tramos[0].posiciones;

    // ---------- 3. el contacto en bexio ----------
    const email = String(doc.client_email || lead?.email || "").toLowerCase().trim();
    const empresa = String(doc.client_company || lead?.company || "").trim();
    const persona = String(doc.client_contact || lead?.name || "").trim();
    let contactId: number | null = Number(body.contact_id) || null, contactoCreado = false;
    /* Candidatos por NOMBRE, no solo por email. El email de la propuesta suele ser el
       de la persona (kaan.bulut@phonak.com) mientras que en bexio la empresa ya existe
       como "Sonova AG" con otro contacto. Buscar solo por email hubiera creado un
       segundo Sonova en su contabilidad, y eso no se deshace con un botón.
       Si aparecen candidatos, la decisión es de Sebastián: la pantalla se los muestra
       y él elige entre usar uno o crear uno nuevo. */
    const candidatos: { id: number; nombre: string; mail: string }[] = [];
    if (!contactId && email) {
      const busca = await bx("contact/search", { method: "POST",
        body: JSON.stringify([{ field: "mail", value: email, criteria: "=" }]) });
      const hits = Array.isArray(busca.body) ? busca.body as { id: number }[] : [];
      if (hits.length) contactId = hits[0].id;
    }
    if (!contactId && empresa) {
      const base = empresa.replace(/\b(ag|gmbh|sa|sarl|ltd|inc|llc)\b\.?/gi, "").trim();
      if (base.length >= 3) {
        const porNombre = await bx("contact/search", { method: "POST",
          body: JSON.stringify([{ field: "name_1", value: base, criteria: "like" }]) });
        if (Array.isArray(porNombre.body)) {
          (porNombre.body as { id: number; name_1?: string; name_2?: string; mail?: string }[])
            .slice(0, 6).forEach((c) => candidatos.push({
              id: c.id, nombre: [c.name_1, c.name_2].filter(Boolean).join(" · "), mail: c.mail || "" }));
        }
      }
    }
    /* Con candidatos y sin elección explícita no se crea nada: se devuelve la lista
       para preguntar. Vale para el ensayo y para la corrida de verdad. */
    if (!contactId && candidatos.length && !body.crear_contacto) {
      return json({ ok: false, necesita_decision: true, motivo: "hay contactos parecidos en bexio",
        cliente: { empresa, persona, email }, candidatos,
        total_documento: Math.round(totalDoc * 100) / 100, pct,
        importe_a_facturar: posiciones.reduce((a, p) => a + p.amount * p.unit_price, 0) });
    }
    if (!contactId) {
      /* Se crea con lo que tenemos, que es lo que él pidió: "que cree la persona/
         empresa con la data real". Si hay empresa es contacto tipo 1 (empresa) y la
         persona va en el nombre de contacto; si no, tipo 2 (persona). */
      /* `address` NO existe al CREAR un contacto: bexio lo devuelve al leer, pero al
         POST responde 422 "Unexpected extra form field named address" y no se crea nada.
         Pasó el 26 ago 2026 con Mahlab. La calle va en `remarks` para no perder el dato:
         mejor guardada donde se lee que descartada por prolijidad. */
      /* ===== NO INVENTAR DE DÓNDE ES EL CLIENTE =====
         Antes iba `country_id: 1` fijo — Suiza — para todos. A Mahlab, con teléfono
         +61 y dirección en Sydney, bexio lo dio de alta como suizo. Un contacto con el
         país equivocado no es un detalle cosmético: cambia el IVA que corresponde.
         Ahora se deduce, en este orden, y si no se puede se deja VACÍO en vez de
         afirmar algo falso: bexio lo pide al facturar y ahí se completa a mano.
           1. el prefijo del teléfono (+61 → AU)
           2. el dominio del email o de la web (.ch, .de, .co.uk…)
         El idioma sale del que ya sabemos de la persona (leads.lang), y la web del
         dominio de su email. Los ids no se hardcodean: se buscan en los catálogos de
         bexio por código ISO, porque son de cada cuenta. */
      const PREFIJO_PAIS: [string, string][] = [
        ["+41", "CH"], ["+423", "LI"], ["+49", "DE"], ["+43", "AT"], ["+33", "FR"],
        ["+39", "IT"], ["+34", "ES"], ["+44", "GB"], ["+1", "US"], ["+61", "AU"],
        ["+31", "NL"], ["+32", "BE"], ["+351", "PT"], ["+353", "IE"], ["+45", "DK"],
        ["+46", "SE"], ["+47", "NO"], ["+358", "FI"], ["+48", "PL"], ["+420", "CZ"],
      ];
      const TLD_PAIS: Record<string, string> = {
        ch: "CH", li: "LI", de: "DE", at: "AT", fr: "FR", it: "IT", es: "ES",
        uk: "GB", us: "US", au: "AU", nl: "NL", be: "BE", pt: "PT", ie: "IE",
        dk: "DK", se: "SE", no: "NO", fi: "FI", pl: "PL", cz: "CZ",
      };
      const tel = String(doc.client_phone || lead?.phone || "").replace(/[^\d+]/g, "");
      const dominio = (email.split("@")[1] || "").toLowerCase();
      let iso: string | null = null;
      // el prefijo más largo primero: +423 (Liechtenstein) antes que +4
      for (const [pre, cc] of [...PREFIJO_PAIS].sort((a, b) => b[0].length - a[0].length)) {
        if (tel.startsWith(pre)) { iso = cc; break; }
      }
      if (!iso && dominio) {
        const partes = dominio.split(".");
        const ult = partes[partes.length - 1];
        const penult = partes.length > 2 ? partes[partes.length - 2] : "";
        iso = TLD_PAIS[ult] ?? (penult === "co" && TLD_PAIS[ult] ? TLD_PAIS[ult] : null);
      }
      let countryId: number | undefined;
      if (iso) {
        const cs = await bx("country?limit=300");
        const lista = Array.isArray(cs.body) ? cs.body as { id: number; iso_3166_alpha2?: string }[] : [];
        countryId = lista.find((c) => String(c.iso_3166_alpha2).toUpperCase() === iso)?.id;
      }
      /* El idioma del contacto es el que ya usamos con esa persona. Un cliente
         australiano al que bexio le manda la factura en alemán es un problema real. */
      let languageId: number | undefined;
      const langLead = String(lead?.lang || "").slice(0, 2).toLowerCase();
      if (langLead) {
        const ls = await bx("language");
        const lista = Array.isArray(ls.body) ? ls.body as { id: number; iso_639_1?: string }[] : [];
        languageId = lista.find((l) => String(l.iso_639_1).toLowerCase() === langLead)?.id;
      }
      const calle = String(doc.client_address || "").trim();
      const nuevoContacto: Record<string, unknown> = {
        contact_type_id: empresa ? 1 : 2,
        name_1: (empresa || persona || email || "Sin nombre").slice(0, 255),
        name_2: empresa ? persona.slice(0, 255) : "",
        mail: email || undefined,
        phone_fixed: String(doc.client_phone || lead?.phone || "").slice(0, 50) || undefined,
        postcode: (String(doc.client_zip_city || "").match(/\b\d{4,5}\b/) || [])[0] || undefined,
        city: String(doc.client_zip_city || "").replace(/\b\d{4,5}\b/, "").trim().slice(0, 255) || undefined,
        country_id: countryId,          // deducido; si no se pudo, va vacío a propósito
        language_id: languageId,        // el idioma con el que ya le hablamos
        url: dominio ? "https://" + dominio : undefined,
        user_id: BX.user_id, owner_id: BX.user_id,
        remarks: calle ? ("Dirección: " + calle).slice(0, 255) : undefined,
      };
      // bexio rechaza el POST entero si viaja una clave en undefined
      Object.keys(nuevoContacto).forEach((k) => { if (nuevoContacto[k] === undefined) delete nuevoContacto[k]; });
      if (dry) contactId = -1;
      else {
        const cr = await bx("contact", { method: "POST", body: JSON.stringify(nuevoContacto) });
        if (!cr.ok) return json({ error: "no se pudo crear el contacto en bexio", status: cr.status, detalle: cr.body, enviado: nuevoContacto }, 502);
        contactId = (cr.body as { id: number }).id;
        contactoCreado = true;
      }
    }

    // ---------- 4. la factura ----------
    const hoy = new Date();
    const vence = new Date(hoy.getTime() + 30 * 864e5);
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    const payload = {
      title: titulo, contact_id: contactId, user_id: BX.user_id,
      language_id: BX.language_id, bank_account_id: BX.bank_account_id,
      currency_id: BX.currency_id, payment_type_id: BX.payment_type_id,
      header: tramos[0].header, footer: "",
      mwst_type: BX.mwst_type, mwst_is_net: BX.mwst_is_net, show_position_taxes: false,
      is_valid_from: iso(hoy), is_valid_to: iso(vence),
      api_reference: `viven-${tipo}-${docId}-${pct}`,
      positions: posiciones.map((p) => ({
        type: "KbPositionCustom", text: p.text, amount: String(p.amount),
        unit_price: String(p.unit_price), unit_id: BX.unit_id,
        tax_id: taxId, account_id: BX.account_id, discount_in_percent: "0",
      })),
    };

    if (dry) {
      return json({ ok: true, dry_run: true, contacto_existente: contactId !== -1,
        contacto_id: contactId === -1 ? null : contactId,
        se_crearia_contacto: contactId === -1,
        candidatos,
        cliente: { empresa, persona, email },
        total_documento: Math.round(totalDoc * 100) / 100,
        iva: { sin_iva: sinIva, pct: sinIva ? 0 : IVA_ESPERADO, tax_id: taxId,
               sugerido_por_pais: body.iva === undefined && sugerirSinIva,
               pais_contacto: paisContacto, hay_tasa_export: !!taxSinIva },
        pct, importe_a_facturar: tramos[0].importe,
        facturas: tramos.map((t) => ({ etiqueta: t.etiqueta || "Factura completa", importe: t.importe })),
        posiciones: posiciones.map((p) => ({ texto: p.text.replace(/<[^>]+>/g, " ").trim().slice(0, 70), cantidad: p.amount, precio: p.unit_price })),
      });
    }

    const creadas: { etiqueta: string; numero: string; bexio_id: number; total: string }[] = [];
    for (const t of tramos) {
      const cuerpo = { ...payload, header: t.header,
        api_reference: `viven-${tipo}-${docId}-${t.suf ? t.suf.replace(/[^a-z0-9]/gi, "") : "full"}`,
        positions: t.posiciones.map((p) => ({
          type: "KbPositionCustom", text: p.text, amount: String(p.amount),
          unit_price: String(p.unit_price), unit_id: BX.unit_id,
          tax_id: taxId, account_id: BX.account_id, discount_in_percent: "0",
        })) };
      const cr = await bx("kb_invoice", { method: "POST", body: JSON.stringify(cuerpo) });
      if (!cr.ok) {
        /* Si la segunda falla, la primera YA existe: hay que decirlo, no fingir que
           no pasó nada. Con el número en la mano él sabe qué quedó y qué falta. */
        return json({ error: "bexio rechazó la factura" + (creadas.length ? " del saldo (la primera SÍ se creó)" : ""),
          status: cr.status, detalle: cr.body, creadas }, 502);
      }
      const inv = cr.body as { id: number; document_nr: string; total: string; total_net: string };
      creadas.push({ etiqueta: t.etiqueta || "Factura completa", numero: inv.document_nr, bexio_id: inv.id, total: inv.total });

      /* Queda registrada de nuestro lado para saber qué ya se facturó. El número es
         el de BEXIO: acá no se numera nada. */
      await service.from("invoices").insert({
        offer_id: tipo === "oferta" ? docId : null,
        lead_id: doc.lead_id ?? null,
        number: inv.document_nr,
        client_company: empresa, client_contact: persona, client_email: email,
        title: titulo + t.suf,
        items: t.posiciones,
        /* net y gross son NOT NULL en la tabla: `Number(x) || null` convertía un 0
           legítimo en null y el insert se caía en silencio. Y el vat_rate por defecto
           es 8,1 — para los clientes extranjeros sin IVA el registro local decía 8,1%
           mientras bexio decía 0%. (Sebastián: "algunos clientes son sin IVA ya que
           son extranjeros".) */
        net: Number.isFinite(Number(inv.total_net)) ? Number(inv.total_net) : 0,
        gross: Number.isFinite(Number(inv.total)) ? Number(inv.total) : 0,
        vat_rate: sinIva ? 0 : IVA_ESPERADO,
        status: "draft", issued_at: new Date().toISOString(), due_date: iso(vence),
      }).then((r) => { if (r.error) console.error("no se pudo registrar la factura local:", r.error.message); },
              (e) => { console.error("no se pudo registrar la factura local:", String(e)); });
      /* Si el registro local falla la factura en bexio YA existe, así que no se corta
         el flujo — pero queda en el log en vez de desaparecer sin dejar rastro. */
    }

    return json({ ok: true, creadas, contacto_id: contactId, contacto_creado: contactoCreado, pct,
      iva: { sin_iva: sinIva, pct: sinIva ? 0 : IVA_ESPERADO } });

  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
