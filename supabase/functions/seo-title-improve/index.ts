// Supabase Edge Function: seo-title-improve
// El paso "hacelo vos y dejame aceptarlo" del panel 📈 Top páginas / 🎯 Oportunidades
// de CTR: la IA lee el archivo REAL de la página en GitHub, propone title + meta
// description nuevos (en el/los idioma(s) del frontmatter) y devuelve el archivo
// completo con SOLO esos valores cambiados + un diff real — SIN commitear nada.
// El commit lo hace después apply-link-suggest (mode:"commit") con el `updated`+`sha`
// que esta función devolvió: lo que se aprueba es exactamente lo que se publica.
//
// POST {page, queries: [{query, impressions, position, ctr}, ...]}  (JWT de usuario)
// →    {ok, path, sha, current:{title,desc}, proposal:{title,desc}, rationale, updated, diff}
//
// Deploy:  supabase functions deploy seo-title-improve --no-verify-jwt
// Secrets: GITHUB_TOKEN, GITHUB_REPO (opcional), ANTHROPIC_API_KEY (ya seteados)

import { createClient } from "jsr:@supabase/supabase-js@2";
import { decodeBase64 } from "jsr:@std/encoding/base64";

const GH_TOKEN = Deno.env.get("GITHUB_TOKEN")!;
const REPO = Deno.env.get("GITHUB_REPO") || "Viven1/viven-astro-website";
const BRANCH = Deno.env.get("GITHUB_BRANCH") || "dev";
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_ANON = Deno.env.get("SUPABASE_ANON_KEY")!;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

// ---- copiados de apply-link-suggest (mismo mapeo URL→archivo y mismas guardas) ----
function urlToPath(url: string): string | null {
  try {
    const u = new URL(url);
    const p = u.pathname.replace(/^\/+|\/+$/g, "");
    return p ? `src/pages/${p}/index.astro` : "src/pages/index.astro";
  } catch { return null; }
}
function isAllowedPath(path: string | null): path is string {
  // incluye las homes por idioma y las páginas compartidas en src/pages/[lang]/…
  return !!path && /^src\/pages\/(en|de|es|\[lang\])\/([a-z0-9\-/]+\/)?index\.astro$/.test(path) && !path.includes("dashboard");
}
// las páginas compartidas viven en src/pages/[lang]/… — si la versión por idioma
// no existe en el repo, se reintenta con [lang] (services, why-viven, tools, etc.)
function langFallbackPath(path: string): string | null {
  const m = path.match(/^src\/pages\/(en|de|es)\/(.+)$/);
  return m ? `src/pages/[lang]/${m[2]}` : null;
}
function computeDiff(original: string, updated: string) {
  const a = original.split("\n"), b = updated.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  return {
    ctxBefore: a.slice(Math.max(0, start - 2), start),
    removed: a.slice(start, endA),
    added: b.slice(start, endB),
    ctxAfter: a.slice(endA, Math.min(a.length, endA + 2)),
  };
}
async function ghGet(path: string, ghHeaders: Record<string, string>) {
  const api = `https://api.github.com/repos/${REPO}/contents/${path}`;
  const res = await fetch(api + "?ref=" + BRANCH, { headers: ghHeaders });
  if (!res.ok) return null;
  const j = await res.json();
  return { content: new TextDecoder().decode(decodeBase64(j.content)), sha: j.sha as string };
}

