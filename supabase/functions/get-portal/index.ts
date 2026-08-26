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

import { createClient } from "jsr:@supabase/supabase-js@2";

const service = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
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
      ? await service.from("leads").select("name,lang,email").eq("id", deal.lead_id).maybeSingle()
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
        await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: `Bearer ${RESEND}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            from: "VIVEN AG <info@viven.ch>", to: [emailCliente],
            subject: `${L.asunto} — ${esc(proj.title || deal.title || "VIVEN")}`,
            html: `<div style="font-family:sans-serif;font-size:15px;line-height:1.7;color:#1a2230">
              <p>${L.intro}</p>
              <p style="font-size:34px;font-weight:800;letter-spacing:.18em;margin:18px 0">${code}</p>
              <p style="color:#8a94a8;font-size:13px">${L.vale}</p></div>`,
          }),
        }).catch(() => {});
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
    const acc = await verificado(body.token);

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
      email_tapado: emailCliente ? emailCliente.replace(/^(.).*(.@)/, "$1•••$2") : null,
    });
  } catch (e) {
    console.error("FUNCTION_ERROR", String(e));
    return json({ error: String(e) }, 500);
  }
});
