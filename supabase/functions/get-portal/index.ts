// Supabase Edge Function: get-portal
// El portal del cliente, entero: estado del proyecto, versiones del corte, comentarios
// con timecode, archivos para bajar y aprobación.
//
// Acceso en dos niveles (decisión de Sebastián, 26 ago 2026):
// Acceso (decisión de Sebastián, 26 ago 2026 — "tampoco pide login"):
//   El link NO abre nada por sí solo: solo dice a qué email mandar el código de 6
//   dígitos. Ver, comentar, bajar y aprobar, todo pide el código. El código va SIEMPRE
//   al email de la ficha del contacto, nunca a uno que escriba el visitante: si no,
//   cualquiera con el link se lo manda a sí mismo y aprueba en nombre del cliente.
//   Verificado una vez, el navegador guarda el token 30 días.
//
// Acciones: {accion:"estado"|"pedir_codigo"|"verificar"|"comentar"|"descargar"|"aprobar"}
//
// Deploy: supabase functions deploy get-portal --no-verify-jwt
// Secret: RESEND_API_KEY

import { registrarEmail } from "../_shared/email.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const service = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
/* Para verificar la sesión de un miembro del equipo hace falta un cliente con la clave
   pública, no con la de servicio: es el JWT del usuario el que tiene que decidir. */
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const RESEND = Deno.env.get("RESEND_API_KEY");
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const esc = (x: unknown) => String(x ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/* Comparación en tiempo constante: comparar tokens con === filtra información por el
   tiempo que tarda en fallar. */
function igual(a: string, b: string){
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
async function sha256(s: string){
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const rnd = (n: number) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, "0")).join("");

const T = {
  en: { asunto: "Your access code", intro: "Your code to download and approve:", vale: "Valid for 15 minutes." },
  de: { asunto: "Ihr Zugangscode", intro: "Ihr Code zum Herunterladen und Freigeben:", vale: "15 Minuten gültig." },
  es: { asunto: "Tu código de acceso", intro: "Tu código para descargar y aprobar:", vale: "Vale por 15 minutos." },
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const body = await req.json();
    const { id, t, accion = "estado" } = body;
    if (!id || !t) return json({ error: "missing_params" }, 400);

    /* El token del deal es la llave del link. Vive en `deals` porque es el handle
       público de la URL — moverlo rompería cualquier link ya repartido. */
    const { data: deal } = await service.from("deals").select("id,title,portal_token,lead_id,stage").eq("id", id).maybeSingle();
    if (!deal || !deal.portal_token || !igual(String(deal.portal_token), String(t))) return json({ error: "not_found" }, 404);

    const { data: proj } = await service.from("projects")
      .select("*").eq("deal_id", deal.id).maybeSingle();
    if (!proj) return json({ error: "not_found" }, 404);

    const { data: lead } = deal.lead_id
      ? await service.from("leads").select("id,name,lang,email").eq("id", deal.lead_id).maybeSingle()
      : { data: null };
    /* Un solo idioma: el de la persona. "No hacen falta tres idiomas, solo el idioma
       del cliente que tenemos en su persona." */
    const lang = (["en", "de", "es"].includes(String(lead?.lang)) ? String(lead!.lang) : "en") as "en" | "de" | "es";
    const emailCliente = String(proj.client_contact_email || lead?.email || "").trim().toLowerCase();

    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;

    /* ---------- ¿este visitante ya se verificó? ---------- */
    const verificado = async (tok?: string) => {
      if (!tok) return null;
      const { data } = await service.from("portal_access").select("*")
        .eq("project_id", proj.id).eq("token", tok).maybeSingle();
      if (!data || !data.token_expires || new Date(data.token_expires) < new Date()) return null;
      return data;
    };

    /* ── EL EQUIPO ENTRA SIN CÓDIGO ──
       Al cerrar el portal con código dejé afuera también a Sebastián: no podía abrir el
       portal de su propio proyecto para revisarlo. (26 ago 2026: "yo también tengo que
       ver el portal del cliente, ahora está bloqueada para mí… no puede pasar jamás.
       Tengo que poder ver qué ve y corregir si necesario".)
       Si la llamada trae la sesión de un miembro de VIVEN (user_roles, la misma regla
       que el dashboard), entra directo. No hay atajo: hace falta estar logueado de
       verdad, un token robado del link no alcanza. */
    const esEquipo = await (async () => {
      const auth = req.headers.get("Authorization") ?? "";
      const tok = auth.replace(/^Bearer\s+/i, "").trim();
      if (!tok || tok === SB_ANON) return false;
      try {
        const u = createClient(SB_URL, SB_ANON, { global: { headers: { Authorization: `Bearer ${tok}` } } });
        const { data: { user } } = await u.auth.getUser();
        if (!user) return false;
        const { data } = await u.rpc("is_member");
        return data === true;
      } catch { return false; }
    })();

    /* ---------- VISTA PREVIA (no manda nada) ----------
       Sebastián, 26 ago 2026: "necesito siempre preview antes de mandar". Devuelve el
       HTML EXACTO del email del código, con un código de mentira, sin tocar Resend ni
       la tabla de accesos. Es la única forma de revisar este email sin escribirle al
       cliente real de un proyecto en curso. */
    if (accion === "preview_codigo") {
      const L = T[lang];
      const code = "482913";
      return json({
        ok: true,
        para: emailCliente || null,
        asunto: `${L.asunto} — ${esc(proj.title || deal.title || "VIVEN")}`,
        html: `<div style="font-family:sans-serif;font-size:15px;line-height:1.7;color:#1a2230">
              <p>${L.intro}</p>
              <p style="font-size:34px;font-weight:800;letter-spacing:.18em;margin:18px 0">${code}</p>
              <p style="color:#8a94a8;font-size:13px">${L.vale}</p></div>`,
        idioma: lang,
        aviso: "Vista previa: no se mandó nada y el código es de ejemplo.",
      });
    }

    // ---------- PEDIR CÓDIGO ----------
    if (accion === "pedir_codigo") {
      if (!emailCliente) return json({ error: "sin_email" }, 400);
      const code = String(Math.floor(100000 + Math.random() * 900000));
      const expira = new Date(Date.now() + 15 * 60e3).toISOString();
      await service.from("portal_access").delete().eq("project_id", proj.id).eq("email", emailCliente);
      await service.from("portal_access").insert({
        project_id: proj.id, email: emailCliente, code_hash: await sha256(code),
        code_expires: expira, last_ip: ip,
      });
      if (RESEND) {
        const L = T[lang];
        const asunto = `${L.asunto} — ${esc(proj.title || deal.title || "VIVEN")}`;
        const html = `<div style="font-family:sans-serif;font-size:15px;line-height:1.7;color:#1a2230">
              <p>${L.intro}</p>
              <p style="font-size:34px;font-weight:800;letter-spacing:.18em;margin:18px 0">${code}</p>
              <p style="color:#8a94a8;font-size:13px">${L.vale}</p></div>`;
        await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: `Bearer ${RESEND}`, "Content-Type": "application/json" },
          body: JSON.stringify({ from: "VIVEN AG <info@viven.ch>", to: [emailCliente], subject: asunto, html }),
        }).catch(() => {});
        /* Queda en la ficha de la persona. Este email fue el que destapó el problema:
           salió a un cliente real y en su ficha no había ni una línea. El código NO se
           guarda —solo se dice que se mandó uno— porque el registro lo lee cualquiera
           del equipo y sería una llave escrita en la timeline. */
        await registrarEmail({
          service, to: emailCliente, subject: asunto,
          body: "Código de acceso al portal (6 dígitos, vence en 15 min). El código no se guarda.",
          source: "get-portal", senderLabel: "VIVEN", leadId: lead?.id ?? null,
        });
      }
      /* Se devuelve el email TAPADO: sirve para que el cliente sepa a dónde mirar, sin
         revelar la dirección completa a quien tenga el link. */
      const tapado = emailCliente.replace(/^(.).*(.@)/, "$1•••$2");
      return json({ ok: true, enviado_a: tapado });
    }

    // ---------- VERIFICAR CÓDIGO ----------
    if (accion === "verificar") {
      const { data: acc } = await service.from("portal_access").select("*")
        .eq("project_id", proj.id).eq("email", emailCliente).maybeSingle();
      if (!acc || !acc.code_hash || !acc.code_expires || new Date(acc.code_expires) < new Date()) {
        return json({ error: "codigo_vencido" }, 400);
      }
      /* Cinco intentos y se quema el código: con seis dígitos y sin tope, probarlos
         todos es cuestión de minutos. */
      if ((acc.intentos ?? 0) >= 5) return json({ error: "demasiados_intentos" }, 429);
      const ok = igual(acc.code_hash, await sha256(String(body.codigo || "")));
      if (!ok) {
        await service.from("portal_access").update({ intentos: (acc.intentos ?? 0) + 1 }).eq("id", acc.id);
        return json({ error: "codigo_incorrecto", quedan: 5 - (acc.intentos ?? 0) - 1 }, 400);
      }
      const tok = rnd(24);
      await service.from("portal_access").update({
        token: tok, token_expires: new Date(Date.now() + 30 * 864e5).toISOString(),
        code_hash: null, code_expires: null, intentos: 0, last_ip: ip,
      }).eq("id", acc.id);
      return json({ ok: true, token: tok });
    }

    /* ═══════════ PROJECT BRIEF ═══════════
       Las 12 preguntas que definen de qué se trata el video. Todo pide código, igual
       que el resto del portal.

       Lo que se guarda vive en project_briefs (una fila por pregunta y proyecto), y el
       cliente NUNCA escribe en esa tabla directo: escribe por acá, que es donde se
       comprueba su acceso. */
    if (accion === "brief_guardar") {
      const acc2 = esEquipo ? { equipo: true } : await verificado(body.token);
      if (!acc2) return json({ error: "necesita_codigo" }, 401);
      const clave = String(body.key || "").slice(0, 60);
      if (!clave) return json({ error: "falta la pregunta" }, 400);
      const valor = String(body.value ?? "").slice(0, 6000);
      const quien = esEquipo ? "VIVEN" : String((acc2 as { email?: string }).email || "");
      if (!valor.trim()) {
        await service.from("project_briefs").delete().eq("project_id", proj.id).eq("key", clave);
        return json({ ok: true, borrada: true });
      }
      const { error } = await service.from("project_briefs")
        .upsert({ project_id: proj.id, key: clave, value: valor, answered_by: quien },
                { onConflict: "project_id,key" });
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    /* El cliente avisa que terminó. No se valida que estén las 12: un brief con diez
       respuestas buenas sirve, y trabarlo por dos que no sabe lo deja sin mandar nada. */
    if (accion === "brief_listo") {
      const acc3 = esEquipo ? { equipo: true } : await verificado(body.token);
      if (!acc3) return json({ error: "necesita_codigo" }, 401);
      await service.from("projects").update({ brief_done_at: new Date().toISOString() }).eq("id", proj.id);
      if (RESEND) {
        const { data: br } = await service.from("project_briefs")
          .select("key,value,answered_by").eq("project_id", proj.id);
        const filas = (br ?? []).map((x: { key: string; value: string; answered_by: string }) =>
          `<tr><td style="padding:7px 6px;border-bottom:1px solid #eee;color:#888;font-size:12.5px;width:34%">${esc(x.key)}</td>` +
          `<td style="padding:7px 6px;border-bottom:1px solid #eee;font-size:13.5px;white-space:pre-wrap">${esc(String(x.value || ""))}</td></tr>`).join("");
        await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: `Bearer ${RESEND}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            from: "Viven Leads <leads@viven.ch>", to: ["info@viven.ch"], reply_to: emailCliente || undefined,
            subject: `📋 BRIEF COMPLETO — ${proj.ref ? proj.ref + " · " : ""}${esc(proj.title || deal.title || "")}`,
            html: `<div style="font-family:Helvetica,Arial,sans-serif;max-width:640px;color:#222">
              <p style="font-size:16px;font-weight:700;margin:0 0 12px">El cliente terminó el brief</p>
              <table style="width:100%;border-collapse:collapse">${filas}</table></div>`,
          }),
        }).catch(() => {});
      }
      return json({ ok: true });
    }

    /* Invitar a un colega. Decisión de Sebastián: ve TODO el portal, no solo el brief —
       "si da info también va a querer dar feedback". Así que se le crea un acceso normal
       y recibe su propio código; no hay una tabla de invitados aparte. */
    if (accion === "brief_invitar") {
      const acc4 = esEquipo ? { equipo: true } : await verificado(body.token);
      if (!acc4) return json({ error: "necesita_codigo" }, 401);
      const mail = String(body.email || "").trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail)) return json({ error: "email_invalido" }, 400);
      const code = String(Math.floor(100000 + Math.random() * 900000));
      await service.from("portal_access").delete().eq("project_id", proj.id).eq("email", mail);
      await service.from("portal_access").insert({
        project_id: proj.id, email: mail, code_hash: await sha256(code),
        code_expires: new Date(Date.now() + 7 * 864e5).toISOString(), last_ip: ip,
      });
      if (RESEND) {
        const L2 = T[lang];
        const link = `https://www.viven.ch/portal/?id=${encodeURIComponent(String(deal.id))}&t=${encodeURIComponent(String(deal.portal_token))}`;
        await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: `Bearer ${RESEND}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            from: "VIVEN AG <info@viven.ch>", to: [mail], reply_to: emailCliente || undefined,
            subject: `${esc(proj.title || deal.title || "VIVEN")} — ${L2.asunto}`,
            html: `<div style="font-family:sans-serif;font-size:15px;line-height:1.7;color:#1a2230">
              <p>${esc(emailCliente || "")} invited you to the VIVEN project portal.</p>
              <p style="font-size:34px;font-weight:800;letter-spacing:.18em;margin:18px 0">${code}</p>
              <p><a href="${link}" style="color:#2b6cff">${link}</a></p>
              <p style="color:#8a94a8;font-size:13px">The code is valid for 7 days.</p></div>`,
          }),
        }).catch(() => {});
      }
      /* El código de la invitación dura 7 días y no 15 minutos: quien lo recibe puede
         estar de vacaciones, y un código muerto convierte una invitación en un email de
         soporte. */
      return json({ ok: true, invitado: mail });
    }

    // ---------- COMENTAR (pide código, igual que todo lo demás) ----------
    if (accion === "comentar") {
      /* Antes bastaba el link. Un comentario del cliente dispara trabajo de nuestro lado
         y queda firmado con su nombre: quien no probó que tiene su email no puede
         escribir en su nombre. */
      if (!(await verificado(body.token))) return json({ error: "necesita_codigo" }, 401);
      const texto = String(body.texto || "").trim();
      if (!texto) return json({ error: "vacio" }, 400);
      const { data: c, error } = await service.from("project_comments").insert({
        project_id: proj.id, version_id: body.version_id ?? null,
        tc_ms: Number.isFinite(Number(body.tc_ms)) ? Math.max(0, Math.round(Number(body.tc_ms))) : null,
        body: texto.slice(0, 2000),
        author_name: proj.client_contact || lead?.name || null,
        author_email: emailCliente || null, from_client: true,
      }).select().single();
      if (error) return json({ error: error.message }, 500);
      /* Aviso al equipo: un comentario que nadie ve no sirve de nada. */
      fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/push-send`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") },
        body: JSON.stringify({
          title: `💬 ${proj.client_contact || "El cliente"} comentó`,
          body: (c.tc_ms != null ? `[${Math.floor(c.tc_ms / 60000)}:${String(Math.floor(c.tc_ms / 1000) % 60).padStart(2, "0")}] ` : "") + texto.slice(0, 120),
          url: `/dashboard/?tab=projects`,
        }),
      }).catch(() => {});
      return json({ ok: true, comentario: c });
    }

    // ---------- DESCARGAR (necesita código) ----------
    if (accion === "descargar") {
      const acc = await verificado(body.token);
      if (!acc) return json({ error: "necesita_codigo" }, 401);
      const { data: f } = await service.from("project_files").select("*")
        .eq("id", body.file_id).eq("project_id", proj.id).maybeSingle();
      if (!f || !f.visible_cliente) return json({ error: "not_found" }, 404);
      const { data: url, error } = await service.storage.from("project-files").createSignedUrl(f.file_path, 300, { download: f.file_name ?? undefined });
      if (error || !url) return json({ error: error?.message ?? "no_url" }, 500);
      return json({ ok: true, url: url.signedUrl });
    }

    // ---------- APROBAR (necesita código) ----------
    if (accion === "aprobar") {
      const acc = await verificado(body.token);
      if (!acc) return json({ error: "necesita_codigo" }, 401);
      const vId = body.version_id;
      if (!vId) return json({ error: "sin_version" }, 400);
      const { error } = await service.from("project_versions").update({
        approved_at: new Date().toISOString(), approved_by: acc.email, approved_ip: ip,
      }).eq("id", vId).eq("project_id", proj.id);
      if (error) return json({ error: error.message }, 500);
      await service.from("projects").update({ stage: "entregado", delivered_at: new Date().toISOString() }).eq("id", proj.id);
      fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/push-send`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") },
        body: JSON.stringify({ title: "✅ Aprobado por el cliente",
          body: `${proj.client_contact || acc.email} aprobó ${proj.title || ""}`, url: "/dashboard/?tab=projects" }),
      }).catch(() => {});
      return json({ ok: true });
    }

    // ---------- ESTADO (lo que se ve al entrar) ----------
    const [{ data: versiones }, { data: comentarios }, { data: archivos }] = await Promise.all([
      service.from("project_versions").select("*").eq("project_id", proj.id).order("n", { ascending: false }),
      service.from("project_comments").select("id,version_id,tc_ms,body,author_name,from_client,resolved,created_at")
        .eq("project_id", proj.id).order("tc_ms", { ascending: true, nullsFirst: true }),
      service.from("project_files").select("id,file_name,mime,size_bytes,created_at")
        .eq("project_id", proj.id).eq("visible_cliente", true).order("created_at", { ascending: false }),
    ]);
    /* ── PASE DE EQUIPO ──
       Leer la sesión del navegador no alcanza: el dashboard vive en la app Viven CRM y
       el portal se abre en Chrome, y son dos almacenamientos distintos. Así que el
       dashboard —que sí está logueado— pide un pase corto y lo pega en el link.
       Dura 2 horas y sirve para UN proyecto: es para mirar y corregir, no una llave. */
    if (accion === "pase_equipo") {
      const auth0 = req.headers.get("Authorization") ?? "";
      const tok0 = auth0.replace(/^Bearer\s+/i, "").trim();
      if (!tok0 || tok0 === SB_ANON) return json({ error: "unauthorized" }, 401);
      const u0 = createClient(SB_URL, SB_ANON, { global: { headers: { Authorization: `Bearer ${tok0}` } } });
      const { data: { user: user0 } } = await u0.auth.getUser();
      if (!user0) return json({ error: "unauthorized" }, 401);
      const { data: esM } = await u0.rpc("is_member");
      if (esM !== true) return json({ error: "unauthorized" }, 401);
      const pase = rnd(24);
      await service.from("portal_access").insert({
        project_id: proj.id, email: `equipo:${user0.email ?? ""}`.slice(0, 200),
        token: pase, token_expires: new Date(Date.now() + 2 * 3600e3).toISOString(), last_ip: ip,
      });
      return json({ ok: true, pase });
    }


    /* Un token que se guardó con email "equipo:…" es un pase del equipo, no el acceso
       del cliente: entra igual pero la pantalla tiene que poder decirlo. */
    const accTok = await verificado(body.token);
    const porPase = !!(accTok && String((accTok as { email?: string }).email || "").startsWith("equipo:"));
    const acc = esEquipo ? { equipo: true } : accTok;

    /* El brief y, si es la primera vez, lo que contestaron en un proyecto ANTERIOR.
       Sebastián corrigió mi diseño acá: yo repartía las respuestas entre empresa y
       proyecto, y él dijo "no sí o sí, ya que en la empresa hay varias secciones y unos
       hacen algo y otros otra cosa, pero lo dejamos en todos lados como base de lo que
       ya hicimos". O sea: se OFRECEN, no se heredan. Una respuesta puesta a ciegas de
       otro proyecto es peor que un campo vacío, porque nadie la revisa. */
    const { data: briefRows } = await service.from("project_briefs")
      .select("key,value,answered_by,updated_at").eq("project_id", proj.id);
    const brief: Record<string, string> = {};
    for (const b2 of briefRows ?? []) brief[(b2 as { key: string }).key] = (b2 as { value: string }).value ?? "";

    let sugerencias: Record<string, string> = {};
    if (!Object.keys(brief).length && deal.lead_id) {
      const { data: otros } = await service.from("projects")
        .select("id").eq("lead_id", deal.lead_id).neq("id", proj.id)
        .order("created_at", { ascending: false }).limit(3);
      const ids = (otros ?? []).map((x: { id: number }) => x.id);
      if (ids.length) {
        const { data: prev } = await service.from("project_briefs")
          .select("key,value,project_id").in("project_id", ids).order("updated_at", { ascending: false });
        for (const b3 of prev ?? []) {
          const k = (b3 as { key: string }).key;
          if (!sugerencias[k]) sugerencias[k] = (b3 as { value: string }).value ?? "";
        }
      }
    }

    /* SIN CÓDIGO NO SE VE NADA. Antes el link solo bastaba para mirar y comentar, y el
       código se pedía recién al descargar o aprobar. Pero un link reenviado —y estos
       links se reenvían: el cliente se lo pasa a su jefe, a su agencia, a su proveedor—
       dejaba ver el estado del proyecto, la fecha de entrega y TODOS los comentarios
       internos a cualquiera que lo tuviera. (Sebastián, 26 ago 2026: "tampoco pide
       login".) Ahora el link solo dice a qué mail se manda el código; lo demás llega
       después de verificarse. El token verificado dura 30 días en el navegador, así que
       el cliente no lo tipea en cada visita. */
    if (!acc) {
      return json({
        ok: true, lang,
        necesita_codigo: true,
        verificado: false,
        email_tapado: emailCliente ? emailCliente.replace(/^(.).*(.@)/, "$1•••$2") : null,
        tiene_email: !!emailCliente,
      });
    }

    return json({
      ok: true, lang,
      title: proj.title || deal.title,
      client_name: lead?.name || proj.client_contact || null,
      production_status: proj.stage || "desarrollo",
      portal_note: proj.portal_note || null,
      delivery_due: proj.delivery_due || null,
      deliverable_url: proj.deliverable_url || null,
      versiones: versiones ?? [],
      comentarios: comentarios ?? [],
      archivos: archivos ?? [],
      verificado: !!acc,
      /* Para que la pantalla pueda avisar "esto lo estás viendo como equipo": si no, es
         imposible saber si lo que ves es lo que ve el cliente. */
      modo_equipo: esEquipo || porPase,
      /* Brief: lo contestado, lo sugerido y cómo mostrarlo. La variante se sortea al
         enviarlo desde el dashboard y NO se recalcula acá: si cambiara entre visitas,
         la medición de cuál se termina más no valdría nada. */
      brief,
      brief_sugerencias: sugerencias,
      brief_variante: proj.brief_variante || "largo",
      brief_enviado: !!proj.brief_sent_at,
      brief_listo: !!proj.brief_done_at,
      ref: proj.ref ?? null,
      email_cliente: (esEquipo || porPase) ? emailCliente : null,
      email_tapado: emailCliente ? emailCliente.replace(/^(.).*(.@)/, "$1•••$2") : null,
    });
  } catch (e) {
    console.error("FUNCTION_ERROR", String(e));
    return json({ error: String(e) }, 500);
  }
});
