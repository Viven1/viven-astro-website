// Supabase Edge Function: mandar-al-cliente
// Le manda algo a los contactos del proyecto: un mensaje escrito a mano, con el link
// del portal o del brief adjunto si hace falta. Branded, desde la persona que elijas.
//
// Por qué existe: el botón "Mandarles algo" del dashboard no mandaba nada. Abría un
// menú que te llevaba a OTRO paso y disparaba OTRO botón — y ese botón copiaba el link
// al portapapeles. Los contactos que habías tildado se perdían en el camino.
// (Sebastián, 26 ago 2026: "el mandarles algo solo copia las cosas, no muestra el email
//  sender con preview y los emails".)
//
// dry_run: true devuelve el HTML exacto, el remitente y a quién le llega, sin mandar
// nada. El dashboard NO tiene botón de enviar hasta que el preview volvió.
//
// Deploy: supabase functions deploy mandar-al-cliente

import { createClient } from "jsr:@supabase/supabase-js@2";
import { emailViven, cartaViven, escE as esc, type EmailLang } from "../_shared/email-viven.ts";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND = Deno.env.get("RESEND_API_KEY")!;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

const DE: Record<string, { nombre: string; email: string }> = {
  sofia: { nombre: "Sofia Treviño", email: "sofia@viven.ch" },
  sebastian: { nombre: "Sebastian Cepeda", email: "sebastian@viven.ch" },
};

const T = {
  es: { portal: "Abrir el proyecto", brief: "Contestar el brief",
        pieP: "Ahí ves el corte, dejás comentarios sobre el video y bajás los archivos.",
        pieB: "Son 12 preguntas. Se puede contestar de a poco: lo que escribas queda guardado." },
  en: { portal: "Open your project", brief: "Answer the brief",
        pieP: "There you can watch the cut, comment on the video and download the files.",
        pieB: "It's 12 questions. You can answer bit by bit — whatever you write is saved." },
  de: { portal: "Projekt öffnen", brief: "Briefing beantworten",
        pieP: "Dort sehen Sie den Schnitt, kommentieren das Video und laden die Dateien herunter.",
        pieB: "Es sind 12 Fragen. Sie können nach und nach antworten — Geschriebenes wird gespeichert." },
};

/* El texto que escribe Sebastián en el cuadro es TEXTO, no HTML: si escribe un < el email
   no se rompe. Los saltos de línea sí se respetan, que es lo único que espera de un cuadro
   de texto. */
