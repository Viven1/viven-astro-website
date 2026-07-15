// Supabase Edge Function: apply-link-suggest
// El paso "confirmar y deployar" de ⚔️ Canibalización (Search Console): edita la
// página REAL en GitHub insertando el link sugerido, y commitea a producción —
// pero en DOS pasos, nunca a ciegas:
//   1) mode:"preview" (default) → la IA genera el archivo con el link insertado,
//      NO commitea nada, devuelve un diff real (líneas agregadas/contexto) para
//      que Sebastián vea EXACTAMENTE qué va a cambiar antes de aprobar.
//   2) mode:"commit" → recibe el `updated`+`sha` que el paso 1 ya devolvió (no
//      vuelve a llamar a la IA) y commitea ESO, tal cual se mostró — así lo que
//      se aprueba es lo que se deploya, sin margen para que un segundo call a
//      la IA devuelva algo distinto de lo que se revisó.
//
// Mismo mecanismo de publicación que publish-blog (commit directo vía GitHub
// Contents API a la rama "dev", Cloudflare redeploya solo).
//
// Deploy:  supabase functions deploy apply-link-suggest --no-verify-jwt
// Secrets: GITHUB_TOKEN, GITHUB_REPO (opcional), ANTHROPIC_API_KEY (ya seteados)

import { createClient } from "jsr:@supabase/supabase-js@2";
import { encodeBase64, decodeBase64 } from "jsr:@std/encoding/base64";

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

// mapeo 1:1 URL pública → archivo fuente, mismo patrón que usa todo el sitio
// (lang/segmentos/ → src/pages/lang/segmentos/index.astro).
function urlToPath(url: string): string | null {
  try {
    const u = new URL(url);
    const p = u.pathname.replace(/^\/+|\/+$/g, "");
    return p ? `src/pages/${p}/index.astro` : "src/pages/index.astro";
  } catch { return null; }
}
function isAllowedPath(path: string | null): path is string {
  return !!path && /^src\/pages\/(en|de|es)\/[a-z0-9\-/]+\/index\.astro$/.test(path) && !path.includes("dashboard");
}

// diff mínimo pero real: como a la IA se le pide SOLO insertar (nunca tocar el
// resto), el prefijo y el sufijo comunes delimitan exactamente la parte nueva —
// sin necesidad de traer una librería de diff completa.
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
    const mode = body.mode === "commit" ? "commit" : "preview";

    // ---- paso 2: commit del contenido YA revisado (sin volver a llamar la IA) ----
    if (mode === "commit") {
      const { path, sha, updated, anchor, strongUrl, query, weakUrl } = body;
      if (!isAllowedPath(path) || !updated || !sha) return json({ error: "faltan datos o path no permitido" }, 400);
      const putRes = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}`, {
        method: "PUT",
        headers: { ...ghHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({
          message: `seo: link interno "${anchor}" → ${strongUrl} (canibalización: ${query})`,
          content: encodeBase64(updated),
          branch: BRANCH,
          sha,
        }),
      });
      if (!putRes.ok) {
        const t = await putRes.text();
        console.error("GITHUB_ERROR", putRes.status, t);
        return json({ error: `GitHub ${putRes.status}: ${t.slice(0, 300)}` });
      }
      const putJson = await putRes.json();
      return json({ ok: true, path, liveUrl: weakUrl, commitUrl: putJson.commit?.html_url || "" });
    }

    // ---- paso 1: generar el cambio + diff, SIN commitear ----
    const { weakUrl, strongUrl, anchor, snippet, placement, query } = body;
    if (!weakUrl || !strongUrl || !anchor || !snippet) return json({ error: "faltan datos" }, 400);

    const path = urlToPath(weakUrl);
    // allowlist estricta: solo páginas de contenido localizadas, nunca el dashboard
    // ni nada fuera de src/pages.
    if (!isAllowedPath(path)) return json({ error: `path no permitido: ${path ?? "(inválido)"}` }, 400);

    const file = await ghGet(path, ghHeaders);
    if (!file) return json({ error: `No pude leer ${path} de GitHub — ¿la URL corresponde a una página real del sitio?` }, 404);
    const { content: original, sha } = file;

    // la IA inserta el link EN el archivo real, preservando todo lo demás — modelo
    // fuerte (no Haiku) porque acá la fidelidad de reproducción del resto del
    // archivo importa mucho más que en un blog nuevo desde cero.
    const prompt = `Te paso el código fuente completo de una página Astro real de producción. Tu ÚNICA tarea es insertar UN link interno nuevo, de forma natural, en el texto visible de la página — y devolver el archivo COMPLETO con ese único cambio.

Link a insertar: <a href="${strongUrl}">${anchor}</a>
Oración de referencia (adaptala al tono/idioma real de la página, no la copies literal si no encaja): "${snippet}"
Dónde insertarlo: ${placement || "en un lugar natural del contenido, cerca del final"}
Búsqueda que motiva el link (para tu contexto, no la repitas literal): "${query}"

Reglas ESTRICTAS:
- Devolvé el archivo ENTERO, de la primera línea a la última, sin resumir ni truncar nada.
- NO toques el frontmatter (--- ... ---), imports, ni ninguna otra parte del código o contenido — SOLO agregá el link en un punto natural del texto visible.
- NO agregues explicación, comentarios, ni markdown fences (\`\`\`) — tu respuesta entera debe ser el contenido crudo del archivo .astro, nada más.
- Si no encontrás un lugar natural para el link sin alterar el sentido del texto, agregalo como una oración corta nueva cerca de donde indica "Dónde insertarlo".

Archivo fuente completo:
${original}`;

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 8000, messages: [{ role: "user", content: prompt }] }),
    });
    if (!res.ok) {
      const t = await res.text();
      console.error("ANTHROPIC_ERROR", res.status, t);
      return json({ error: `Anthropic ${res.status}: ${t.slice(0, 300)}` });
    }
    const aiData = await res.json();
    let updated = (aiData.content?.[0]?.text ?? "").trim();
    updated = updated.replace(/^```[a-z]*\n?/i, "").replace(/```$/, "").trim();

    // salvavidas: si la IA truncó o mangleó el archivo, no queda nada para aprobar.
    if (updated.length < original.length * 0.85) {
      return json({ error: "La IA devolvió un archivo sospechosamente más corto que el original — no se generó ningún cambio, por seguridad." }, 500);
    }
    if (!updated.includes(strongUrl)) {
      return json({ error: "El link no quedó insertado en el resultado de la IA — no se generó ningún cambio." }, 500);
    }

    return json({ ok: true, path, sha, updated, diff: computeDiff(original, updated) });
  } catch (e) {
    console.error("FUNCTION_ERROR", String(e));
    return json({ error: String(e) }, 500);
  }
});
