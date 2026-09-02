// Supabase Edge Function: newsletter-send
// Envía una campaña de newsletter al segmento elegido (estado × idioma) vía
// Resend. Reglas duras: nunca a dados de baja, nunca a emails de test, dedupe
// por email. Modo test: { id, test_to } manda SOLO a esa dirección.
//
// MAQUINARIA (rediseño 2026-07): el envío ya NO va de a un email con setTimeout
// (que superaba 3x el rate limit de Resend y fallaba en silencio con 429). Ahora:
//   • Resend BATCH API (hasta 100 emails por request), ≤2 requests/segundo.
//   • Reintento con backoff exponencial en 429 y 5xx (nunca falla en silencio).
//   • IDEMPOTENCIA: antes de enviar se cargan los emails ya registrados en
//     newsletter_sends para esta campaña y se SALTAN → un envío cortado a la
//     mitad se retoma sin duplicar a nadie (respaldado por el índice único
//     newsletter_sends_uniq de la migración 0075).
//   • Cada email sale con tag {name:"nl_id", value:<id>} para que el webhook
//     resend-events estampe apertura/click, y con todos los links auto-taggeados
//     utm_source=newsletter&utm_campaign=nl-<id> para la atribución de ventas.
//   • Bloques de contenido (nl.blocks): si hay, se renderizan en orden; si no,
//     se cae al bodyHtml(nl.body) de siempre.
//
// NUEVO (0114): también envía la edición mensual automática — { issue_id }
// manda el issue aprobado de newsletter_issues a TODOS los suscriptores
// elegibles, cada uno EN SU idioma (EN/DE/ES, fallback EN), con el mismo
// wrapper, link de baja, batch API, reintentos e idempotencia (índice único
// parcial (issue_id,email)). { issue_id, test_to } manda solo un preview.
// El envío real de un issue SIEMPRE requiere usuario logueado del dashboard
// (la aprobación es humana — se registra en approved_by); el service role NO
// alcanza a propósito: ningún cron puede disparar la edición mensual.
//
// Deploy:  supabase functions deploy newsletter-send --no-verify-jwt
// Usa:     RESEND_API_KEY (ya seteado), SERVICE_ROLE para leer leads.

import { RE_LINK } from "../_shared/autolink.ts";
import { enHorarioLaboral, proximoHorarioLaboral, HORARIO_LABEL } from "../_shared/horario.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const service = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const RESEND = Deno.env.get("RESEND_API_KEY")!;
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};


/* Registrar un envío en newsletter_sends. Hasta el 2 sep 2026 el upsert iba sin
   mirar el error: los 44 envíos de la edición 2026-09 fallaron al registrarse
   (42P10: el índice era parcial y el ON CONFLICT no lo encontraba) y la tabla
   quedó en cero sin que nadie lo viera. Ahora el error se loguea y vuelve en la
   respuesta como `no_registrados`, que el dashboard muestra. */
type FilaEnvio = Record<string, unknown>;
async function registrar(rows: FilaEnvio[], onConflict: string, ctx: string): Promise<number> {
  if (!rows.length) return 0;
  const { error } = await service.from("newsletter_sends").upsert(rows, { onConflict, ignoreDuplicates: true });
  if (!error) return 0;
  console.error("NL_REGISTRO_FALLO", ctx, error.code, error.message, "emails:", rows.map((r) => r.email).join(","));
  return rows.length;
}
/* Fuera del horario laboral suizo NO se manda — ni a uno ni a mil. La respuesta
   trae `proximo` para que el dashboard ofrezca programarlo ahí mismo. Va con
   200 a propósito: con un 4xx, supabase.functions.invoke le esconde el cuerpo
   al dashboard y solo llega "non-2xx status code". */
function fueraDeHorario() {
  const ahora = new Date();
  if (enHorarioLaboral(ahora)) return null;
  const proximo = proximoHorarioLaboral(ahora);
  console.error("NL_FUERA_DE_HORARIO", ahora.toISOString(), "proximo:", proximo.toISOString());
  return json({ error: "fuera de horario: " + HORARIO_LABEL, fuera_de_horario: true, proximo: proximo.toISOString(), horario: HORARIO_LABEL });
}
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

async function unsubToken(id: string | number): Promise<string> {
  const data = new TextEncoder().encode(String(id) + "|" + RESEND.slice(0, 24));
  const h = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 24);
}

const esc = (x: string) => String(x || "").replace(/&/g, "&amp;").replace(/</g, "&lt;");

// añade utm_source/utm_campaign a un href respetando query strings existentes
function addUtm(url: string, nlId: string | number): string {
  const u = String(url || "").trim();
  if (!u || u.startsWith("mailto:") || u.startsWith("#")) return u;
  const tag = "utm_source=newsletter&utm_campaign=nl-" + nlId;
  const [base, hash] = u.split("#");
  const joined = base + (base.includes("?") ? "&" : "?") + tag;
  return hash ? joined + "#" + hash : joined;
}

function bodyHtml(text: string, nlId: string | number): string {
  return String(text || "").trim().split(/\n{2,}/).map((par) => {
    /* Mismo autolink que los otros emails: los dominios pelados también son links.
       Acá además pasan por addUtm para poder medir qué newsletter trajo la visita. */
    const withLinks = esc(par).replace(RE_LINK, (m: string) => {
      let cola = "";
      const fin = m.match(/[.,;:!?]+$/);
      if (fin) { cola = fin[0]; m = m.slice(0, -cola.length); }
      if (/^[a-z0-9._%+-]+@/i.test(m)) return `<a href="mailto:${m}" style="color:#5b7cfa">${m}</a>` + cola;
      const url = /^https?:\/\//i.test(m) ? m : "https://" + m;
      return `<a href="${addUtm(url, nlId)}" style="color:#5b7cfa">${m}</a>` + cola;
    }).replace(/\n/g, "<br>");
    return `<p style="margin:0 0 16px;font-size:15px;line-height:1.65;color:#222">${withLinks}</p>`;
  }).join("");
}

