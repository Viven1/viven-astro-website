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

// Además de Supabase, el lead también va a HubSpot (mismo portal/form que el
// contact form del sitio y el embed de las landings de Ads) — pedido de
// Sebastián 2026-07-28: TODO lead de viven.ch sincronizado en ambos sistemas.
// Best-effort: nunca bloquea ni rompe la respuesta real si HubSpot falla.
async function hubspotSubmit(opts: { firstname?: string; lastname?: string; email: string; company?: string; message?: string }) {
  try {
    await fetch("https://api.hsforms.com/submissions/v3/integration/submit/4084680/994b80e1-84c2-42de-a5a1-ea2145608d76", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fields: [
          { name: "firstname", value: opts.firstname || "" },
          { name: "lastname", value: opts.lastname || "" },
          { name: "email", value: opts.email },
          { name: "company", value: opts.company || "-" },
          { name: "message", value: opts.message || "" },
        ],
        context: { pageUri: "https://www.viven.ch/" },
      }),
    });
  } catch (_e) { /* best-effort */ }
}

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
    await hubspotSubmit({ email, message: magnet.label });

    const { data, error } = await service.storage.from("magnets").createSignedUrl(magnet.file(lang), 300);
    if (error || !data?.signedUrl) return json({ error: "no se pudo firmar: " + (error?.message || "?") }, 500);
    return json({ ok: true, url: data.signedUrl });
  } catch (e) {
    console.error("FUNCTION_ERROR", String(e));
    return json({ error: String(e) }, 500);
  }
});
