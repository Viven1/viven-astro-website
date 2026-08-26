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
// Lee de la rama que está PUBLICADA. Antes leía de "dev", que el 24 ago 2026
// estaba 8 commits atrás de main: una página creada hoy no existía ahí y el
// botón fallaba con un 404 que el dashboard mostraba como "non-2xx".
const BRANCH = Deno.env.get("GITHUB_BRANCH") || "main";
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
/* GitHub devuelve el contenido en base64 CON saltos de línea cada 60 caracteres.
   decodeBase64 se atraganta con ellos y tira "Cannot decode input as base64:
   Invalid character (\n)" — un 500 que el dashboard mostraba como "non-2xx" sin
   más detalle. Por eso el botón 🤖 Mejorar no funcionó NUNCA: fallaba acá, antes
   siquiera de llamar a la IA. Se limpian los espacios antes de decodificar. */
async function ghGet(path: string, ghHeaders: Record<string, string>) {
  const api = `https://api.github.com/repos/${REPO}/contents/${path}`;
  const res = await fetch(api + "?ref=" + BRANCH, { headers: ghHeaders });
  if (!res.ok) return null;
  const j = await res.json();
  return { content: new TextDecoder().decode(decodeBase64(String(j.content).replace(/\s/g, ""))), sha: j.sha as string };
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

FORMATO EXACTO de tu respuesta: UN JSON en una sola línea, sin markdown, sin nada más:
{"rationale":"por qué esto sube el CTR (1-2 frases, en español)","title":{"en":"…"},"description":{"en":"…"}}

Frontmatter actual (solo para que veas el formato y los idiomas):
Archivo fuente completo:
${curTitleRaw}\n${curDescRaw}`;

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      // SIN prefill: messages termina en user; la respuesta se parsea filtrando type==="text"
      body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 2000, messages: [{ role: "user", content: prompt }] }),
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

    /* La IA ya NO devuelve el archivo. Antes se le pedía que reescribiera las 35 KB
       enteras para cambiar dos líneas: si la respuesta se pasaba del techo se cortaba,
       y la función la rechazaba por seguridad — ese era el fallo que veía Sebastián.
       Ahora propone solo los textos y el reemplazo lo hace este código, que no puede
       tocar nada fuera del frontmatter porque solo sustituye esas dos asignaciones. */
    let header: { rationale?: string; title?: Record<string, string>; description?: Record<string, string> } = {};
    const soloJson = raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
    try { header = JSON.parse(soloJson); } catch {
      return json({ error: `La IA no devolvió el JSON esperado · stop_reason=${aiData.stop_reason} · empieza con: ${raw.slice(0, 120)}` });
    }
    const propTitle = header.title && typeof header.title === "object" ? header.title : null;
    const propDesc = header.description && typeof header.description === "object" ? header.description : null;
    if (!propTitle || !Object.keys(propTitle).length) {
      return json({ error: "La IA no propuso ningún title — no se generó ningún cambio." });
    }

    /* Reemplazo determinista: mismas claves de idioma que ya tenía el archivo.
       parseMeta() puede devolver TRES cosas —un objeto por idioma, un string suelto o
       null— y acá se usaba el resultado como si siempre fuera un objeto:
         · null  → Object.keys(null) revienta y la función se cae con un 500 sin motivo.
         · string → Object.keys("Mi título") devuelve ["0","1","2"…] y el frontmatter
                    quedaba reescrito como {"0":"M","1":"i",…}. Nada aguas abajo lo
                    frenaba: la guarda de seguridad compara el CUERPO del archivo, no el
                    frontmatter.
       Hoy las 355 páginas tienen el título como objeto, así que no explotó nunca; la
       rama existe porque alguien previó el caso, y una que no puede pasar hasta que pasa
       es peor que una que falla claro. Ahora devuelve null y el reemplazo se saltea. */
    const comoEstaba = (crudo: string, nuevos: Record<string, string>): string | null => {
      const actual = parseMeta(crudo);
      if (!actual) return null;                       // no se pudo leer: no se toca
      if (typeof actual === "string") {
        // el archivo no tiene versiones por idioma: se pone UN valor, no un objeto
        const uno = nuevos.en ?? Object.values(nuevos)[0];
        return uno ? JSON.stringify(uno) : null;
      }
      const salida: Record<string, string> = {};
      for (const k of Object.keys(actual)) salida[k] = nuevos[k] ?? actual[k];
      return JSON.stringify(salida);
    };
    let updated = original;
    if (curTitleRaw) {
      const t2 = comoEstaba(curTitleRaw, propTitle);
      if (t2) updated = updated.replace(curTitleRaw, t2);
    }
    if (curDescRaw && propDesc) {
      const d2 = comoEstaba(curDescRaw, propDesc);
      if (d2) updated = updated.replace(curDescRaw, d2);
    }
    if (updated === original) {
      return json({ error: "El reemplazo no cambió nada — el frontmatter no tiene el formato esperado." });
    }
    if (bodyOf(updated) !== bodyOf(original)) {
      return json({ error: "El reemplazo tocó algo fuera del frontmatter — no se generó ningún cambio, por seguridad." });
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
