// Supabase Edge Function: newsletter-builder
// Arma el DRAFT de la newsletter mensual (nunca envía nada): junta los 3-4
// mejores posts publicados del último mes y medio (rankeados por pageviews vía
// RPC newsletter_top_blog_paths; sino los más recientes), suma 1 proyecto
// destacado (rotando, sin repetir) y genera el issue en EN/DE/ES con
// claude-sonnet-5 para los textos de conexión (fallback hardcodeado si la IA
// falla — el draft sale igual y se edita a mano). Queda como draft en
// newsletter_issues → se aprueba y envía desde el dashboard (Contenido →
// Newsletter) vía newsletter-send { issue_id }. Push al equipo al crearse.
//
// Auth (mismo patrón que reactivation-engine/content-engine): cron con
// Authorization: Bearer CRON_SECRET (vault 'cron_secret', SQL 0114) O usuario
// logueado del dashboard. { force: true } solo con JWT — descarta el draft del
// mes y regenera (jamás toca un issue ya enviado).
// Idempotente: máximo 1 issue activo por mes — el cron corre los días 1-7 con
// filtro dow=2 (primer martes) y puede re-dispararse sin duplicar nada.
//
// IA: claude-sonnet-5. OJO: este modelo NO soporta prefill de assistant —
// messages termina en user y el JSON se parsea recortando desde la primera "{".
//
// Deploy:  supabase functions deploy newsletter-builder --no-verify-jwt
// Secrets: ANTHROPIC_API_KEY, CRON_SECRET (ya seteados)
// Probar:  curl -X POST .../functions/v1/newsletter-builder \
//            -H "Authorization: Bearer $CRON_SECRET" -d '{}'

