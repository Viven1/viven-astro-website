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
// Acciones: {accion:"estado"|"pedir_codigo"|"verificar"|"comentar"|"descargar"|"aprobar"|"desaprobar"}
//
// Deploy: supabase functions deploy get-portal --no-verify-jwt
// Secret: RESEND_API_KEY

import { registrarEmail } from "../_shared/email.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { emailViven } from "../_shared/email-viven.ts";

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

/* El email del código. Era un texto pelado —"Tu código para descargar y aprobar" y seis
   dígitos— y parecía spam. Es el PRIMER email que el cliente recibe del portal: si ese
   parece falso, no entra, y todo lo que sigue no existe.
   (Sebastián, 26 ago 2026: "esto se ve súper mal, parece spam… VIVEN te invita a tu
   portal personal para ver todo el material, dar feedback".)
   Dice qué es el portal antes de pedir nada, va con el logo, y nombra el proyecto: un
   código suelto sin contexto es exactamente lo que mandan los que estafan. */
/* La invitación a un colega del cliente. Es el único email de VIVEN que le llega a alguien
   que nunca oyó hablar de nosotros —se lo reenvía alguien de su empresa— así que dice quién
   lo invitó y a qué, antes de pedirle nada. */
const INV = {
  en: { hola: "Hello", codeLbl: "Your access code", cta: "Open the portal",
        intro: (q: string) => `${q} invited you to the private portal of this project, so you can see the material and add what you know.`,
        vale: "The code is valid for 7 days.",
        pie: "You will see the same as the rest of the team: the cut, the brief and the files.",
        porque: (q: string) => `You are receiving this because ${q} invited you.` },
  de: { hola: "Guten Tag", codeLbl: "Ihr Zugangscode", cta: "Portal öffnen",
        intro: (q: string) => `${q} hat Sie in das private Portal dieses Projekts eingeladen — damit Sie das Material sehen und ergänzen können, was Sie wissen.`,
        vale: "Der Code ist 7 Tage gültig.",
        pie: "Sie sehen dasselbe wie das übrige Team: den Schnitt, das Briefing und die Dateien.",
        porque: (q: string) => `Sie erhalten diese E-Mail, weil ${q} Sie eingeladen hat.` },
  es: { hola: "Hola", codeLbl: "Tu código de acceso", cta: "Abrir el portal",
        intro: (q: string) => `${q} te invitó al portal privado de este proyecto, para que veas el material y agregues lo que sepas.`,
        vale: "El código vale por 7 días.",
        pie: "Vas a ver lo mismo que el resto del equipo: el corte, el brief y los archivos.",
        porque: (q: string) => `Recibís este email porque ${q} te invitó.` },
};

