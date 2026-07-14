// Supabase Edge Function: vimeo-stats
// Estadísticas OFICIALES de Vimeo (play count / duración) para complementar el
// tracking propio del panel 🎬 Video analytics — nuestro tracking (video_plays,
// hitos 25/50/75/100) es confiable pero es NUESTRO; esto trae el número que
// Vimeo mismo reporta para cruzar/validar. Sin VIMEO_ACCESS_TOKEN configurado
// responde { pending: true } (mismo patrón que gads-stats) y el dashboard sigue
// mostrando solo el tracking propio — nunca rompe nada.
//
// Deploy:   supabase functions deploy vimeo-stats --no-verify-jwt
// Secret:   VIMEO_ACCESS_TOKEN (Personal Access Token, scope "Public"+"Private"
//           alcanza para GET /videos/{id} — no hace falta un token de Business/
//           Enterprise; el play count básico viene en stats.plays).

import { createClient } from "jsr:@supabase/supabase-js@2";

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
    const auth = req.headers.get("Authorization") ?? "";
    const supabase = createClient(SB_URL, SB_ANON, { global: { headers: { Authorization: auth } } });
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return json({ error: "unauthorized" }, 401);

    const token = Deno.env.get("VIMEO_ACCESS_TOKEN") || "";
    if (!token) return json({ pending: true, reason: "falta el secret VIMEO_ACCESS_TOKEN" });

    const body = await req.json().catch(() => ({}));
    const ids: string[] = Array.isArray(body.video_ids) ? body.video_ids.map(String).filter(Boolean).slice(0, 40) : [];
    if (!ids.length) return json({ stats: {} });

    const stats: Record<string, { plays: number | null; duration: number | null; name: string | null }> = {};
    const warnings: string[] = [];
    // Vimeo no tiene un endpoint "batch" simple por ids sueltos — GET /videos/{id}
    // en paralelo (son pocos videos por página, esto corre 1x por carga del tab).
    await Promise.all(ids.map(async (id) => {
      try {
        const res = await fetch(`https://api.vimeo.com/videos/${encodeURIComponent(id)}?fields=name,duration,stats.plays`, {
          headers: { Authorization: "Bearer " + token, Accept: "application/vnd.vimeo.*+json;version=3.4" },
        });
        if (!res.ok) { warnings.push(id + ": " + res.status); return; }
        const v = await res.json();
        stats[id] = { plays: v?.stats?.plays ?? null, duration: v?.duration ?? null, name: v?.name ?? null };
      } catch (e) { warnings.push(id + ": " + String((e as Error).message || e)); }
    }));

    const out: Record<string, unknown> = { stats };
    if (warnings.length) out.warnings = warnings;
    return json(out);
  } catch (e) {
    console.error("FUNCTION_ERROR", String(e));
    return json({ error: String(e) }, 500);
  }
});