import { createClient } from "jsr:@supabase/supabase-js@2";
import projects from "./projects-digest.json" with { type: "json" };

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const service = createClient(SB_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const esc = (x: string) => String(x || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

type Lang = "en" | "de" | "es";
const LANGS: Lang[] = ["en", "de", "es"];

interface BlogRow { id: number; group_id: string; lang: string; title: string; lead: string | null; published_url: string | null; published_at: string; slug: string | null; hero_image: string | null }
interface PostGroup { group_id: string; views: number; byLang: Partial<Record<Lang, BlogRow>> }
interface Copy { subject: string; intro: string; post_blurbs: string[]; project_blurb: string; outro: string }

/* LA MISMA IMAGEN QUE EL ARTÍCULO, o ninguna.
   Regla de Sebastián (12 ago 2026): "que sean las mismas imágenes o rompemos la
   confianza". Mostrar una foto que no está en el artículo es un anzuelo.
   Por eso sale de blogs.hero_image, que es EXACTAMENTE el campo con el que
   blog-approve arma el <img> de portada de la página publicada (ver
   blog-approve/index.ts, heroImg). Mismo campo = imposible que se despeguen.
   Si un post no tiene hero_image, ese post va SIN imagen — nunca una de relleno. */
const abs = (u: string | null): string | null => {
  const x = String(u || "").trim();
  if (!x) return null;
  return x.startsWith("http") ? x : "https://www.viven.ch" + (x.startsWith("/") ? x : "/" + x);
};

// añade utm respetando query strings existentes — misma atribución que las
// campañas manuales (site.js mapea utm_source=newsletter → canal email)
function addUtm(url: string, month: string): string {
  const u = String(url || "").trim();
  if (!u || u.startsWith("mailto:") || u.startsWith("#")) return u;
  const tag = "utm_source=newsletter&utm_campaign=issue-" + month;
  const [base, hash] = u.split("#");
  const joined = base + (base.includes("?") ? "&" : "?") + tag;
  return hash ? joined + "#" + hash : joined;
}

// ---------------------------------------------------------------------------
// Textos de respaldo: si la IA falla, el draft sale igual (y se edita a mano).
// DE SIEMPRE Sie y ss (nunca ß). EN/ES cálido profesional.
// ---------------------------------------------------------------------------
const FALLBACK: Record<Lang, Copy> = {
  en: {
    subject: "New from VIVEN — stories worth your coffee break",
    intro: "Here's what we've been writing and making lately — a few reads we think are worth your time, plus a project fresh from the edit suite.",
    post_blurbs: [],
    project_blurb: "A recent project we're proud of — take a look at how it came together.",
    outro: "That's it for this month. If any of this sparks an idea for your own brand, just hit reply — we read everything.",
  },
  de: {
    subject: "Neues von VIVEN — Ideen für Ihre Video-Strategie",
    intro: "Hier ist, was uns in den letzten Wochen beschäftigt hat — einige Artikel, die sich für Sie lohnen, und ein Projekt frisch aus dem Schnitt.",
    post_blurbs: [],
    project_blurb: "Ein aktuelles Projekt, auf das wir stolz sind — sehen Sie selbst, wie es entstanden ist.",
    outro: "Das war's für diesen Monat. Wenn Sie eine Idee für Ihre eigene Marke daraus mitnehmen, antworten Sie einfach auf diese E-Mail — wir lesen alles.",
  },
  es: {
    subject: "Lo nuevo de VIVEN — ideas para tu próximo video",
    intro: "Esto es lo que estuvimos escribiendo y produciendo últimamente: algunas lecturas que valen la pena y un proyecto recién salido de edición.",
    post_blurbs: [],
    project_blurb: "Un proyecto reciente del que estamos orgullosos — mirá cómo lo hicimos.",
    outro: "Eso es todo por este mes. Si algo de esto te da una idea para tu marca, respondé este email — leemos todo.",
  },
};

const LANG_NAME: Record<Lang, string> = {
  en: "English (warm, professional, human — no corporate fluff)",
  de: "German (Swiss High German — NEVER use ß, always ss. ALWAYS formal Sie, NEVER du. Warm but professional)",
  es: "Spanish (warm, professional, close — natural 'vos/tú' tone is fine)",
};

const READ_MORE: Record<Lang, string> = { en: "Read the article", de: "Zum Artikel", es: "Leer el artículo" };
const SEE_PROJECT: Record<Lang, string> = { en: "See the full project", de: "Zum Projekt", es: "Ver el proyecto completo" };
const FEATURED: Record<Lang, string> = { en: "Featured project", de: "Projekt im Fokus", es: "Proyecto destacado" };
const FROM_BLOG: Record<Lang, string> = { en: "From the blog", de: "Aus dem Blog", es: "Del blog" };

// ---------------------------------------------------------------------------
// Copy con claude-sonnet-5 — SIN prefill de assistant (el modelo no lo
// soporta): messages termina en user; el JSON se recorta desde la primera "{"
// hasta la última "}" y se limpian fences. En DE, ss garantizado por código.
// ---------------------------------------------------------------------------
async function aiCopy(lang: Lang, posts: { title: string; lead: string }[], project: { client: string; headline: string; summary: string }, notas?: string): Promise<Copy | null> {
  if (!ANTHROPIC_API_KEY) return null;
  const sys = `You write the monthly email newsletter of VIVEN AG, a video production company in Zurich (produced the first Swiss feature film on Netflix; clients: UBS, Siemens, Porsche, FIFA, Philips). Write in ${LANG_NAME[lang]}. NEVER invent facts, projects or numbers not present in the input.
Output ONLY a single valid minified JSON object — no markdown, no fences, no commentary.`;
  /* Las instrucciones de Sebastián van ARRIBA del pedido y marcadas como prioritarias:
     abajo, entre los artículos y las reglas de formato, el modelo las trata como contexto
     y las diluye. */
  const prompt = `${notas ? `IMPORTANT — instructions from the sender for this issue, follow them over the generic guidance below:\n${notas}\n\n` : ""}This month's issue contains ${posts.length} blog articles and 1 featured project. Write ONLY the connecting copy — the article titles and links are rendered separately.

Blog articles:
${posts.map((p, i) => `${i + 1}. "${p.title}" — ${p.lead}`).join("\n")}

Featured project: ${project.client} — "${project.headline}"
${project.summary}

Write a JSON object with:
- "subject": email subject line, under 60 chars, specific and curiosity-driven, no clickbait, no "Newsletter" word.
- "intro": 1-2 sentences opening the email, sounds like a real person. No "we are thrilled".
- "post_blurbs": array of exactly ${posts.length} strings, one per article IN ORDER — each 1 sentence (max 25 words) saying why it's worth reading, NOT repeating the title.
- "project_blurb": 1-2 sentences presenting the featured project, concrete and visual, no superlative-stacking.
- "outro": 1-2 sentences closing warmly with a light call to action (reply / book a call), no hard sell.`;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 16000,
        system: sys,
        // claude-sonnet-5: sin prefill — el array TERMINA en user
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) { console.error("ANTHROPIC_FAIL", lang, res.status, (await res.text()).slice(0, 200)); return null; }
    const data = await res.json();
    let text = ((data.content ?? []).filter((c: { type: string }) => c.type === "text").map((c: { text: string }) => c.text).join(" ")).trim();
    text = text.replace(/```json|```/g, "").trim();
    const first = text.indexOf("{"), last = text.lastIndexOf("}");
    if (first === -1 || last <= first) return null;
    const p = JSON.parse(text.slice(first, last + 1));
    if (!p.subject || !p.intro || !Array.isArray(p.post_blurbs)) return null;
    if (lang === "de") { // Schweizer Hochdeutsch garantizado por código, no solo por prompt
      for (const k of ["subject", "intro", "project_blurb", "outro"] as const) p[k] = String(p[k] ?? "").replaceAll("ß", "ss");
      p.post_blurbs = p.post_blurbs.map((b: unknown) => String(b ?? "").replaceAll("ß", "ss"));
    }
    return p as Copy;
  } catch (e) {
    console.error("AI_COPY_ERROR", lang, String(e));
    return null;
  }
}