// URL de destino de un botón CTA según su tipo y el idioma del destinatario
const CALC_URL: Record<string, string> = {
  en: "https://www.viven.ch/en/video-cost-calculator",
  de: "https://www.viven.ch/de/videoproduktion-kosten-rechner",
  es: "https://www.viven.ch/es/calculadora-costos-video",
};
function ctaDest(dest: string, lang: string): string {
  if (dest === "calculator") return CALC_URL[lang] || CALC_URL.en;
  if (dest === "brief") return "https://www.viven.ch/brief/";
  if (dest === "call") return "https://www.viven.ch/book/";
  return dest || "https://www.viven.ch";   // custom URL
}

// Render de los bloques ordenados al HTML del email (entre saludo y firma).
type Block = { type: string; [k: string]: unknown };
function blocksHtml(blocks: Block[], lang: string, nlId: string | number): string {
  const out: string[] = [];
  for (const b of blocks || []) {
    if (!b || !b.type) continue;
    if (b.type === "text") {
      out.push(bodyHtml(String(b.text || ""), nlId));
    } else if (b.type === "video") {
      const url = addUtm(String(b.url || "https://www.viven.ch"), nlId);
      const thumb = esc(String(b.thumb || ""));
      const title = esc(String(b.title || "Ver el video"));
      out.push(
        `<div style="margin:18px 0;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb">` +
        `<a href="${url}" style="text-decoration:none;color:inherit;display:block"><div style="position:relative">` +
        (thumb
          ? `<img src="${thumb}" alt="${title}" width="548" style="display:block;width:100%;height:auto" />`
          : `<div style="width:100%;height:0;padding-bottom:56.25%;background:#16233a"></div>`) +
        `<div style="position:absolute;top:0;left:0;right:0;bottom:0;display:flex;align-items:center;justify-content:center">` +
        `<span style="width:56px;height:56px;border-radius:50%;background:rgba(255,255,255,.92);color:#0f1826;font-size:22px;line-height:56px;text-align:center;display:inline-block">&#9654;</span>` +
        `</div></div>` +
        `<div style="background:#f4f5f7;padding:9px 13px;font-size:13px;color:#555"><b style="color:#222">${title}</b></div>` +
        `</a></div>`
      );
    } else if (b.type === "still") {
      const src = esc(String(b.src || ""));
      if (!src) continue;
      const cap = esc(String(b.caption || ""));
      out.push(
        `<div style="margin:18px 0"><img src="${src.startsWith("http") ? src : "https://www.viven.ch" + src}" alt="${cap}" width="548" style="display:block;width:100%;height:auto;border-radius:12px" />` +
        (cap ? `<div style="font-size:12px;color:#888;margin-top:6px;text-align:center">${cap}</div>` : "") +
        `</div>`
      );
    } else if (b.type === "cta") {
      const href = addUtm(ctaDest(String(b.dest || "call"), lang), nlId);
      const label = esc(String(b.label || "Más info →"));
      out.push(
        `<div style="text-align:center;margin:22px 0">` +
        `<a href="${href}" style="background:#0f1826;color:#ddf98f;border-radius:100px;padding:13px 26px;font-size:14px;font-weight:700;text-decoration:none;display:inline-block">${label}</a>` +
        `</div>`
      );
    } else if (b.type === "case") {
      const url = addUtm(String(b.url || "https://www.viven.ch"), nlId);
      const thumb = esc(String(b.thumb || ""));
      const title = esc(String(b.title || "Case study"));
      out.push(
        `<a href="${url}" style="text-decoration:none;color:inherit;display:block;margin:18px 0;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden">` +
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse"><tr>` +
        (thumb ? `<td width="120" style="width:120px"><img src="${thumb.startsWith("http") ? thumb : "https://www.viven.ch" + thumb}" alt="${title}" width="120" style="display:block;width:120px;height:auto;object-fit:cover" /></td>` : "") +
        `<td style="padding:12px 14px;vertical-align:middle"><div style="font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:#8a919e">Case study</div><div style="font-size:14px;font-weight:700;color:#222;margin-top:3px">${title}</div><div style="font-size:12px;color:#5b7cfa;margin-top:5px">Ver el caso →</div></td>` +
        `</tr></table></a>`
      );
    }
  }
  return out.join("");
}

const UNSUB_LABEL: Record<string, string> = { en: "Unsubscribe", de: "Abmelden", es: "Darse de baja" };

// Saludo por idioma. REGLA DURA (misma que 0089/0111): en DE jamás nombre de
// pila ni du — "Guten Tag" formal a secas (no tenemos apellido/género
// confiables en leads). EN/ES sí con nombre de pila si existe.
function greeting(lang: string, firstName: string): string {
  if (lang === "de") return `<p style="margin:0 0 16px;font-size:15px;color:#222">Guten Tag</p>`;
  if (!firstName) return "";
  const hi = lang === "es" ? "Hola" : "Hi";
  return `<p style="margin:0 0 16px;font-size:15px;color:#222">${hi} ${esc(firstName)},</p>`;
}

// wrapper compartido (header navy + logo, tarjeta blanca, footer con baja de
// un click) — el mismo look para campañas manuales y la edición mensual
/* Firma del equipo, NO de una persona. Misma decisión que ya estaba aplicada en
   newsletter-welcome desde el 22 ago 2026 y que faltaba acá: si firma Sofia, la
   respuesta cae en una casilla personal y quien contesta queda esperando a alguien
   que quizás no está. Las tres redacciones son las mismas que usa la bienvenida. */
const FIRMA: Record<string, string> = {
  en: "— The VIVEN team",
  de: "— Ihr VIVEN Team",
  es: "— El equipo de VIVEN",
};
function wrapEmail(inner: string, unsub: string, lang: string): string {
  return `<!doctype html><body style="margin:0;background:#f4f5f7;font-family:Helvetica,Arial,sans-serif">
<div style="max-width:600px;margin:0 auto;padding:28px 16px">
  <div style="background:#0f1826;border-radius:14px 14px 0 0;padding:18px 26px"><img src="https://www.viven.ch/assets/brand/viven-logo-email.png" alt="VIVEN" height="24" style="height:24px;width:auto;display:block" /></div>
  <div style="background:#ffffff;border-radius:0 0 14px 14px;padding:30px 26px">
    ${inner}
    <p style="margin:22px 0 0;font-size:14px;color:#444">${FIRMA[lang] || FIRMA.en}</p>
  </div>
  <p style="text-align:center;font-size:11.5px;color:#9aa;margin-top:16px">VIVEN AG · Zürich · <a href="https://www.viven.ch" style="color:#9aa">viven.ch</a> · <a href="${unsub}" style="color:#9aa">${UNSUB_LABEL[lang] || UNSUB_LABEL.en}</a></p>
</div></body>`;
}

