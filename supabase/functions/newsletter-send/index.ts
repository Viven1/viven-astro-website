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
// Deploy:  supabase functions deploy newsletter-send --no-verify-jwt
// Usa:     RESEND_API_KEY (ya seteado), SERVICE_ROLE para leer leads.

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
    const withLinks = esc(par).replace(/(https?:\/\/[^\s<]+)/g, (m) => `<a href="${addUtm(m, nlId)}" style="color:#5b7cfa">${m}</a>`).replace(/\n/g, "<br>");
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
    const isInternal = !!SERVICE_ROLE_KEY && auth === `Bearer ${SERVICE_ROLE_KEY}`;
    let user: { id: string } | null = null;
    if (!isInternal) {
      const supabase = createClient(SB_URL, SB_ANON, { global: { headers: { Authorization: auth } } });
      ({ data: { user } } = await supabase.auth.getUser());
    }
    const bodyReq = await req.json();
    const { id, test_to, mark_sent } = bodyReq;
    if (!user && !isInternal) return json({ error: "unauthorized" }, 401);
    if (!id) return json({ error: "falta id" }, 400);

    const { data: nl } = await service.from("newsletters").select("*").eq("id", id).maybeSingle();
    if (!nl) return json({ error: "newsletter no encontrada" }, 404);
    if (nl.status === "sent" && !test_to) return json({ error: "esta campaña ya fue enviada" }, 400);
    // envío real a UNA persona (mark_sent) — se registra igual que un envío completo,
    // para no perder rastro ni permitir remandar el mismo borrador a todo el segmento
    // por error. El self-test rápido ("Test a mi email") NO manda mark_sent y sigue
    // sin dejar rastro, como siempre.
    const trackThis = !test_to || mark_sent;

    // destinatarios
    const TEST = /@viven\.ch$|@entropia|@example\.|test/i;
    const isWon = (st: string) => /ganado|won|cerrado/i.test(st || "");
    const isOut = (st: string) => /spam|descartado/i.test(st || "");
    let recips: { id?: number; email: string; name?: string; lang?: string }[] = [];
    if (test_to) {
      const { data: matchLead } = await service.from("leads").select("id,lang").ilike("email", String(test_to)).maybeSingle();
      recips = [{ email: String(test_to), id: matchLead?.id, lang: matchLead?.lang }];
    } else {
      // deno-lint-ignore no-explicit-any -- fallback re-select cambia el shape; el tipo estricto no aplica
      let q: any = await service.from("leads").select("id,email,name,first_name,status,lang,unsubscribed").not("email", "is", null);
      if (q.error && /column/.test(q.error.message || "")) q = await service.from("leads").select("id,email,name,first_name,status,lang").not("email", "is", null);
      const seen = new Set<string>();
      for (const r of (q.data ?? []) as Record<string, string | number | boolean>[]) {
        const em = String(r.email || "").toLowerCase().trim();
        if (!em || seen.has(em) || TEST.test(em)) continue;
        if ((r as { unsubscribed?: boolean }).unsubscribed) continue;
        const st = String(r.status || "");
        if (isOut(st)) continue;
        if (nl.segment_stage === "won" && !isWon(st)) continue;
        if (nl.segment_stage === "open" && isWon(st)) continue;
        if (nl.segment_lang !== "all" && String(r.lang || "en") !== nl.segment_lang) continue;
        if ((nl.exclude_ids || []).includes(r.id)) continue;   // sacado a mano en "Ver destinatarios"
        seen.add(em);
        recips.push({ id: r.id as number, email: em, name: String((r as { first_name?: string }).first_name || String(r.name || "").split(" ")[0] || ""), lang: String(r.lang || "en") });
      }
      for (const raw of (nl.extra_emails || []) as string[]) {
        const em = String(raw || "").toLowerCase().trim();
        if (!em || seen.has(em) || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) continue;
        seen.add(em);
        const { data: matchLead } = await service.from("leads").select("id,first_name,name,lang").ilike("email", em).maybeSingle();
        recips.push({ id: matchLead?.id, email: em, name: String(matchLead?.first_name || String(matchLead?.name || "").split(" ")[0] || ""), lang: String(matchLead?.lang || "en") });
      }
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

    // construye el HTML completo para un destinatario
    const buildFull = async (r: { id?: number; email: string; name?: string; lang?: string }) => {
      const lang = r.lang || "en";
      const inner = useBlocks ? blocksHtml(nl.blocks as Block[], lang, id) : bodyHtml(nl.body, id);
      const tok = r.id != null ? await unsubToken(r.id) : "";
      const unsub = r.id != null ? `${SB_URL}/functions/v1/newsletter-unsub?l=${r.id}&t=${tok}` : "https://www.viven.ch";
      return `<!doctype html><body style="margin:0;background:#f4f5f7;font-family:Helvetica,Arial,sans-serif">
<div style="max-width:600px;margin:0 auto;padding:28px 16px">
  <div style="background:#0f1826;border-radius:14px 14px 0 0;padding:18px 26px"><img src="https://www.viven.ch/assets/brand/viven-logo-email.png" alt="VIVEN" height="24" style="height:24px;width:auto;display:block" /></div>
  <div style="background:#ffffff;border-radius:0 0 14px 14px;padding:30px 26px">
    ${r.name ? `<p style="margin:0 0 16px;font-size:15px;color:#222">Hi ${esc(r.name)},</p>` : ""}
    ${inner}
    <p style="margin:22px 0 0;font-size:14px;color:#444">— Sofia, VIVEN AG</p>
  </div>
  <p style="text-align:center;font-size:11.5px;color:#9aa;margin-top:16px">VIVEN AG · Zürich · <a href="https://www.viven.ch" style="color:#9aa">viven.ch</a> · <a href="${unsub}" style="color:#9aa">${UNSUB_LABEL[lang] || UNSUB_LABEL.en}</a></p>
</div></body>`;
    };

    let sent = 0, failed = 0;
    const failedEmails: string[] = [];

    if (test_to || recips.length === 1) {
      // envío único (test o una persona): endpoint simple, sin batch
      const r = recips[0];
      const full = await buildFull(r);
      const res = await resendPost("/emails", {
        from: "Sofia — VIVEN <info@viven.ch>", reply_to: "sofia@viven.ch", to: [r.email],
        subject: nl.subject, html: full, tags: [{ name: "nl_id", value: String(id) }],
      });
      if (res.ok) {
        sent++;
        if (trackThis) {
          let resendId: string | null = null;
          try { resendId = (await res.clone().json())?.id ?? null; } catch { /* ignore */ }
          await service.from("newsletter_sends").upsert(
            { newsletter_id: id, lead_id: r.id ?? null, email: r.email.toLowerCase(), resend_id: resendId },
            { onConflict: "newsletter_id,email", ignoreDuplicates: true },
          );
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
          from: "Sofia — VIVEN <info@viven.ch>", reply_to: "sofia@viven.ch", to: [r.email],
          subject: nl.subject, html: await buildFull(r), tags: [{ name: "nl_id", value: String(id) }],
        })));
        const res = await resendPost("/emails/batch", payload);
        if (res.ok) {
          // la respuesta batch trae { data: [{id}, ...] } en el mismo orden del payload
          let ids: (string | null)[] = [];
          try { ids = ((await res.clone().json())?.data || []).map((d: { id?: string }) => d?.id ?? null); } catch { /* ignore */ }
          sent += chunk.length;
          if (trackThis) {
            const rows = chunk.map((r, j) => ({ newsletter_id: id, lead_id: r.id ?? null, email: r.email.toLowerCase(), resend_id: ids[j] ?? null }));
            await service.from("newsletter_sends").upsert(rows, { onConflict: "newsletter_id,email", ignoreDuplicates: true });
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
    return json({ ok: true, sent, failed, skipped, total, test: !!test_to });
  } catch (e) {
    console.error("FUNCTION_ERROR", String(e));
    return json({ error: String(e) }, 500);
  }
});