// ---- extracción de title/description del frontmatter ----
// Los patrones reales del sitio: `const title = {"en":"…", …};` (JSON una línea),
// `const title = {\n  en: '…',\n};` (objeto multi-línea con comillas simples) y
// referencias tipo `{ "en": d.title }` — por eso: JSON.parse primero, regex por
// idioma después, y si nada parsea se devuelve el raw tal cual (la IA ve el archivo
// entero igual; esto es solo para el ANTES→DESPUÉS del dashboard).
function grabConst(src: string, name: string): string | null {
  const m = src.match(new RegExp("const\\s+" + name + "\\s*=\\s*([\\s\\S]*?);[ \\t]*\\n"));
  return m ? m[1].trim() : null;
}
function parseMeta(raw: string | null): Record<string, string> | string | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    if (typeof v === "string" || (v && typeof v === "object")) return v as Record<string, string> | string;
  } catch { /* sigue el plan B */ }
  const out: Record<string, string> = {};
  const re = /["']?(en|de|es)["']?\s*:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) out[m[1]] = m[2].slice(1, -1).replace(/\\(['"])/g, "$1");
  if (Object.keys(out).length) return out;
  const s = raw.match(/^["'](.*)["']$/s);
  return s ? s[1] : raw;
}
// el body (todo lo que viene después del frontmatter) NO se puede tocar en este flujo
function bodyOf(src: string): string {
  const m = src.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/);
  return (m ? m[1] : src).trim();
}

type Q = { query?: string; impressions?: number; position?: number; ctr?: number };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const auth = req.headers.get("Authorization") ?? "";
  const supabase = createClient(SB_URL, SB_ANON, { global: { headers: { Authorization: auth } } });
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json({ error: "unauthorized" }, 401);
  if (!GH_TOKEN) return json({ error: "Falta el secret GITHUB_TOKEN en Supabase." }, 500);
  const ghHeaders = {
    "Authorization": `Bearer ${GH_TOKEN}`,
    "Accept": "application/vnd.github+json",
    "User-Agent": "viven-dashboard",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  try {
    const body = await req.json();
    const page = String(body.page || "");
    const queries: Q[] = Array.isArray(body.queries) ? body.queries.slice(0, 8) : [];
    if (!page) return json({ error: "falta page" }, 400);

    let path = urlToPath(page);
    if (!isAllowedPath(path)) return json({ error: `path no permitido: ${path ?? "(inválido)"}` }, 400);
    let file = await ghGet(path, ghHeaders);
    if (!file) {
      const fb = langFallbackPath(path);
      if (fb && isAllowedPath(fb)) { file = await ghGet(fb, ghHeaders); if (file) path = fb; }
    }
    if (!file) return json({ error: `No pude leer ${path} de GitHub — ¿la URL corresponde a una página real del sitio?` }, 404);
    const { content: original, sha } = file;

    const curTitleRaw = grabConst(original, "title");
    const curDescRaw = grabConst(original, "description");
    if (!curTitleRaw) return json({ error: "No encontré `const title = …` en el frontmatter de " + path + " — esta página no se puede mejorar desde acá." }, 422);

    const qTable = queries.length
      ? queries.map((q, i) => `${i + 1}. "${q.query}" — ${q.impressions ?? "?"} impresiones, posición ${q.position != null ? (+q.position).toFixed(1) : "?"}, CTR ${q.ctr != null ? ((+q.ctr) * 100).toFixed(1) + "%" : "?"}`).join("\n")
      : "(sin datos de queries — optimizá por el tema evidente de la página)";

    const prompt = `Sos el SEO de viven.ch (productora de video en Zúrich, Suiza). Te paso el código fuente completo de una página Astro real de producción y las búsquedas reales por las que aparece en Google (Search Console). Tu ÚNICA tarea: proponer un <title> y una meta description nuevos que suban el CTR, y devolver el archivo completo con SOLO esos valores cambiados.

Página: ${page}
Búsquedas reales (la primera es la principal):
${qTable}

Title actual (frontmatter): ${curTitleRaw}
Meta description actual (frontmatter): ${curDescRaw ?? "(no encontrada)"}

Reglas del title: máximo 60 caracteres por idioma, la keyword principal (o su traducción natural a ese idioma) al INICIO, y si el title actual termina en "| Viven" mantené ese sufijo.
Reglas de la meta description: máximo 155 caracteres por idioma, con un beneficio concreto y un llamado a la acción.
Idiomas: cada valor va EN EL IDIOMA que le corresponde. Si el frontmatter define los 3 idiomas (en/de/es), proponé los 3; si define uno solo, proponé solo ese.

FORMATO EXACTO de tu respuesta (sin markdown fences, sin explicación extra, nada más):
Línea 1: un JSON en UNA sola línea: {"rationale":"por qué esto sube el CTR (1-2 frases, en español)","title":{"en":"…"},"description":{"en":"…"}} — title y description con SOLO los idiomas que la página realmente tiene como claves.
Línea 2: exactamente -----FILE-----
Después: el archivo ENTERO, de la primera línea a la última, con SOLO los valores de title y description cambiados en el frontmatter (mismo formato de objeto/comillas que ya usa el archivo). NO toques NADA más: ni el body, ni imports, ni el JSON-LD, ni data-attributes, ni el formato del resto del frontmatter.

Archivo fuente completo:
${original}`;

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      // SIN prefill: messages termina en user; la respuesta se parsea filtrando type==="text"
      body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 16000, messages: [{ role: "user", content: prompt }] }),
    });
    if (!res.ok) {
      const t = await res.text();
      console.error("ANTHROPIC_ERROR", res.status, t);
      return json({ error: `Anthropic ${res.status}: ${t.slice(0, 300)}` });
    }
    const aiData = await res.json();
    let raw = ((aiData.content ?? []) as { type: string; text?: string }[])
      .filter((c) => c.type === "text").map((c) => c.text ?? "").join("").trim();
    raw = raw.replace(/^```[a-z]*\n?/i, "").replace(/```$/, "").trim();

    const sep = raw.indexOf("-----FILE-----");
    if (sep < 0) return json({ error: "La IA no respetó el formato (falta el separador de archivo) — no se generó ningún cambio." }, 500);
    let header: { rationale?: string; title?: Record<string, string>; description?: Record<string, string> } = {};
    try { header = JSON.parse(raw.slice(0, sep).trim()); } catch {
      return json({ error: "La IA no respetó el formato (cabecera JSON inválida) — no se generó ningún cambio." }, 500);
    }
    const updated = raw.slice(sep + "-----FILE-----".length).replace(/^\r?\n/, "").trim();

    // ---- salvavidas (mismas reglas estrictas que apply-link-suggest) ----
    if (updated.length < original.length * 0.85) {
      return json({ error: "La IA devolvió un archivo sospechosamente más corto que el original — no se generó ningún cambio, por seguridad." }, 500);
    }
    const propTitle = header.title && typeof header.title === "object" ? header.title : null;
    const propDesc = header.description && typeof header.description === "object" ? header.description : null;
    if (!propTitle || !Object.keys(propTitle).length) {
      return json({ error: "La IA no propuso ningún title — no se generó ningún cambio." }, 500);
    }
    for (const v of Object.values(propTitle)) {
      if (!v || !updated.includes(v)) return json({ error: "El title nuevo no quedó incluido en el archivo que devolvió la IA — no se generó ningún cambio." }, 500);
    }
    // el body tiene que quedar EXACTAMENTE igual: este flujo solo toca el frontmatter
    if (bodyOf(updated) !== bodyOf(original)) {
      return json({ error: "La IA tocó contenido fuera del frontmatter — no se generó ningún cambio, por seguridad." }, 500);
    }
    // límites duros por idioma: avisar, no bloquear (el dashboard muestra el contador)
    const over = [
      ...Object.entries(propTitle).filter(([, v]) => (v || "").length > 65).map(([k]) => `title ${k}`),
      ...Object.entries(propDesc || {}).filter(([, v]) => (v || "").length > 165).map(([k]) => `description ${k}`),
    ];

    return json({
      ok: true,
      path,
      sha,
      current: { title: parseMeta(curTitleRaw), desc: parseMeta(curDescRaw) },
      proposal: { title: propTitle, desc: propDesc || {} },
      rationale: String(header.rationale || ""),
      overLimit: over,
      updated,
      diff: computeDiff(original, updated),
    });
  } catch (e) {
    console.error("FUNCTION_ERROR", String(e));
    return json({ error: String(e) }, 500);
  }
});