const parrafos = (s: string) =>
  String(s || "").split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)
    .map((p) => `<p style="margin:0 0 14px;font-size:15px;line-height:1.62">${esc(p).replace(/\n/g, "<br>")}</p>`)
    .join("");

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const auth = req.headers.get("Authorization") ?? "";
    const u = createClient(SB_URL, SB_ANON, { global: { headers: { Authorization: auth } } });
    const { data: { user } } = await u.auth.getUser();
    if (!user) return json({ error: "unauthorized" }, 401);
    const { data: esM } = await u.rpc("is_member");
    if (esM !== true) return json({ error: "unauthorized" }, 401);

    const body = await req.json().catch(() => ({}));
    const projectId = body.project_id;
    if (!projectId) return json({ error: "falta project_id" }, 400);

    const service = createClient(SB_URL, SERVICE);
    const { data: proj } = await service.from("projects")
      .select("id,ref,title,deal_id,lead_id").eq("id", String(projectId)).maybeSingle();
    if (!proj) return json({ error: "no encontré ese proyecto" }, 404);

    /* Los destinatarios salen de project_contacts, no del cuerpo del request: el cliente
       manda los ids que tildó y acá se resuelven contra la base. Un email que llega en el
       body es un email que nadie verificó. */
    const ids: string[] = Array.isArray(body.contact_ids) ? body.contact_ids.map(String) : [];
    const { data: contactos } = await service.from("project_contacts")
      .select("id,name,email,role,recibe").eq("project_id", proj.id);
    const todos = contactos || [];
    const elegidos = ids.length ? todos.filter((c) => ids.includes(String(c.id))) : todos;

    const conEmail = elegidos.filter((c) => c.email && String(c.email).includes("@"));
    const sinEmail = elegidos.filter((c) => !c.email || !String(c.email).includes("@"))
      .map((c) => c.name || "(sin nombre)");
    if (!conEmail.length) {
      return json({ error: "Ninguno de los contactos que elegiste tiene email cargado.", sin_email: sinEmail }, 400);
    }

    const lang = (["es", "en", "de"].includes(String(body.lang)) ? String(body.lang) : "en") as EmailLang;
    const L = T[lang];
    const remitente = DE[String(body.de || "").toLowerCase()] || DE.sofia;
    const asunto = String(body.asunto || "").trim() || String(proj.title || "VIVEN");
    const mensaje = String(body.mensaje || "").trim();
    if (!mensaje) return json({ error: "el mensaje está vacío" }, 400);

    /* El link del portal sale del deal, igual que en get-portal. Si el proyecto todavía no
       tiene token, se dice — no se manda un botón que lleva a un 404. */
    let portalUrl = "";
    if (proj.deal_id) {
      const { data: deal } = await service.from("deals")
        .select("id,portal_token").eq("id", String(proj.deal_id)).maybeSingle();
      if (deal && deal.portal_token) {
        portalUrl = `https://www.viven.ch/portal/?id=${encodeURIComponent(String(deal.id))}&t=${encodeURIComponent(String(deal.portal_token))}`;
      }
    }
    const quiere = String(body.adjunto || "nada");  // 'portal' | 'brief' | 'nada'
    if ((quiere === "portal" || quiere === "brief") && !portalUrl) {
      return json({ error: "Este proyecto todavía no tiene link de portal. Generalo primero en el paso «Post-producción»." }, 400);
    }
    const cta = quiere === "portal" ? { texto: L.portal, url: portalUrl }
      : quiere === "brief" ? { texto: L.brief, url: portalUrl + "#brief" }
      : undefined;
    const pie = quiere === "portal" ? L.pieP : quiere === "brief" ? L.pieB : undefined;

    /* Una persona sola recibe una carta (sin cabecera oscura, con firma). Varias reciben
       el formato de siempre: una carta que empieza "Hola Kaan," y le llega a cuatro no es
       una carta, es un mailing mal hecho. */
    const uno = conEmail.length === 1;
    /* El saludo NO se pega acá. Lo escribe quien escribe el mensaje —la IA con el nombre
       real, o Sebastián a mano— y así lo que se ve en el cuadro de texto es exactamente lo
       que sale. Ponerlo de los dos lados daba "Hola Kaan," dos veces. */

    /* El botón va con el link plano abajo SIEMPRE. La regla es de Sebastián y no se
       negocia: "siempre con botón y abajo el link por si el boton no funca". */
    const LINK = { es: "Si el botón no funciona, copiá este link:", en: "If the button doesn't work, copy this link:",
                   de: "Falls der Button nicht funktioniert, kopieren Sie diesen Link:" }[lang];
    const botonHTML = cta
      ? `<p style="margin:22px 0 18px"><a href="${cta.url}" style="background:#0f1826;color:#ddf98f;text-decoration:none;font-weight:700;font-size:15px;padding:13px 26px;border-radius:100px;display:inline-block">${esc(cta.texto)} →</a></p>` +
        `<p style="margin:0;font-size:12px;color:#9aa6bd;line-height:1.6;word-break:break-all">${LINK}<br /><a href="${cta.url}" style="color:#8a94a8">${cta.url}</a></p>`
      : "";
    const pieHTML = pie
      ? `<p style="margin:22px 0 0;padding-top:18px;border-top:1px solid #e9ecf1;font-size:13px;color:#8a94a8;line-height:1.6">${pie}</p>`
      : "";

    const html = uno
      ? cartaViven({
          lang,
          texto: parrafos(mensaje) + botonHTML + pieHTML,
          firma: { nombre: remitente.nombre },
        })
      : emailViven({
          lang, titulo: String(proj.title || ""), cuerpo: parrafos(mensaje), cta, pie,
        });

    const to = conEmail.map((c) => String(c.email));

    if (body.dry_run) {
      return json({
        ok: true, dry_run: true, html, asunto,
        de: { nombre: remitente.nombre, email: remitente.email, from: `${remitente.nombre} — VIVEN <${remitente.email}>` },
        to: conEmail.map((c) => ({ name: c.name, email: c.email, role: c.role })),
        sin_email: sinEmail,
        formato: uno ? "carta" : "email",
      });
    }

    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: `${remitente.nombre} — VIVEN <${remitente.email}>`,
        to, reply_to: remitente.email, subject: asunto, html,
      }),
    });
    const rr = await r.json().catch(() => ({}));
    if (!r.ok) return json({ error: (rr as { message?: string }).message || "Resend rechazó el envío" }, 502);

    /* Queda registrado como nota del contacto: dentro de un mes, "¿esto se lo mandamos?"
       se contesta mirando la persona y no la bandeja de nadie. Va en lead_notes porque es
       donde ya viven las notas — no hay project_notes, y no vale la pena inventarla para
       una línea. */
    if (proj.lead_id) {
      await service.from("lead_notes").insert({
        lead_id: String(proj.lead_id),
        author: user.email || remitente.email,
        body: `📤 ${remitente.nombre} le mandó «${asunto}» a ${conEmail.map((c) => c.name || c.email).join(", ")} — ${proj.ref || proj.title || ""}`,
      });
    }

    return json({ ok: true, enviados: to.length, to, sin_email: sinEmail });
  } catch (e) {
    console.error("MANDAR_ERROR", String(e));
    return json({ error: String(e) }, 500);
  }
});