// ---------------------------------------------------------------------------
// HTML del cuerpo (sin wrapper/saludo/footer — eso lo pone newsletter-send por
// destinatario, con su link de baja). Mismo look que los emails existentes.
// ---------------------------------------------------------------------------
function renderHtml(lang: Lang, copy: Copy, posts: { title: string; url: string; hero: string | null }[], project: { client: string; headline: string; url: string; still: string | null }, month: string): string {
  const P = (t: string) => `<p style="margin:0 0 16px;font-size:15px;line-height:1.65;color:#222">${t}</p>`;
  let h = P(esc(copy.intro));
  h += `<p style="margin:22px 0 10px;font-size:12px;letter-spacing:1.5px;text-transform:uppercase;color:#8a93a6;font-weight:700">${FROM_BLOG[lang]}</p>`;
  posts.forEach((p, i) => {
    const blurb = copy.post_blurbs[i] || "";
    const url = addUtm(p.url, month);
    h += `<div style="margin:0 0 22px;padding:0 0 18px;border-bottom:1px solid #edf0f4">
  ${p.hero ? `<a href="${url}" style="display:block;margin:0 0 11px"><img src="${p.hero}" alt="${esc(p.title)}" width="548" style="width:100%;height:auto;display:block;border-radius:12px" /></a>` : ""}
  <p style="margin:0 0 5px;font-size:16px;line-height:1.4;font-weight:700"><a href="${url}" style="color:#0f1826;text-decoration:none">${esc(p.title)}</a></p>
  ${blurb ? `<p style="margin:0 0 7px;font-size:14px;line-height:1.6;color:#4a5262">${esc(blurb)}</p>` : ""}
  <a href="${url}" style="font-size:13.5px;color:#5b7cfa;font-weight:600">${READ_MORE[lang]} →</a>
</div>`;
  });
  const pUrl = addUtm(project.url, month);
  h += `<p style="margin:24px 0 10px;font-size:12px;letter-spacing:1.5px;text-transform:uppercase;color:#8a93a6;font-weight:700">${FEATURED[lang]}</p>`;
  h += `<div style="margin:0 0 20px;border:1px solid #edf0f4;border-radius:12px;overflow:hidden">
  ${abs(project.still) ? `<a href="${pUrl}"><img src="${abs(project.still)}" alt="${esc(project.client)}" width="548" style="width:100%;height:auto;display:block" /></a>` : ""}
  <div style="padding:16px 18px">
    <p style="margin:0 0 6px;font-size:16px;font-weight:700;color:#0f1826">${esc(project.headline)}</p>
    <p style="margin:0 0 10px;font-size:14px;line-height:1.6;color:#4a5262">${esc(copy.project_blurb)}</p>
    <a href="${pUrl}" style="font-size:13.5px;color:#5b7cfa;font-weight:600">${SEE_PROJECT[lang]} →</a>
  </div>
</div>`;
  h += P(esc(copy.outro));
  return h;
}