// POST a Resend con reintentos en 429/5xx (backoff exponencial). Devuelve la
// respuesta final (ok o no) para que el caller cuente el resultado.
async function resendPost(path: string, payload: unknown, attempts = 4): Promise<Response> {
  let res!: Response;
  for (let i = 0; i < attempts; i++) {
    res = await fetch("https://api.resend.com" + path, {
      method: "POST",
      headers: { Authorization: "Bearer " + RESEND, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (res.ok) return res;
    if (res.status !== 429 && res.status < 500) return res;   // error no recuperable → devolver
    if (i < attempts - 1) await new Promise((ok) => setTimeout(ok, 700 * Math.pow(2, i)));   // 700ms, 1.4s, 2.8s
  }
  return res;
}

/* ÚNICA fuente de verdad de a quién le llega el newsletter. Antes esta selección
   estaba copiada en los dos caminos (issue mensual y campaña suelta): así es como
   el número que ves en pantalla y el que realmente se manda terminan separándose.
   El panel "quién lo recibe" del dashboard llama exactamente a esto, en modo
   preview, para que lo mostrado sea lo enviado. (Pedido de Sebastián, 11 ago 2026:
   no podía ver ni quién lo recibe, ni en qué idioma, ni a qué hora sale.) */
/* EL NEWSLETTER NO FILTRA DIRECCIONES: LO RECIBEN TODOS.
   Decisión de Sebastián, 12 ago 2026 — explícita, después de ver el problema.
   Historia corta de por qué el filtro se fue del todo:
     · era /@example\.|test/i — "test" como palabra suelta, en CUALQUIER posición.
       Eso dejaba afuera para siempre y en silencio a direcciones reales y
       plausibles: testimonios@empresa.ch, protest@…, contest@… — y Viven
       justamente vende videos de testimonios.
     · el 11-12 ago ya habían salido @viven.ch y @entropia del mismo saco, porque
       son casillas reales de gente real.
     · lo acoté a ^test@ y @test., y al medirlo contra la base real el filtro no
       estaba bloqueando a NADIE (0 direcciones). O sea: costo real de perder
       clientes en silencio, beneficio cero.
   Así que se saca. Quedan solo las exclusiones que son reglas de verdad y no
   adivinanzas sobre si una casilla existe: dados de baja, spam/descartado y
   duplicados.
   CONTRAPARTIDA ACEPTADA: si alguien carga a mano un @example.com o un test@,
   ese email va a bouncear, y los bounces le bajan reputación al dominio en
   Resend. Se banca: es preferible a perder un cliente sin enterarse.
   VALE SOLO PARA EL NEWSLETTER. Los emails 1:1 automáticos a leads
   (automations-run, reactivation-engine, deal-followup-later, review-request,
   bexio-import-clients) siguen filtrando lo interno y las de prueba — mandarle al
   equipo una secuencia de venta no tiene sentido. Si algún día se quiere sacar
   también ahí, es una decisión aparte. */
/* GRUPO "FOLLOW UP" — los clientes importados de bexio NO reciben el newsletter.
   Decisión de Sebastián, 12 ago 2026: "hace tiempo no escuchan nada nuestro".
   Medido ese día contra la base real: de 186 destinatarios, 168 (el 90%) venían de
   channel='bexio-import' — clientes viejos sacados de facturas pagadas el 25 jul,
   que nunca recibieron un email de Viven. Mandarles un newsletter de golpe es la
   forma más rápida de juntar quejas de spam y quemar la reputación del dominio en
   Resend, y de paso arruinar la entrega para los 18 contactos que sí nos conocen.
   Siguen en la base y visibles como grupo aparte (segmento "followup") para
   trabajarlos con una reactivación pensada, no con el newsletter. */
const esFollowUp = (canal: string) => /bexio/i.test(canal || "");
const isOutSt = (st: string) => /spam|descartado/i.test(st || "");
const isWonSt = (st: string) => /ganado|won|cerrado/i.test(st || "");

type Recip = { id?: number; email: string; name?: string; lang?: string; manual?: boolean; equipo?: boolean };

/* EL EQUIPO SIEMPRE RECIBE. Sebastián quiere ver con sus propios ojos lo que sale
   afuera, en cada campaña. Sacar @viven.ch del filtro de direcciones falsas (los
   commits del 11-12 ago) era necesario pero no alcanzaba: verificado contra la
   base real el 12 ago, NO HAY ningún lead @viven.ch ni @entropia — el newsletter
   salía a 186 personas y a él no le llegaba. Así que las direcciones del equipo se
   agregan siempre, no dependen de que alguien esté cargado como lead.
   Editable sin tocar código: app_settings.key='newsletter' → {"always_to":[...]}.
   El default son las dos casillas que el sistema YA usa para mandar (el From y el
   Reply-To de estos mismos emails), o sea que existen con seguridad. */
const EQUIPO_DEFAULT = ["info@viven.ch", "sofia@viven.ch"];
// deno-lint-ignore no-explicit-any
async function equipoSiempre(service: any): Promise<string[]> {
  try {
    const { data } = await service.from("app_settings").select("value").eq("key", "newsletter").maybeSingle();
    const lista = (data?.value ?? {}).always_to;
    if (Array.isArray(lista)) {
      // [] a propósito = apagado; sin la clave = default
      return lista.map((x: unknown) => String(x || "").toLowerCase().trim()).filter((x: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x));
    }
  } catch { /* sin la tabla o sin la fila: el default */ }
  return EQUIPO_DEFAULT;
}
/* seg = todo lo que la campaña decide sobre su lista: etapa, idioma, la gente
   destildada a mano (exclude_ids) y los emails sueltos agregados (extra_emails).
   El preview TIENE que respetarlo entero: si no, muestra "todos" y después sale a
   un subconjunto. Sin seg (edición mensual) = toda la base elegible. */
type Seg = { stage?: string; lang?: string; exclude_ids?: (number | string)[]; exclude_emails?: string[]; extra_emails?: string[] };
// deno-lint-ignore no-explicit-any -- el fallback de re-select cambia el shape
async function elegirDestinatarios(service: any, seg?: Seg) {
  const fuera = { duplicados: 0, baja: 0, descartados: 0, fueraDeSegmento: 0, sacadosAMano: 0, followUp: 0 };
  // deno-lint-ignore no-explicit-any
  let q: any = await service.from("leads").select("id,email,name,first_name,status,lang,unsubscribed,channel").not("email", "is", null);
  if (q.error && /column/.test(q.error.message || "")) q = await service.from("leads").select("id,email,name,first_name,status,lang").not("email", "is", null);
  const excl = new Set((seg?.exclude_ids || []).map(String));
  /* destildados por DIRECCIÓN (0122). Vale para todos: los del segmento, los
     agregados a mano y las casillas del equipo — esas no tienen lead_id, así que
     exclude_ids no las alcanzaba y quedaban fijas sin check. */
  const exclEm = new Set((seg?.exclude_emails || []).map((x) => String(x || "").toLowerCase().trim()).filter(Boolean));
  const seen = new Set<string>();
  const recips: Recip[] = [];
  const sacados: Recip[] = [];   // destildados a mano: se devuelven para poder re-tildarlos
  const fila = (r: Record<string, string | number | boolean>, em: string): Recip => ({
    id: r.id as number, email: em,
    name: String((r as { first_name?: string }).first_name || String(r.name || "").split(" ")[0] || ""),
    lang: String(r.lang || "en"),
  });
  for (const r of (q.data ?? []) as Record<string, string | number | boolean>[]) {
    const em = String(r.email || "").toLowerCase().trim();
    if (!em) continue;
    if (seen.has(em)) { fuera.duplicados++; continue; }
    if ((r as { unsubscribed?: boolean }).unsubscribed) { fuera.baja++; continue; }
    const st = String(r.status || "");
    if (isOutSt(st)) { fuera.descartados++; continue; }
    const canal = String((r as { channel?: string }).channel || "");
    if (seg?.stage === "followup") {
      // el grupo Follow up es EXACTAMENTE lo contrario: solo los de bexio
      if (!esFollowUp(canal)) { fuera.fueraDeSegmento++; continue; }
    } else if (esFollowUp(canal)) {
      fuera.followUp++; continue;   // ningún otro segmento los incluye
    }
    if (seg) {
      if (seg.stage === "won" && !isWonSt(st)) { fuera.fueraDeSegmento++; continue; }
      if (seg.stage === "open" && isWonSt(st)) { fuera.fueraDeSegmento++; continue; }
      if (seg.lang && seg.lang !== "all" && String(r.lang || "en") !== seg.lang) { fuera.fueraDeSegmento++; continue; }
      // igual que antes: un excluido NO consume su email — si dos leads comparten
      // dirección y sacás uno, el otro sigue recibiendo
      if (excl.has(String(r.id)) || exclEm.has(em)) { fuera.sacadosAMano++; sacados.push(fila(r, em)); continue; }
    }
    seen.add(em);
    recips.push(fila(r, em));
  }
  // emails sueltos agregados a mano en "Ver / editar lista" + el equipo, que va
  // siempre (ver equipoSiempre). Mismo camino: si ya están arriba no se duplican,
  // y la baja sigue mandando.
  const delEquipo = new Set(await equipoSiempre(service));
  for (const raw of [...(seg?.extra_emails || []), ...delEquipo]) {
    const em = String(raw || "").toLowerCase().trim();
    if (!em || seen.has(em) || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) continue;
    // deno-lint-ignore no-explicit-any -- el fallback de re-select cambia el shape
    let mq: any = await service.from("leads").select("id,first_name,name,lang,unsubscribed").ilike("email", em).maybeSingle();
    if (mq.error && /column/.test(mq.error.message || "")) mq = await service.from("leads").select("id,first_name,name,lang").ilike("email", em).maybeSingle();
    const m = mq.data;
    /* LA BAJA MANDA SIEMPRE, incluso acá. Antes un email tipeado a mano se
       agregaba sin mirar nada: alcanzaba con escribir la dirección de alguien que
       se había dado de baja para volver a mandarle. Es la única regla que no
       admite "pero lo puse a propósito". (12 ago 2026) */
    if (m?.unsubscribed) { fuera.baja++; continue; }
    // destildado a mano en el panel: vale también para el equipo
    if (exclEm.has(em)) {
      fuera.sacadosAMano++;
      sacados.push({ id: m?.id, email: em, name: String(m?.first_name || String(m?.name || "").split(" ")[0] || ""), lang: String(m?.lang || "en"), manual: true, equipo: delEquipo.has(em) });
      continue;
    }
    seen.add(em);
    recips.push({ id: m?.id, email: em, name: String(m?.first_name || String(m?.name || "").split(" ")[0] || ""), lang: String(m?.lang || "en"), manual: true, equipo: delEquipo.has(em) });
  }
  const porIdioma: Record<string, number> = { en: 0, de: 0, es: 0 };
  for (const r of recips) porIdioma[["en", "de", "es"].includes(r.lang || "") ? r.lang! : "en"]++;
  return { recips, fuera, porIdioma, sacados };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    // fix CRÍTICO (auditoría 2026-07-14): el gate anterior confiaba en un campo
    // `internal:true` MANDADO POR EL CALLER en el body — cualquiera podía forjarlo
    // y disparar el envío real de una campaña a todo el segmento de leads, o filtrar
    // el contenido de un borrador a cualquier email vía `test_to`, sin login. El
    // dispatcher real (newsletter-dispatch) manda el SERVICE ROLE KEY real como
    // Authorization — eso es lo único que no se puede forjar sin tener el secret.
    const auth = req.headers.get("Authorization") ?? "";
    const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    /* El cron_secret vale igual que la service role para las llamadas internas: la
       service role legacy dejó de entrar a las functions (pasó con varias este mes) y
       sin esto no hay forma de verificar el render desde fuera del navegador. */
    const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";
    const isInternal = (!!SERVICE_ROLE_KEY && auth === `Bearer ${SERVICE_ROLE_KEY}`)
      || (!!CRON_SECRET && auth === `Bearer ${CRON_SECRET}`);
    let user: { id: string; email?: string } | null = null;
    if (!isInternal) {
      const supabase = createClient(SB_URL, SB_ANON, { global: { headers: { Authorization: auth } } });
      ({ data: { user } } = await supabase.auth.getUser());
    }
    const bodyReq = await req.json();
    const { id, test_to, mark_sent, issue_id } = bodyReq;
    let noReg = 0;   // envíos que salieron pero NO quedaron registrados (ver registrar())

    /* ---- RECONSTRUIR el registro de una edición desde Resend -------------------
       El 2 sep 2026 la edición 2026-09 salió a 44 personas y newsletter_sends quedó
       en CERO (42P10 en cada tanda, sin mirar el error). Sin esas filas no hay
       aperturas ni clicks, y Sebastián no puede saber si mandar tiene sentido.
       Resend guarda cada email con su último evento: de ahí se rearma la tabla.
       Se identifica el envío por ventana de tiempo (sent_at → +15 min), remitente
       y asunto de la edición (en/de/es). { reconstruir: issue_id, dry_run?: true }
       Con dry_run no escribe nada: devuelve qué encontró. */
    if (bodyReq.reconstruir) {
      const issueId = String(bodyReq.reconstruir);
      const { data: issue } = await service.from("newsletter_issues").select("id,sent_at,content").eq("id", issueId).maybeSingle();
      if (!issue?.sent_at) return json({ error: "issue sin sent_at" }, 400);
      const content = (issue.content ?? {}) as Record<string, { subject?: string }>;
      const asuntos = new Set(["en", "de", "es"].map((l) => content[l]?.subject).filter(Boolean));
      const t0 = new Date(issue.sent_at).getTime() - 2 * 60e3, t1 = t0 + 17 * 60e3;
      const fecha = (x: unknown) => new Date(String(x || "").replace(" ", "T").replace(/([+-]\d\d)$/, "$1:00")).getTime();
      type Em = { id: string; to: string[] | string; from?: string; subject?: string; created_at: string; last_event?: string };
      const hallados: Em[] = [];
      let after = "", paginas = 0, vistos = 0;
      while (paginas++ < 40) {
        const r = await fetch("https://api.resend.com/emails?limit=100" + (after ? "&after=" + after : ""), { headers: { Authorization: `Bearer ${RESEND}` } });
        if (!r.ok) return json({ error: "resend " + r.status + " " + (await r.text()).slice(0, 200) }, 502);
        const out = await r.json();
        const data: Em[] = out?.data || [];
        vistos += data.length;
        for (const e of data) {
          const ts = fecha(e.created_at);
          if (ts >= t0 && ts <= t1 && asuntos.has(e.subject || "") && /info@viven\.ch/i.test(e.from || "")) hallados.push(e);
        }
        const ultimo = data[data.length - 1];
        if (!out?.has_more || !ultimo || ultimo.id === after) break;
        if (fecha(ultimo.created_at) < t0) break;        // la lista viene del más nuevo al más viejo
        after = ultimo.id;
      }
      // una fila por email (Resend lista cada envío individual del batch)
      const porEmail = new Map<string, Em>();
      for (const e of hallados) {
        const em = String(Array.isArray(e.to) ? e.to[0] : e.to).toLowerCase().trim();
        if (em && !porEmail.has(em)) porEmail.set(em, e);
      }
      const ahora = new Date().toISOString();
      const rows: FilaEnvio[] = [];
      for (const [em, e] of porEmail) {
        const { data: lead } = await service.from("leads").select("id").ilike("email", em).maybeSingle();
        const ev = String(e.last_event || "");
        rows.push({ issue_id: issueId, lead_id: lead?.id ?? null, email: em, resend_id: e.id,
          opened_at: ev === "opened" || ev === "clicked" ? ahora : null, clicked_at: ev === "clicked" ? ahora : null });
      }
      const resumen = {
        ok: true, dry_run: !!bodyReq.dry_run, paginas_resend: paginas, emails_vistos: vistos, hallados: hallados.length, personas: rows.length,
        abiertos: rows.filter((r) => r.opened_at).length, clicks: rows.filter((r) => r.clicked_at).length,
        eventos: [...porEmail.values()].reduce((a, e) => { a[e.last_event || "?"] = (a[e.last_event || "?"] || 0) + 1; return a; }, {} as Record<string, number>),
        emails: rows.map((r) => r.email),
      };
      if (bodyReq.dry_run) return json(resumen);
      const noRegistrados = await registrar(rows, "issue_id,email", "reconstruir " + issueId);
      const { count } = await service.from("newsletter_sends").select("*", { count: "exact", head: true }).eq("issue_id", issueId);
      await service.from("newsletter_issues").update({ sent_count: count ?? rows.length, updated_at: ahora }).eq("id", issueId);
      return json({ ...resumen, no_registrados: noRegistrados, en_tabla: count });
    }
    if (!user && !isInternal) return json({ error: "unauthorized" }, 401);

    /* ---- PREVIEW: quién lo recibe, en qué idioma (NO MANDA NADA) -------------
       El contador del panel de envío, el KPI "Suscriptos" y la lista de
       "Ver / editar lista" del dashboard salen todos de acá. El punto es que el
       número que Sebastián ve es, por construcción, el que sale: lo calcula
       elegirDestinatarios(), la misma función que abajo alimenta el envío real.
       Antes el dashboard tenía su propia copia del filtro en JavaScript y ya
       estaba dando otro número (excluía @viven.ch y @entropia, que sí reciben).
       Se puede pedir con { preview:true, id } (usa el segmento guardado de la
       campaña) o con el segmento explícito, para que el contador se actualice
       mientras se toca el selector sin tener que guardar el borrador. */
    if (bodyReq.preview) {
      const seg: Seg = {
        stage: bodyReq.segment_stage, lang: bodyReq.segment_lang,
        exclude_ids: bodyReq.exclude_ids, exclude_emails: bodyReq.exclude_emails,
        extra_emails: bodyReq.extra_emails,
      };
      // preview de una edición mensual: { preview:true, issue_id }
      if (issue_id && (seg.stage === undefined || seg.lang === undefined)) {
        const { data: isp } = await service.from("newsletter_issues")
          .select("segment_stage,segment_lang,exclude_ids,exclude_emails,extra_emails").eq("id", issue_id).maybeSingle();
        if (isp) {
          seg.stage = seg.stage ?? isp.segment_stage;
          seg.lang = seg.lang ?? isp.segment_lang;
          seg.exclude_ids = seg.exclude_ids ?? isp.exclude_ids ?? [];
          seg.exclude_emails = seg.exclude_emails ?? isp.exclude_emails ?? [];
          seg.extra_emails = seg.extra_emails ?? isp.extra_emails ?? [];
        }
      }
      if (id && (seg.stage === undefined || seg.lang === undefined)) {
        const { data: nlp } = await service.from("newsletters")
          .select("segment_stage,segment_lang,exclude_ids,exclude_emails,extra_emails").eq("id", id).maybeSingle();
        if (nlp) {
          seg.stage = seg.stage ?? nlp.segment_stage;
          seg.lang = seg.lang ?? nlp.segment_lang;
          seg.exclude_ids = seg.exclude_ids ?? nlp.exclude_ids ?? [];
          seg.exclude_emails = seg.exclude_emails ?? nlp.exclude_emails ?? [];
          seg.extra_emails = seg.extra_emails ?? nlp.extra_emails ?? [];
        }
      }
      const { recips, fuera, porIdioma, sacados } = await elegirDestinatarios(service, seg);
      return json({
        preview: true,
        total: recips.length,          // exactamente lo que mandaría "Enviar ahora"
        por_idioma: porIdioma,
        fuera,                         // por qué quedó afuera cada grupo
        recips: recips.map((r) => ({ id: r.id ?? null, email: r.email, name: r.name || "", lang: ["en", "de", "es"].includes(r.lang || "") ? r.lang : "en", manual: !!r.manual, equipo: !!r.equipo })),
        sacados: sacados.map((r) => ({ id: r.id ?? null, email: r.email, name: r.name || "", lang: ["en", "de", "es"].includes(r.lang || "") ? r.lang : "en", manual: !!r.manual, equipo: !!r.equipo })),
      });
    }

    // ---- edición mensual automática (newsletter_issues, SQL 0114) ----------
    if (issue_id) {
      // aprobación SIEMPRE humana: JWT del dashboard, nunca service role/cron
      if (!user) return json({ error: "el envío de la edición mensual requiere sesión del dashboard (aprobación humana)" }, 401);
      const { data: issue } = await service.from("newsletter_issues").select("*").eq("id", issue_id).maybeSingle();
      if (!issue) return json({ error: "issue no encontrado" }, 404);
      if (issue.status === "discarded") return json({ error: "este issue fue descartado" }, 400);
      if (issue.status === "sent" && !test_to) return json({ error: "este issue ya fue enviado" }, 400);
      if (!test_to) { const fh = fueraDeHorario(); if (fh) return fh; }
      const content = (issue.content ?? {}) as Record<string, { subject?: string; html?: string }>;
      if (!content.en?.html) return json({ error: "el issue no tiene contenido EN" }, 400);

      // destinatarios: misma base y exclusiones que una campaña all/all —
      // (1) sin email fuera, (2) dedupe por email, (3) emails de test fuera,
      // (4) dados de baja fuera, (5) spam/descartados fuera
      let recips: { id?: number; email: string; name?: string; lang?: string }[] = [];
      if (test_to) {
        const { data: matchLead } = await service.from("leads").select("id,lang").ilike("email", String(test_to)).maybeSingle();
        recips = [{ email: String(test_to), id: matchLead?.id, lang: matchLead?.lang }];
      } else {
        /* La edición mensual también elige a quién (SQL 0123). Antes salía a toda
           la base sin nada que tocar; Sebastián pidió el mismo control que la
           campaña manual. Misma función, mismo significado de cada campo — no hay
           una segunda copia del filtro. */
        recips = (await elegirDestinatarios(service, {
          stage: issue.segment_stage, lang: issue.segment_lang,
          exclude_ids: issue.exclude_ids || [], exclude_emails: issue.exclude_emails || [],
          extra_emails: issue.extra_emails || [],
        })).recips;
      }
      if (!recips.length) return json({ error: "0 destinatarios elegibles" }, 400);

      const totalIss = recips.length;
      // IDEMPOTENCIA — un envío cortado se retoma sin duplicar (índice único
      // parcial newsletter_sends_issue_uniq del SQL 0114)
      let skippedIss = 0;
      if (!test_to) {
        const already = new Set<string>();
        const { data: prev } = await service.from("newsletter_sends").select("email").eq("issue_id", issue_id);
        for (const p of (prev || []) as { email: string }[]) already.add(String(p.email || "").toLowerCase());
        const before = recips.length;
        recips = recips.filter((r) => !already.has(r.email.toLowerCase()));
        skippedIss = before - recips.length;
      }

      // email completo por destinatario: contenido EN SU idioma (fallback EN)
      const buildIssue = async (r: { id?: number; email: string; name?: string; lang?: string }) => {
        const lang = ["en", "de", "es"].includes(r.lang || "") ? r.lang! : "en";
        const ct = content[lang]?.html ? content[lang] : content.en;
        const tok = r.id != null ? await unsubToken(r.id) : "";
        const unsub = r.id != null ? `${SB_URL}/functions/v1/newsletter-unsub?l=${r.id}&t=${tok}` : "https://www.viven.ch";
        return {
          from: "VIVEN <info@viven.ch>", reply_to: "info@viven.ch", to: [r.email],
          subject: ct.subject || content.en.subject || "VIVEN",
          html: wrapEmail(greeting(lang, r.name || "") + (ct.html || ""), unsub, lang),
          tags: [{ name: "issue_id", value: String(issue_id) }],   // → resend-events estampa apertura/click
        };
      };

      let sent = 0, failed = 0;
      const failedEmails: string[] = [];
      if (recips.length) {
        const BATCH = 100;
        for (let i = 0; i < recips.length; i += BATCH) {
          const chunk = recips.slice(i, i + BATCH);
          const payload = await Promise.all(chunk.map(buildIssue));
          const res = chunk.length === 1 ? await resendPost("/emails", payload[0]) : await resendPost("/emails/batch", payload);
          if (res.ok) {
            let ids: (string | null)[] = [];
            try {
              const out = await res.clone().json();
              ids = chunk.length === 1 ? [out?.id ?? null] : (out?.data || []).map((d: { id?: string }) => d?.id ?? null);
            } catch { /* ignore */ }
            sent += chunk.length;
            if (!test_to) {
              const rows = chunk.map((r, j) => ({ issue_id, lead_id: r.id ?? null, email: r.email.toLowerCase(), resend_id: ids[j] ?? null }));
              noReg += await registrar(rows, "issue_id,email", "issue " + issue_id);
            }
          } else {
            failed += chunk.length;
            for (const r of chunk) failedEmails.push(r.email);
            console.error("RESEND_ISSUE_FAIL", res.status, (await res.text()).slice(0, 200), "emails:", chunk.map((c) => c.email).join(","));
          }
          if (i + BATCH < recips.length) await new Promise((ok) => setTimeout(ok, 600));   // ≤2 req/s
        }
      }
      if (failedEmails.length) console.error("ISSUE_FAILED_EMAILS", issue_id, failedEmails.join(","));

      if (!test_to) {
        const { count } = await service.from("newsletter_sends").select("*", { count: "exact", head: true }).eq("issue_id", issue_id);
        await service.from("newsletter_issues").update({
          status: "sent", sent_at: new Date().toISOString(), sent_count: count ?? (sent + skippedIss),
          approved_by: user.email ?? "dashboard", updated_at: new Date().toISOString(),
        }).eq("id", issue_id);
      }
      return json({ ok: true, sent, failed, skipped: skippedIss, total: totalIss, test: !!test_to, issue: issue_id, no_registrados: noReg });
    }

    // ---- campañas manuales (newsletters, comportamiento original) ----------
    if (!id) return json({ error: "falta id" }, 400);

    const { data: nl } = await service.from("newsletters").select("*").eq("id", id).maybeSingle();
    if (!nl) return json({ error: "newsletter no encontrada" }, 404);
    if (nl.status === "sent" && !test_to) return json({ error: "esta campaña ya fue enviada" }, 400);
    // el envío a una persona con mark_sent también es un envío real: misma regla
    if (!test_to || mark_sent) { const fh = fueraDeHorario(); if (fh) return fh; }
    // envío real a UNA persona (mark_sent) — se registra igual que un envío completo,
    // para no perder rastro ni permitir remandar el mismo borrador a todo el segmento
    // por error. El self-test rápido ("Test a mi email") NO manda mark_sent y sigue
    // sin dejar rastro, como siempre.
    const trackThis = !test_to || mark_sent;

    // destinatarios — MISMA función que usa el preview del dashboard (ver
    // elegirDestinatarios más arriba). Esta selección estaba duplicada acá con su
    // propia copia de los filtros: por eso el número de la pantalla y el del envío
    // podían separarse. Ahora hay una sola.
    let recips: Recip[] = [];
    if (test_to) {
      const { data: matchLead } = await service.from("leads").select("id,lang").ilike("email", String(test_to)).maybeSingle();
      recips = [{ email: String(test_to), id: matchLead?.id, lang: matchLead?.lang }];
    } else {
      recips = (await elegirDestinatarios(service, {
        stage: nl.segment_stage, lang: nl.segment_lang,
        exclude_ids: nl.exclude_ids || [], exclude_emails: nl.exclude_emails || [],
        extra_emails: nl.extra_emails || [],
      })).recips;
    }
    if (!recips.length) return json({ error: "el segmento quedó vacío (0 destinatarios)" }, 400);

    const total = recips.length;
    // IDEMPOTENCIA — para un envío de segmento real, saltar los ya registrados.
    let skipped = 0;
    if (trackThis && !test_to) {
      const already = new Set<string>();
      const { data: prev } = await service.from("newsletter_sends").select("email").eq("newsletter_id", id);
      for (const p of (prev || []) as { email: string }[]) already.add(String(p.email || "").toLowerCase());
      const before = recips.length;
      recips = recips.filter((r) => !already.has(r.email.toLowerCase()));
      skipped = before - recips.length;
    }

    const useBlocks = Array.isArray(nl.blocks) && nl.blocks.length > 0;

    /* ===== TRES IDIOMAS EN EL NEWSLETTER MANUAL (SQL 0145) =====
       La edición mensual automática ya mandaba asunto y cuerpo en el idioma de cada
       persona; el manual no, así que un contacto alemán recibía "Guten Tag" y después
       texto en inglés. De los 33 destinatarios reales, 9 son DE — más de uno de cada
       cuatro.
       El orden de búsqueda es siempre el mismo y nunca deja a nadie sin email:
         1. la versión en SU idioma
         2. la versión en inglés
         3. el contenido plano de siempre (campañas viejas, que no tienen i18n)
       Se resuelve por destinatario, no una vez por campaña: en un mismo envío cada
       uno recibe lo suyo. */
    const bI18n = (nl as { blocks_i18n?: Record<string, Block[]> }).blocks_i18n || null;
    const sI18n = (nl as { subject_i18n?: Record<string, string> }).subject_i18n || null;
    const hayI18n = !!bI18n && Object.values(bI18n).some((v) => Array.isArray(v) && v.length);
    const bloquesDe = (lang: string): Block[] | null => {
      if (!bI18n) return null;
      const propio = bI18n[lang];
      if (Array.isArray(propio) && propio.length) return propio;
      const en = bI18n.en;
      return (Array.isArray(en) && en.length) ? en : null;
    };
    const asuntoDe = (lang: string): string =>
      (sI18n && (sI18n[lang] || sI18n.en)) || nl.subject || "VIVEN";

    // construye el HTML completo para un destinatario
    const buildFull = async (r: { id?: number; email: string; name?: string; lang?: string }) => {
      const lang = ["en", "de", "es"].includes(r.lang || "") ? r.lang! : "en";
      const propios = bloquesDe(lang);
      /* El orden importa y el último escalón es el que muerde:
         1. la versión del idioma de esta persona — lo correcto;
         2. los bloques planos — un solo idioma para todos, pero CON sus imágenes;
         3. `nl.body` — texto pelado, SIN imágenes ni videos ni botones.
         El tercero existe para campañas viejas que se guardaron antes de que hubiera
         bloques. El problema es que también atrapaba a las nuevas: un borrador guardado
         con cero bloques salía como un mail de texto plano y nadie entendía por qué «no
         pone imágenes». Ahora ese camino solo se toma si de verdad NO hay bloques en
         ningún lado, y queda escrito en el log para que se vea.
         (Sebastián, 2 sep 2026: "no pone imágenes".) */
      const hayAlgoConBloques = !!propios || useBlocks;
      if (!hayAlgoConBloques) {
        console.log("NL_SIN_BLOQUES", id, "sale como texto plano: sin imágenes ni CTA");
      }
      const inner = propios ? blocksHtml(propios, lang, id)
        : useBlocks ? blocksHtml(nl.blocks as Block[], lang, id) : bodyHtml(nl.body, id);
      const tok = r.id != null ? await unsubToken(r.id) : "";
      const unsub = r.id != null ? `${SB_URL}/functions/v1/newsletter-unsub?l=${r.id}&t=${tok}` : "https://www.viven.ch";
      // saludo vía greeting(): en DE siempre "Guten Tag" formal, sin nombre de pila
      return wrapEmail(greeting(lang, r.name || "") + inner, unsub, lang);
    };

    /* ===== PREVIEW DEL EMAIL FINAL =====
       "Siempre antes de mandar tengo que poder ver como preview y corregir si
       necesario". El preview tiene que salir de ACÁ, del mismo buildFull() que arma
       lo que se envía — si lo dibuja el dashboard por su cuenta, un día el preview y
       el email se separan y nadie se entera hasta que sale mal.
       Devuelve el HTML completo (saludo, bloques, firma, link de baja) y el asunto,
       en el idioma pedido. No manda nada ni toca la base. */
    if (bodyReq.render_preview) {
      const lang = ["en", "de", "es"].includes(bodyReq.lang) ? bodyReq.lang : "en";
      const falso = { id: undefined as number | undefined, email: "preview@viven.ch", name: bodyReq.name || "", lang };
      return json({
        ok: true, lang,
        subject: asuntoDe(lang),
        html: await buildFull(falso),
        tiene_version_propia: !!(bI18n && Array.isArray(bI18n[lang]) && bI18n[lang].length),
        idiomas_cargados: bI18n ? Object.keys(bI18n).filter((k) => Array.isArray(bI18n[k]) && bI18n[k].length) : [],
      });
    }

    let sent = 0, failed = 0;
    const failedEmails: string[] = [];

    if (test_to || recips.length === 1) {
      // envío único (test o una persona): endpoint simple, sin batch
      const r = recips[0];
      const full = await buildFull(r);
      const res = await resendPost("/emails", {
        from: "VIVEN <info@viven.ch>", reply_to: "info@viven.ch", to: [r.email],
        subject: asuntoDe(["en", "de", "es"].includes(r.lang || "") ? r.lang! : "en"),
        html: full, tags: [{ name: "nl_id", value: String(id) }],
      });
      if (res.ok) {
        sent++;
        if (trackThis) {
          let resendId: string | null = null;
          try { resendId = (await res.clone().json())?.id ?? null; } catch { /* ignore */ }
          noReg += await registrar([{ newsletter_id: id, lead_id: r.id ?? null, email: r.email.toLowerCase(), resend_id: resendId }], "newsletter_id,email", "campaña " + id);
        }
      } else {
        failed++; failedEmails.push(r.email);
        console.error("RESEND_FAIL", r.email, res.status, (await res.text()).slice(0, 160));
      }
    } else {
      // ENVÍO POR BATCH — tandas de 100, ≤2 requests/segundo
      const BATCH = 100;
      for (let i = 0; i < recips.length; i += BATCH) {
        const chunk = recips.slice(i, i + BATCH);
        const payload = await Promise.all(chunk.map(async (r) => ({
          from: "VIVEN <info@viven.ch>", reply_to: "info@viven.ch", to: [r.email],
          subject: asuntoDe(["en", "de", "es"].includes(r.lang || "") ? r.lang! : "en"),
          html: await buildFull(r), tags: [{ name: "nl_id", value: String(id) }],
        })));
        const res = await resendPost("/emails/batch", payload);
        if (res.ok) {
          // la respuesta batch trae { data: [{id}, ...] } en el mismo orden del payload
          let ids: (string | null)[] = [];
          try { ids = ((await res.clone().json())?.data || []).map((d: { id?: string }) => d?.id ?? null); } catch { /* ignore */ }
          sent += chunk.length;
          if (trackThis) {
            const rows = chunk.map((r, j) => ({ newsletter_id: id, lead_id: r.id ?? null, email: r.email.toLowerCase(), resend_id: ids[j] ?? null }));
            noReg += await registrar(rows, "newsletter_id,email", "campaña " + id);
          }
        } else {
          failed += chunk.length;
          for (const r of chunk) failedEmails.push(r.email);
          console.error("RESEND_BATCH_FAIL", res.status, (await res.text()).slice(0, 200), "emails:", chunk.map((c) => c.email).join(","));
        }
        if (i + BATCH < recips.length) await new Promise((ok) => setTimeout(ok, 600));   // ≤2 req/s
      }
    }

    if (failedEmails.length) console.error("NEWSLETTER_FAILED_EMAILS", id, failedEmails.join(","));

    if (trackThis) {
      // sent_count = total efectivamente registrado (los previos + los nuevos enviados)
      const { count } = await service.from("newsletter_sends").select("*", { count: "exact", head: true }).eq("newsletter_id", id);
      await service.from("newsletters").update({
        status: "sent", sent_at: new Date().toISOString(),
        sent_count: count ?? (sent + skipped), updated_at: new Date().toISOString(),
      }).eq("id", id);
    }
    return json({ ok: true, sent, failed, skipped, total, test: !!test_to, no_registrados: noReg });
  } catch (e) {
    console.error("FUNCTION_ERROR", String(e));
    return json({ error: String(e) }, 500);
  }
});
