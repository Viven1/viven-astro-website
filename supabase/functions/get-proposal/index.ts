// Supabase Edge Function: get-proposal
// Devuelve el contenido de una propuesta pública SOLO si el password es correcto.
// Usa service role (el rol anon no tiene acceso a la tabla). Quita los costos internos
// antes de responder → el cliente nunca ve costo ni margen.
//
// Deploy:  supabase functions deploy get-proposal --no-verify-jwt

import { createClient } from "jsr:@supabase/supabase-js@2";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

// quita cualquier costo/margen interno del contenido que se manda al cliente
function stripInternal(content: any) {
  const c = JSON.parse(JSON.stringify(content || {}));
  (c.tiers || []).forEach((t: any) => {
    delete t.cost; delete t.margin;
    (t.items || []).forEach((it: any) => { delete it.cost; });
  });
  (c.addon_groups || []).forEach((g: any) => (g.items || []).forEach((it: any) => { delete it.cost; }));
  return c;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const { slug, password } = await req.json();
    if (!slug) return json({ error: "missing slug" }, 400);
    const admin = createClient(SB_URL, SERVICE);
    const { data, error } = await admin.from("proposals").select("*").eq("slug", slug).maybeSingle();
    if (error) return json({ error: error.message });
    if (!data) return json({ error: "not_found" }, 404);
    // password: si la propuesta tiene clave, exigirla
    if (data.password && String(password || "") !== String(data.password)) {
      return json({ error: "wrong_password", locked: true }, 401);
    }
    // contar la vista (best-effort)
    await admin.from("proposals").update({ views: (data.views || 0) + 1 }).eq("id", data.id);
    return json({
      ok: true,
      title: data.title,
      client_name: data.client_name,
      status: data.status,
      accepted: data.status === "accepted"
        ? { at: data.accepted_at, name: data.accepted_name, tier: data.accepted_tier, total: data.accepted_total }
        : null,
      content: stripInternal(data.content),
    });
  } catch (e) {
    return json({ error: String(e) });
  }
});
