// Supabase Edge Function: magnet-download
// Gate REAL del lead magnet: el PDF vive en el bucket PRIVADO 'magnets' —
// no hay URL pública. El cliente manda {email, magnet, lang(+atribución)},
// acá se crea el lead (server-side, service role) y se devuelve una URL
// FIRMADA de 5 minutos. Sin email válido no hay link; compartir el link
// vencido no sirve.
//
// Deploy: supabase functions deploy magnet-download --no-verify-jwt

import { createClient } from "jsr:@supabase/supabase-js@2";

const service = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

// el cliente NO elige el archivo — solo el magnet+lang; el mapeo vive acá
// (nadie puede pedir paths arbitrarios del bucket).
const MAGNETS: Record<string, { file: (lang: string) => string; label: string }> = {
  "social-formats": {
    file: (lang) => `viven-social-video-cheatsheet-2026-${["en", "de", "es"].includes(lang) ? lang : "en"}.pdf`,
    label: "Lead magnet: social media formats",
  },
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const b = await req.json().catch(() => ({}));
    const email = String(b.email || "").trim().toLowerCase();
    const magnet = MAGNETS[String(b.magnet || "")];
    const lang = String(b.lang || "en");
    if (!magnet) return json({ error: "magnet desconocido" }, 400);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: "email inválido" }, 400);

    // lead (best-effort: el PDF no se le niega a un humano por un hipo del insert)
    try {
      const row: Record<string, unknown> = {
        name: "", first_name: "", email, message: magnet.label,
        form_path: String(b.form_path || ""), lang,
      };
      if (b.session_id) row.session_id = b.session_id;
      if (b.channel) row.channel = b.channel;
      if (b.utm_source) row.utm_source = b.utm_source;
      if (b.landing_path) row.landing_path = b.landing_path;
      await service.from("leads").insert(row);
    } catch (e) { console.error("LEAD_INSERT_WARN", String(e)); }

    const { data, error } = await service.storage.from("magnets").createSignedUrl(magnet.file(lang), 300);
    if (error || !data?.signedUrl) return json({ error: "no se pudo firmar: " + (error?.message || "?") }, 500);
    return json({ ok: true, url: data.signedUrl });
  } catch (e) {
    console.error("FUNCTION_ERROR", String(e));
    return json({ error: String(e) }, 500);
  }
});