// push al equipo al crearse el draft — misma vía que reactivation-engine
// (push-send con service role). Best-effort: si falla, el draft ya quedó.
function pushTeam(month: string) {
  fetch(`${SB_URL}/functions/v1/push-send`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") },
    body: JSON.stringify({ title: "📬 Newsletter " + month + " lista para revisar", body: "El draft mensual se generó — aprobalo o descartalo en Contenido → Newsletter.", url: "/dashboard/?tab=contenido&sub=news" }),
  }).catch(() => {});
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  // auth: cron con secret compartido O usuario logueado del dashboard
  const authHdr = req.headers.get("Authorization") ?? "";
  const isCron = !!CRON_SECRET && authHdr === `Bearer ${CRON_SECRET}`;
  let userEmail: string | null = null;
  if (!isCron) {
    const supa = createClient(SB_URL, SB_ANON, { global: { headers: { Authorization: authHdr } } });
    const { data: { user } } = await supa.auth.getUser();
    if (!user) return json({ error: "unauthorized" }, 401);
    userEmail = user.email ?? "dashboard";
  }
  try {
    let body: { force?: boolean; proyecto?: string; notas?: string } = {};
    try { body = await req.json(); } catch { /* cron manda body vacío */ }

    // force solo con usuario logueado (el cron nunca fuerza)
    const forcedBy = body.force ? userEmail : null;
    if (body.force && !userEmail) return json({ error: "force requiere sesión del dashboard" }, 401);

    const month = new Date().toISOString().slice(0, 7); // YYYY-MM
    const { data: existing } = await service.from("newsletter_issues").select("id,status").eq("month", month).neq("status", "discarded");
    if ((existing ?? []).length) {
      if (!body.force) return json({ ok: true, skipped: "ya existe un issue activo para " + month });
      if (existing!.some((e) => e.status !== "draft")) return json({ error: "el issue de " + month + " ya fue aprobado/enviado — no se regenera" }, 400);
      // force: descartar drafts previos del mes (los enviados jamás se tocan)
      for (const e of existing!) await service.from("newsletter_issues").update({ status: "discarded", updated_at: new Date().toISOString() }).eq("id", e.id).eq("status", "draft");
    }

    // ---- 1) mejores posts del último mes y medio -------------------------
    const since = new Date(Date.now() - 45 * 864e5).toISOString();
    let { data: blogs } = await service.from("blogs")
      .select("id,group_id,lang,title,lead,published_url,published_at,slug,hero_image")
      .eq("status", "published").gte("published_at", since)
      .order("published_at", { ascending: false });
    let recentOnly = false;
    if (!(blogs ?? []).length) {
      // sin posts nuevos: caemos a los más recientes publicados
      recentOnly = true;
      const q = await service.from("blogs")
        .select("id,group_id,lang,title,lead,published_url,published_at,slug,hero_image")
        .eq("status", "published").order("published_at", { ascending: false }).limit(40);
      blogs = q.data;
    }
    if (!(blogs ?? []).length) return json({ error: "no hay posts publicados — no se puede armar la newsletter" }, 400);

    const groups = new Map<string, PostGroup>();
    for (const b of blogs as BlogRow[]) {
      const g = groups.get(b.group_id) ?? { group_id: b.group_id, views: 0, byLang: {} };
      if (LANGS.includes(b.lang as Lang) && b.published_url) g.byLang[b.lang as Lang] = b;
      groups.set(b.group_id, g);
    }

    // ranking por pageviews del período, agregado server-side (RPC del SQL 0114;
    // si falta o falla, queda el orden por fecha de publicación)
    try {
      const { data: tops } = await service.rpc("newsletter_top_blog_paths", { days: 45 });
      const counts = new Map<string, number>();
      for (const row of (tops ?? []) as { path: string; views: number }[]) {
        counts.set(String(row.path || "").replace(/\/+$/, ""), Number(row.views) || 0);
      }
      for (const g of groups.values()) {
        for (const b of Object.values(g.byLang)) {
          try {
            const path = new URL(b!.published_url!).pathname.replace(/\/+$/, "");
            g.views += counts.get(path) || 0;
          } catch { /* url inválida */ }
        }
      }
    } catch (e) { console.error("PV_RANK_SKIP", String(e)); }

    const ranked = [...groups.values()]
      .filter((g) => g.byLang.en || g.byLang.de || g.byLang.es)
      .sort((a, b) => (b.views - a.views) || (Date.parse((b.byLang.en ?? b.byLang.de ?? b.byLang.es)!.published_at) - Date.parse((a.byLang.en ?? a.byLang.de ?? a.byLang.es)!.published_at)))
      .slice(0, 4);
    if (!ranked.length) return json({ error: "no hay posts con URL publicada" }, 400);

    // ---- 2) proyecto destacado (rotación, sin repetir) --------------------
    const { data: prevIssues } = await service.from("newsletter_issues").select("project_key").neq("status", "discarded");
    const used = new Set((prevIssues ?? []).map((r) => (r as { project_key: string | null }).project_key).filter(Boolean));
    const pool = projects as Array<{ key: string; client: string; still: string | null; langs: Record<string, { url: string; headline: string; summary: string }> }>;
    /* La rotación es un buen default, no una regla: a veces querés que la edición del mes
       hable de un cliente puntual —porque acabás de entregarlo, o porque le vas a escribir
       a ese sector—. Si el dashboard manda `proyecto`, manda ese; si no, sigue rotando.
       (Sebastián, 2 sep 2026: "que me dé dropdown de los proyectos… es para el automático".) */
    const pedido = typeof body?.proyecto === "string" ? body.proyecto.trim() : "";
    const notas = typeof body?.notas === "string" ? body.notas.trim().slice(0, 600) : "";
    const project = (pedido ? pool.find((p) => p.key === pedido) : undefined)
      ?? pool.find((p) => !used.has(p.key)) ?? pool[used.size % pool.length];

    // ---- 3) copy IA por idioma (fallback si falla) ------------------------
    const content: Record<string, { subject: string; html: string; posts: { title: string; url: string }[]; ai: boolean }> = {};
    for (const lang of LANGS) {
      // por idioma: post en ese idioma o fallback a EN
      const posts = ranked.map((g) => {
        const b = g.byLang[lang] ?? g.byLang.en ?? g.byLang.de ?? g.byLang.es!;
        return { title: b!.title, lead: (b!.lead || "").slice(0, 260), url: b!.published_url!, hero: abs(b!.hero_image) };
      });
      const pj = project.langs[lang] ?? project.langs.en;
      const ai = await aiCopy(lang, posts.map((p) => ({ title: p.title, lead: p.lead })), { client: project.client, headline: pj.headline, summary: pj.summary }, notas);
      const copy: Copy = ai ?? { ...FALLBACK[lang], post_blurbs: [] };
      content[lang] = {
        subject: copy.subject,
        html: renderHtml(lang, copy, posts.map((p) => ({ title: p.title, url: p.url, hero: p.hero })), { client: project.client, headline: pj.headline, url: pj.url, still: project.still }, month),
        posts: posts.map((p) => ({ title: p.title, url: p.url })),
        ai: !!ai,
      };
    }

    // ---- 4) guardar draft + push -----------------------------------------
    const { data: issue, error } = await service.from("newsletter_issues").insert({
      month,
      status: "draft",
      content,
      project_key: project.key,
      meta: { ranked_by: recentOnly ? "recency" : "pageviews", groups: ranked.map((g) => ({ group_id: g.group_id, views: g.views })), forced_by: forcedBy },
    }).select().single();
    if (error) return json({ error: /does not exist|relation/i.test(error.message) ? "falta correr la migración 0114 (newsletter_issues)" : error.message }, 500);

    pushTeam(month);
    return json({ ok: true, id: issue.id, month, posts: ranked.length, project: project.key, ai: LANGS.every((l) => content[l].ai) });
  } catch (e) {
    console.error("FUNCTION_ERROR", String(e));
    return json({ error: String(e) }, 500);
  }
});