const T = {
  en: {
    asunto: "Your project portal",
    hola: "Hi",
    intro: "We opened a private portal for your project. In it you can watch the cut, leave your notes at the exact second, download the files and approve the final version.",
    codeLbl: "Your access code",
    vale: "Valid for 15 minutes. If it expires, just ask for a new one from the portal.",
    cta: "Open my portal",
    pasos: "Open the portal and enter the code above.",
    link: "If the button does not work, copy this address:",
    porque: "You are receiving this because we are working together on this project.",
    seguro: "We ask for a code so that only you can see the material before it goes public.",
  },
  de: {
    asunto: "Ihr Projekt-Portal",
    hola: "Guten Tag",
    intro: "Wir haben ein privates Portal für Ihr Projekt eingerichtet. Dort sehen Sie den Schnitt, hinterlassen Ihre Anmerkungen auf die Sekunde genau, laden die Dateien herunter und geben die finale Version frei.",
    codeLbl: "Ihr Zugangscode",
    vale: "15 Minuten gültig. Falls er abläuft, fordern Sie im Portal einfach einen neuen an.",
    cta: "Portal öffnen",
    pasos: "Portal öffnen und den Code oben eingeben.",
    link: "Falls der Button nicht funktioniert, kopieren Sie diese Adresse:",
    porque: "Sie erhalten diese E-Mail, weil wir gemeinsam an diesem Projekt arbeiten.",
    seguro: "Wir fragen nach einem Code, damit nur Sie das Material sehen, bevor es öffentlich wird.",
  },
  es: {
    asunto: "Tu portal del proyecto",
    hola: "Hola",
    intro: "Te abrimos un portal privado para tu proyecto. Ahí podés ver el corte, dejar tus notas en el segundo exacto, bajar los archivos y aprobar la versión final.",
    codeLbl: "Tu código de acceso",
    vale: "Vale por 15 minutos. Si se vence, pedí uno nuevo desde el portal.",
    cta: "Abrir mi portal",
    pasos: "Abrí el portal y poné el código de arriba.",
    link: "Si el botón no anda, copiá esta dirección:",
    porque: "Recibís este email porque estamos trabajando juntos en este proyecto.",
    seguro: "Pedimos un código para que solo vos puedas ver el material antes de que sea público.",
  },
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
        /* El preview tiene que ser el email de verdad, no un resumen: es lo único que
           se mira antes de mandarlo a un cliente. */
        html: emailViven({
          lang,
          saludo: `${L.hola},`,
          titulo: esc(proj.title || deal.title || ""),
          intro: L.intro,
          cuerpo: `<div style="background:#f6f8fb;border:1px solid #e6e9ef;border-radius:12px;padding:20px 22px;text-align:center">
        <p style="margin:0 0 6px;font-size:12px;letter-spacing:.09em;text-transform:uppercase;color:#8a94a8;font-weight:700">${L.codeLbl}</p>
        <p style="margin:0;font-size:36px;font-weight:800;letter-spacing:.22em;color:#1a2230;font-family:ui-monospace,Menlo,monospace">${code}</p>
      </div>
      <p style="margin:16px 0 22px;font-size:13px;color:#8a94a8;line-height:1.6">${L.vale}</p>
      <p style="margin:0 0 10px;font-size:14.5px;color:#3d4757">${L.pasos}</p>`,
          cta: { texto: L.cta, url: `https://www.viven.ch/portal/?id=${encodeURIComponent(String(deal.id))}&t=${encodeURIComponent(String(deal.portal_token))}` },
          pie: `🔒 ${L.seguro}`,
        }),
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
        const quien = String(lead?.name || proj.client_contact || "").trim().split(/\s+/)[0] || "";
        const portalLink = `https://www.viven.ch/portal/?id=${encodeURIComponent(String(deal.id))}&t=${encodeURIComponent(String(deal.portal_token))}`;
        /* Este email usa la MISMA plantilla que todos los demás (_shared/email-viven).
           Antes cada función tenía su layout y el del brief salía como texto pelado con
           una URL de noventa caracteres: mismo remitente, misma semana, dos marcas
           distintas. El cliente no ve dos funciones, ve a VIVEN mandando algo que parece
           phishing.
           (Sebastián, 26 ago 2026: "importante la presencia que damos, el branding tiene
           que ser consistente".) */
        const html = emailViven({
          lang: lang as "en" | "de" | "es",
          saludo: `${L.hola}${quien ? " " + esc(quien) : ""},`,
          titulo: esc(proj.title || deal.title || ""),
          intro: L.intro,
          cuerpo: `<div style="background:#f6f8fb;border:1px solid #e6e9ef;border-radius:12px;padding:20px 22px;text-align:center">
        <p style="margin:0 0 6px;font-size:12px;letter-spacing:.09em;text-transform:uppercase;color:#8a94a8;font-weight:700">${L.codeLbl}</p>
        <p style="margin:0;font-size:36px;font-weight:800;letter-spacing:.22em;color:#1a2230;font-family:ui-monospace,Menlo,monospace">${code}</p>
      </div>
      <p style="margin:16px 0 22px;font-size:13px;color:#8a94a8;line-height:1.6">${L.vale}</p>
      <p style="margin:0 0 10px;font-size:14.5px;color:#3d4757">${L.pasos}</p>`,
          cta: { texto: L.cta, url: portalLink },
          pie: `🔒 ${L.seguro}`,
          porque: L.porque,
        });
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
            html: emailViven({ lang: "es", titulo: "El cliente terminó el brief",
              intro: `${esc(proj.title || deal.title || "")}${proj.ref ? " · " + proj.ref : ""}`,
              cuerpo: `<table style="width:100%;border-collapse:collapse">${filas}</table>`,
              cta: proj.ref ? { texto: "Abrir el proyecto", url: `https://www.viven.ch/dashboard/?proyecto=${proj.ref}` } : undefined,
              porque: "Aviso interno del portal." }),
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
            /* Este es el único email de VIVEN que le llega a alguien que NUNCA oyó
               hablar de nosotros: se lo reenvía un colega del cliente. Salía en inglés
               fijo, sin logo, con el link crudo y seis dígitos sueltos — o sea, idéntico
               a un phishing. Va en el idioma del proyecto y dice quién lo invitó. */
            html: emailViven({
              lang,
              saludo: `${INV[lang].hola},`,
              titulo: esc(proj.title || deal.title || ""),
              intro: INV[lang].intro(esc(emailCliente || "")),
              cuerpo: `<div style="background:#f6f8fb;border:1px solid #e6e9ef;border-radius:12px;padding:20px 22px;text-align:center">
        <p style="margin:0 0 6px;font-size:12px;letter-spacing:.09em;text-transform:uppercase;color:#8a94a8;font-weight:700">${INV[lang].codeLbl}</p>
        <p style="margin:0;font-size:36px;font-weight:800;letter-spacing:.22em;color:#1a2230;font-family:ui-monospace,Menlo,monospace">${code}</p>
      </div>
      <p style="margin:16px 0 0;font-size:13px;color:#8a94a8;line-height:1.6">${INV[lang].vale}</p>`,
              cta: { texto: INV[lang].cta, url: link },
              pie: INV[lang].pie,
              porque: INV[lang].porque(esc(emailCliente || "")),
            }),
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
          url: proj.ref ? `/dashboard/?proyecto=${proj.ref}` : `/dashboard/?tab=projects`,
        }),
      }).catch(() => {});
      return json({ ok: true, comentario: c });
    }

    /* ── Mandar el Project Brief ──
       Salía por send-outreach como texto plano con la URL cruda pegada abajo: noventa
       caracteres de token en azul y nada más. Parecía phishing, que es lo peor que puede
       parecer el primer email de un proyecto.
       Con `dry_run` devuelve el HTML sin mandar nada: el preview del dashboard muestra el
       email EXACTO que sale, no una copia que se desactualiza. */
    if (accion === "brief_mandar" || accion === "brief_preview") {
      const auth2 = req.headers.get("Authorization") ?? "";
      const tok2 = auth2.replace(/^Bearer\s+/i, "").trim();
      if (!tok2 || tok2 === SB_ANON) return json({ error: "unauthorized" }, 401);
      const u2 = createClient(SB_URL, SB_ANON, { global: { headers: { Authorization: `Bearer ${tok2}` } } });
      const { data: { user: user2 } } = await u2.auth.getUser();
      if (!user2) return json({ error: "unauthorized" }, 401);
      const { data: esM2 } = await u2.rpc("is_member");
      if (esM2 !== true) return json({ error: "unauthorized" }, 401);

      const dest2 = String(body.to || emailCliente || "").trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(dest2)) return json({ error: "Falta un email válido al que mandárselo" });

      const BT = {
        en: { asunto: "A few questions before we start", hola: "Hi",
              intro: "Before we write anything, twelve questions decide what the film actually is.",
              q: ["What the film is about and who it is for", "What has to be seen, and where", "Who appears on camera"],
              qLbl: "What we ask", cta: "Open the questions",
              nota: "Answer at your own pace — it saves as you go, and you can invite whoever knows the answers.",
              pie: "No answer is wrong: what you do not know yet, we work out together." },
        de: { asunto: "Ein paar Fragen, bevor wir starten", hola: "Guten Tag",
              intro: "Bevor wir etwas schreiben, entscheiden zwölf Fragen, was der Film wirklich wird.",
              q: ["Worum es geht und für wen", "Was zu sehen sein muss, und wo", "Wer vor der Kamera steht"],
              qLbl: "Worum es geht", cta: "Fragen öffnen",
              nota: "In Ihrem Tempo — wird laufend gespeichert, und Sie können einladen, wer die Antworten kennt.",
              pie: "Keine Antwort ist falsch: Was noch offen ist, klären wir gemeinsam." },
        es: { asunto: "Unas preguntas antes de empezar", hola: "Hola",
              intro: "Antes de escribir nada, doce preguntas deciden qué es realmente el video.",
              q: ["De qué se trata y para quién", "Qué tiene que verse, y dónde", "Quién aparece en cámara"],
              qLbl: "Qué te preguntamos", cta: "Abrir las preguntas",
              nota: "A tu ritmo — se guardan solas, y podés invitar a quien sepa las respuestas.",
              pie: "Ninguna respuesta está mal: lo que todavía no sepas, lo resolvemos juntos." },
      }[lang] ?? null;
      if (!BT) return json({ error: "idioma raro" }, 400);

      const linkBrief = `https://www.viven.ch/portal/?id=${encodeURIComponent(String(deal.id))}&t=${encodeURIComponent(String(deal.portal_token))}`;
      const quienB = lead?.name || proj.client_contact || "";
      const asuntoB = String(body.asunto || "").trim() ||
        `${proj.ref ? proj.ref + " · " : ""}${proj.title || deal.title || ""} — ${BT.asunto}`;

      const htmlB = emailViven({
        lang: lang as "en" | "de" | "es",
        saludo: `${BT.hola}${quienB ? " " + esc(String(quienB).split(" ")[0]) : ""},`,
        titulo: esc(proj.title || deal.title || ""),
        intro: BT.intro,
        /* Se dice QUÉ se pregunta antes de mandar a nadie a ningún lado. "Doce preguntas"
           sin decir de qué son es un link a ciegas, y a un link a ciegas no se entra. */
        cuerpo: `<div style="background:#f6f8fb;border:1px solid #e6e9ef;border-radius:12px;padding:18px 22px">
        <p style="margin:0 0 10px;font-size:12px;letter-spacing:.09em;text-transform:uppercase;color:#8a94a8;font-weight:700">${BT.qLbl}</p>
        ${BT.q.map((x) => `<p style="margin:0 0 7px;font-size:14.5px;color:#1a2230">· ${esc(x)}</p>`).join("")}
      </div>
      <p style="margin:16px 0 0;font-size:13.5px;color:#8a94a8;line-height:1.6">${BT.nota}</p>`,
        cta: { texto: BT.cta, url: linkBrief },
        pie: BT.pie,
      });

      if (accion === "brief_preview" || body.dry_run) {
        return json({ ok: true, dry_run: true, para: dest2, asunto: asuntoB, html: htmlB });
      }
      if (!RESEND) return json({ error: "Falta RESEND_API_KEY" }, 500);
      const rB = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${RESEND}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: "VIVEN AG <info@viven.ch>", to: [dest2], reply_to: "info@viven.ch",
                               subject: asuntoB, html: htmlB }),
      });
      if (!rB.ok) {
        const t = await rB.text();
        console.error("RESEND_FAIL_BRIEF", rB.status, t);
        return json({ error: `no salió (${rB.status}): ${t.slice(0, 200)}` }, 502);
      }
      await service.from("projects")
        .update({ brief_sent_at: new Date().toISOString(),
                  brief_variante: body.variante || proj.brief_variante || "largo" }).eq("id", proj.id);
      return json({ ok: true, para: dest2, asunto: asuntoB });
    }

    /* ── Corregir, borrar y marcar hecha una nota ──
       Sebastián, 26 ago 2026: "dejá editar y borrar comentarios" / "y marcar como hechos".
       Una nota se escribe mientras corre el video: sale con un error de tipeo, o se dice
       algo y dos segundos después se ve que no era. Sin corregir ni borrar, la única
       salida era escribir otra nota que contradice la anterior — y el que monta se come
       las dos.

       Quién puede qué: corregir y borrar, SOLO el que la escribió (o nosotros). Marcar
       hecha la puede marcar cualquiera de los dos lados, porque es el mismo estado que
       usamos en el dashboard: si el cliente dice "esto ya está", nos ahorra mirarlo. */
    if (accion === "comentario_editar" || accion === "comentario_borrar" || accion === "comentario_hecho") {
      const acc = esEquipo ? { equipo: true, email: "VIVEN" } : await verificado(body.token);
      if (!acc) return json({ error: "necesita_codigo" }, 401);
      const cId = body.comentario_id;
      if (!cId) return json({ error: "falta el comentario" }, 400);
      const quien = String((acc as { email?: string }).email || "").replace(/^(equipo|editor):/, "").toLowerCase();

      const { data: c } = await service.from("project_comments")
        .select("id,author_email,resolved").eq("id", String(cId)).eq("project_id", proj.id).maybeSingle();
      if (!c) return json({ error: "esa nota no es de este proyecto" }, 404);

      /* Marcar hecha no necesita ser dueño; corregir y borrar sí. */
      if (accion !== "comentario_hecho") {
        const suya = esEquipo || (c.author_email && String(c.author_email).toLowerCase() === quien);
        if (!suya) return json({ error: "esa nota la escribió otra persona" }, 403);
      }

      if (accion === "comentario_borrar") {
        const { error } = await service.from("project_comments").delete().eq("id", c.id);
        if (error) return json({ error: error.message }, 500);
        return json({ ok: true, borrado: true });
      }

      if (accion === "comentario_hecho") {
        const { data: up, error } = await service.from("project_comments")
          .update({ resolved: !c.resolved }).eq("id", c.id).select("resolved").maybeSingle();
        if (error) return json({ error: error.message }, 500);
        return json({ ok: true, resolved: !!(up && up.resolved) });
      }

      const texto = String(body.texto || "").trim();
      if (!texto) return json({ error: "vacio" }, 400);
      const { data: up, error } = await service.from("project_comments")
        .update({ body: texto.slice(0, 2000) }).eq("id", c.id).select().single();
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true, comentario: up });
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
    /* Avisar al equipo: push Y email. La push sola no alcanza —si el teléfono está en
       silencio nadie se entera— y esto es de las pocas cosas del portal donde el cliente
       nos está esperando a nosotros. */
    /* NO se espera: el cliente toca "terminé mis notas" y se queda mirando un botón
       deshabilitado mientras Resend contesta. El aviso tiene que salir igual, pero la
       pantalla no le debe nada al servidor de email.
       (Sebastián, 26 ago 2026: "tarda mucho en avisar".) */
    const avisar = (titulo: string, detalle: string, quien: string) => {
      fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/push-send`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") },
        /* Al PROYECTO, no a la lista de gente. Un aviso que te deja en Personas te obliga
           a buscar a mano justo lo que el aviso ya sabía.
           (Sebastián, 26 ago 2026: "tocar esa notificación me lleva a personas, no donde
           tengo que ir".) */
        body: JSON.stringify({ title: titulo, body: detalle,
          url: proj.ref ? `/dashboard/?proyecto=${proj.ref}` : "/dashboard/?tab=projects" }),
      }).catch(() => {});
      if (!RESEND) return;
      fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${RESEND}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: "Viven Portal <leads@viven.ch>", to: ["info@viven.ch"],
          reply_to: emailCliente || undefined,
          subject: `${titulo} — ${proj.ref ? proj.ref + " · " : ""}${esc(proj.title || deal.title || "")}`,
          html: emailViven({ lang: "es", titulo, intro: esc(detalle),
            cuerpo: `<p style="font-size:12.5px;color:#8a94a8;margin:0">${esc(quien)}</p>`,
            cta: proj.ref ? { texto: "Abrir el proyecto", url: `https://www.viven.ch/dashboard/?proyecto=${proj.ref}` } : undefined,
            porque: "Aviso interno del portal." }),
        }),
      }).catch(() => {});
    };

    if (accion === "aprobar") {
      const acc = esEquipo ? { equipo: true, email: "VIVEN" } : await verificado(body.token);
      if (!acc) return json({ error: "necesita_codigo" }, 401);
      const vId = body.version_id;
      if (!vId) return json({ error: "no hay ninguna versión del corte para aprobar" }, 400);
      const quien = String((acc as { email?: string }).email || "").replace(/^(equipo|editor):/, "");
      const { data: vUpd, error } = await service.from("project_versions").update({
        approved_at: new Date().toISOString(), approved_by: quien, approved_ip: ip,
      }).eq("id", vId).eq("project_id", proj.id).select("n").maybeSingle();
      if (error) return json({ error: error.message }, 500);
      if (!vUpd) return json({ error: "esa versión no es de este proyecto" }, 404);
      /* NO se marca el proyecto como entregado acá. Aprobar el corte y entregar los
         archivos son dos momentos distintos —el portal mismo dice "aprobalo y ahí
         entregamos los archivos finales"— y darlo por entregado antes de entregarlo hace
         que el proyecto desaparezca de lo pendiente teniendo trabajo por delante. */
      avisar("✅ Aprobado por el cliente",
        `${proj.client_contact || quien} aprobó la versión ${vUpd.n} de ${proj.title || ""}. Ya se pueden entregar los archivos finales.`,
        quien);
      return json({ ok: true, version: vUpd.n });
    }

    /* Deshacer la aprobación. Aprobar es un botón grande y verde en una pantalla que se
       abre desde el teléfono: se toca por error. Sin esta salida, el único camino era
       escribirnos. Vuelve a "esperando" y avisa, para que nadie entregue los finales
       creyendo que sigue aprobado.
       (Sebastián, 26 ago 2026: "por si fue un error.") */
    if (accion === "desaprobar") {
      const acc = esEquipo ? { equipo: true, email: "VIVEN" } : await verificado(body.token);
      if (!acc) return json({ error: "necesita_codigo" }, 401);
      const vId = body.version_id;
      if (!vId) return json({ error: "no hay ninguna versión del corte" }, 400);
      const quien = String((acc as { email?: string }).email || "").replace(/^(equipo|editor):/, "");
      const { data: vUpd, error } = await service.from("project_versions").update({
        approved_at: null, approved_by: null, approved_ip: null,
      }).eq("id", vId).eq("project_id", proj.id).select("n").maybeSingle();
      if (error) return json({ error: error.message }, 500);
      if (!vUpd) return json({ error: "esa versión no es de este proyecto" }, 404);
      avisar("↩︎ Aprobación deshecha",
        `${proj.client_contact || quien} sacó la aprobación de la versión ${vUpd.n} de ${proj.title || ""}. Ojo: no entreguen los archivos finales todavía.`,
        quien);
      return json({ ok: true, version: vUpd.n });
    }

    /* "Ya di mis notas": el estado del medio que faltaba. Si el cliente dejó comentarios,
       no aprobó — está esperando el corte siguiente, y eso nos espera a NOSOTROS. */
    if (accion === "notas_listas") {
      const acc = esEquipo ? { equipo: true, email: "VIVEN" } : await verificado(body.token);
      if (!acc) return json({ error: "necesita_codigo" }, 401);
      const vId = body.version_id;
      if (!vId) return json({ error: "no hay ninguna versión del corte" }, 400);
      const quien = String((acc as { email?: string }).email || "").replace(/^(equipo|editor):/, "");
      const { data: vUpd, error } = await service.from("project_versions").update({
        notes_done_at: new Date().toISOString(), notes_done_by: quien,
      }).eq("id", vId).eq("project_id", proj.id).select("n").maybeSingle();
      if (error) return json({ error: error.message }, 500);
      if (!vUpd) return json({ error: "esa versión no es de este proyecto" }, 404);
      const { count } = await service.from("project_comments")
        .select("id", { count: "exact", head: true }).eq("project_id", proj.id).eq("version_id", vId);
      avisar("📝 El cliente terminó sus notas",
        `${proj.client_contact || quien} dejó ${count ?? 0} nota${count === 1 ? "" : "s"} sobre la versión ${vUpd.n} de ${proj.title || ""} y espera la siguiente.`,
        quien);
      return json({ ok: true, version: vUpd.n, notas: count ?? 0 });
    }

    // ---------- ESTADO (lo que se ve al entrar) ----------
    const [{ data: versiones }, { data: comentarios }, { data: archivos }] = await Promise.all([
      service.from("project_versions").select("*").eq("project_id", proj.id).order("n", { ascending: false }),
      service.from("project_comments").select("id,version_id,tc_ms,body,author_name,author_email,from_client,resolved,created_at")
        .eq("project_id", proj.id).order("tc_ms", { ascending: true, nullsFirst: true }),
      service.from("project_files").select("id,file_name,mime,size_bytes,created_at")
        .eq("project_id", proj.id).eq("visible_cliente", true).order("created_at", { ascending: false }),
    ]);
    /* ── PASE DE EQUIPO ──
       Leer la sesión del navegador no alcanza: el dashboard vive en la app Viven CRM y
       el portal se abre en Chrome, y son dos almacenamientos distintos. Así que el
       dashboard —que sí está logueado— pide un pase y lo pega en el link.
       NO vence. Lo puse en 2 horas al principio y Sebastián lo corrigió: "yo para
       siempre abierto". Tiene sentido — es SU proyecto, y un pase que se vence lo manda
       a pedir otro justo cuando estaba mirando algo. Sigue siendo por proyecto, y sigue
       exigiendo estar logueado para pedirlo: lo que se guarda en el link es el resultado
       de haberlo estado.
       Se reusa el que ya exista: así el link que guardó en un marcador sigue andando. */
    /* Pase para el que MONTA. Igual que el del equipo pero largo: el montajista trabaja
       con las notas durante días, y un pase de 2 horas lo obliga a pedirlo de nuevo cada
       vez que abre el email. 30 días y solo para este proyecto.
       Existe porque el corte está privado en Vimeo: los minutos del email no pueden
       llevar a vimeo.com —ahí no reproduce— así que llevan acá adentro. */
    if (accion === "pase_editor") {
      const auth1 = req.headers.get("Authorization") ?? "";
      const tok1 = auth1.replace(/^Bearer\s+/i, "").trim();
      if (!tok1 || tok1 === SB_ANON) return json({ error: "unauthorized" }, 401);
      const u1 = createClient(SB_URL, SB_ANON, { global: { headers: { Authorization: `Bearer ${tok1}` } } });
      const { data: { user: user1 } } = await u1.auth.getUser();
      if (!user1) return json({ error: "unauthorized" }, 401);
      const { data: esM1 } = await u1.rpc("is_member");
      if (esM1 !== true) return json({ error: "unauthorized" }, 401);
      const mail1 = String(body.email || "").trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail1)) return json({ error: "email_invalido" }, 400);
      /* Uno por editor y proyecto: si se le manda dos veces, el link viejo sigue
         andando en vez de morirse a mitad de un montaje. */
      const { data: ya } = await service.from("portal_access")
        .select("token,token_expires").eq("project_id", proj.id).eq("email", `editor:${mail1}`).maybeSingle();
      const vigente = ya && (ya as { token_expires?: string }).token_expires &&
        new Date((ya as { token_expires: string }).token_expires) > new Date(Date.now() + 3 * 864e5);
      if (vigente) return json({ ok: true, pase: (ya as { token: string }).token });
      const pase1 = rnd(24);
      await service.from("portal_access").delete().eq("project_id", proj.id).eq("email", `editor:${mail1}`);
      await service.from("portal_access").insert({
        project_id: proj.id, email: `editor:${mail1}`, token: pase1,
        token_expires: new Date(Date.now() + 30 * 864e5).toISOString(), last_ip: ip,
      });
      return json({ ok: true, pase: pase1 });
    }

    if (accion === "pase_equipo") {
      const auth0 = req.headers.get("Authorization") ?? "";
      const tok0 = auth0.replace(/^Bearer\s+/i, "").trim();
      if (!tok0 || tok0 === SB_ANON) return json({ error: "unauthorized" }, 401);
      const u0 = createClient(SB_URL, SB_ANON, { global: { headers: { Authorization: `Bearer ${tok0}` } } });
      const { data: { user: user0 } } = await u0.auth.getUser();
      if (!user0) return json({ error: "unauthorized" }, 401);
      const { data: esM } = await u0.rpc("is_member");
      if (esM !== true) return json({ error: "unauthorized" }, 401);
      const suEmail = `equipo:${user0.email ?? ""}`.slice(0, 200);
      const { data: yaEq } = await service.from("portal_access")
        .select("token").eq("project_id", proj.id).eq("email", suEmail).maybeSingle();
      if (yaEq && (yaEq as { token?: string }).token) return json({ ok: true, pase: (yaEq as { token: string }).token });
      const pase = rnd(24);
      await service.from("portal_access").insert({
        project_id: proj.id, email: suEmail, token: pase,
        /* Sin vencimiento real: 100 años. La columna es NOT NULL en la práctica —el
           comprobador exige token_expires— así que se pone lejos en vez de null, que
           haría que `new Date(null) < now` lo diera por vencido. */
        token_expires: new Date(Date.now() + 36500 * 864e5).toISOString(), last_ip: ip,
      });
      return json({ ok: true, pase });
    }


    /* Un token que se guardó con email "equipo:…" es un pase del equipo, no el acceso
       del cliente: entra igual pero la pantalla tiene que poder decirlo. */
    const accTok = await verificado(body.token);
    const emailAcc = String((accTok as { email?: string } | null)?.email || "");
    const porPase = emailAcc.startsWith("equipo:") || emailAcc.startsWith("editor:");
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
      /* Quién soy, para saber qué notas puedo corregir o borrar. La comprobación de
         verdad la hace el servidor —esto solo decide qué botones se dibujan— pero sin
         esto la pantalla tendría que adivinar, y adivinar acá es mostrarle a alguien un
         botón que después le va a dar 403. */
      yo: esEquipo || porPase ? "VIVEN" : ((acc as { email?: string }).email || "").replace(/^(equipo|editor):/, ""),
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
