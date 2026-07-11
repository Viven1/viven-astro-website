// Supabase Edge Function: publish-blog
// Publica un artículo directo a la web: commitea el .astro al repo de GitHub → Netlify
// reconstruye solo → queda live con SEO completo (páginas estáticas). Un click desde el dashboard.
//
// Deploy:  supabase functions deploy publish-blog --no-verify-jwt
// Secrets: GITHUB_TOKEN (fine-grained PAT con Contents: Read/Write sobre el repo)
//          GITHUB_REPO  (opcional, default "Viven1/viven-astro-website")

import { createClient } from "jsr:@supabase/supabase-js@2";
import { encodeBase64 } from "jsr:@std/encoding/base64";

const GH_TOKEN = Deno.env.get("GITHUB_TOKEN")!;
const REPO = Deno.env.get("GITHUB_REPO") || "Viven1/viven-astro-website";
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_ANON = Deno.env.get("SUPABASE_ANON_KEY")!;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    // solo el dashboard logueado puede publicar
    const auth = req.headers.get("Authorization") ?? "";
    const supabase = createClient(SB_URL, SB_ANON, { global: { headers: { Authorization: auth } } });
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return json({ error: "unauthorized" }, 401);
    if (!GH_TOKEN) return json({ error: "Falta el secret GITHUB_TOKEN en Supabase." }, 500);

    const { path, content, message } = await req.json();
    // seguridad: solo permitimos publicar blogs (nada de tocar otros archivos)
    if (typeof path !== "string" || !/^src\/pages\/(en|de|es)\/blog\/[a-z0-9\-]+\/index\.astro$/.test(path)) {
      return json({ error: "path no permitido (solo src/pages/<lang>/blog/<slug>/index.astro)" }, 400);
    }
    if (typeof content !== "string" || content.length < 50) return json({ error: "contenido vacío" }, 400);

    const api = `https://api.github.com/repos/${REPO}/contents/${path}`;
    const ghHeaders = {
      "Authorization": `Bearer ${GH_TOKEN}`,
      "Accept": "application/vnd.github+json",
      "User-Agent": "viven-dashboard",
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    // si el archivo ya existe necesitamos su sha para actualizarlo
    let sha: string | undefined;
    const getRes = await fetch(api + "?ref=main", { headers: ghHeaders });
    if (getRes.ok) { const j = await getRes.json(); sha = j.sha; }

    const putRes = await fetch(api, {
      method: "PUT",
      headers: ghHeaders,
      body: JSON.stringify({
        message: message || `blog: publicar ${path}`,
        content: encodeBase64(content),
        branch: "main",
        ...(sha ? { sha } : {}),
      }),
    });
    if (!putRes.ok) {
      const t = await putRes.text();
      console.error("GITHUB_ERROR", putRes.status, t);
      return json({ error: `GitHub ${putRes.status}: ${t.slice(0, 300)}` });
    }
    const j = await putRes.json();
    return json({ ok: true, updated: !!sha, commit: j.commit?.html_url });
  } catch (e) {
    console.error("FUNCTION_ERROR", String(e));
    return json({ error: String(e) });
  }
});
