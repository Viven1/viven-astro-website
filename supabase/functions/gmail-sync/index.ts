// Supabase Edge Function: gmail-sync
// Poll cada 5 min (cron 0045) de las 3 casillas reales (sebastian@, sofia@,
// info@viven.ch) — trae mensajes nuevos del INBOX que vinieron de un email
// que YA conocemos como lead, y los guarda en email_log (direction:'in') para
// que el hilo del contacto muestre también lo que el cliente contesta.
// Mensajes de gente que no es un lead conocido se ignoran (no son "clientes").
//
// Deploy: supabase functions deploy gmail-sync --no-verify-jwt
// Secrets: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET (ya existen, mismo OAuth
//          client que Calendar/GSC/Ads), + GMAIL_REFRESH_TOKEN_SEBASTIAN,
//          GMAIL_REFRESH_TOKEN_SOFIA, GMAIL_REFRESH_TOKEN_INFO (nuevos —
//          ver instrucciones de autorización aparte).

import { createClient } from "jsr:@supabase/supabase-js@2";

const service = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID")!;
const CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET")!;

const MAILBOXES = [
  { key: "sebastian", email: "sebastian@viven.ch", refreshSecret: "GMAIL_REFRESH_TOKEN_SEBASTIAN" },
  { key: "sofia", email: "sofia@viven.ch", refreshSecret: "GMAIL_REFRESH_TOKEN_SOFIA" },
  { key: "info", email: "info@viven.ch", refreshSecret: "GMAIL_REFRESH_TOKEN_INFO" },
];

async function accessToken(refreshToken: string): Promise<string> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, refresh_token: refreshToken, grant_type: "refresh_token" }),
  });
  const j = await res.json();
  if (!res.ok) throw new Error("token_refresh_failed: " + JSON.stringify(j).slice(0, 200));
  return j.access_token;
}

// deno-lint-ignore no-explicit-any
function findPart(p: any, mime: string): any {
  if (!p) return null;
  if (p.mimeType === mime && p.body?.data) return p;
  for (const part of p.parts || []) {
    const f = findPart(part, mime);
    if (f) return f;
  }
  return null;
}
// deno-lint-ignore no-explicit-any
function decodeBody(payload: any): string {
  const plain = findPart(payload, "text/plain");
  const html = findPart(payload, "text/html");
  const raw = plain || html;
  if (!raw?.body?.data) return "";
  const b64 = raw.body.data.replace(/-/g, "+").replace(/_/g, "/");
  let text = "";
  try { text = decodeURIComponent(escape(atob(b64))); } catch (_e) { text = atob(b64); }
  if (raw === html) text = text.replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return text.slice(0, 20000);
}
function parseFrom(headerVal: string): { name: string; email: string } {
  const m = headerVal.match(/^(.*?)\s*<(.+?)>$/);
  if (m) return { name: m[1].replace(/"/g, "").trim(), email: m[2].toLowerCase().trim() };
  return { name: "", email: headerVal.trim().toLowerCase() };
}

Deno.serve(async (_req) => {
  try {
    const out: Record<string, unknown> = {};
    const { data: leads } = await service.from("leads").select("id,email").not("email", "is", null);
    const leadByEmail = new Map<string, string>();
    (leads ?? []).forEach((l: { id: string; email: string }) => { if (l.email) leadByEmail.set(l.email.toLowerCase().trim(), String(l.id)); });

    for (const mb of MAILBOXES) {
      const refreshToken = Deno.env.get(mb.refreshSecret);
      if (!refreshToken) { out[mb.key] = "sin_secret_" + mb.refreshSecret; continue; }
      try {
        const token = await accessToken(refreshToken);
        const { data: st } = await service.from("gmail_sync_state").select("*").eq("mailbox", mb.key).maybeSingle();
        const sinceTs = st?.last_synced_at ? Math.floor(new Date(st.last_synced_at).getTime() / 1000) : Math.floor((Date.now() - 24 * 3600e3) / 1000);
        const q = encodeURIComponent(`in:inbox after:${sinceTs}`);
        const listRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${q}&maxResults=30`, { headers: { Authorization: "Bearer " + token } });
        const listJ = await listRes.json();
        if (!listRes.ok) { out[mb.key] = "list_error: " + JSON.stringify(listJ).slice(0, 200); continue; }
        let matched = 0, seen = 0;
        for (const m of listJ.messages ?? []) {
          seen++;
          const msgRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=full`, { headers: { Authorization: "Bearer " + token } });
          const msg = await msgRes.json();
          if (!msgRes.ok) continue;
          const headers = (msg.payload?.headers ?? []) as { name: string; value: string }[];
          const fromH = headers.find((h) => h.name === "From")?.value || "";
          const subjH = headers.find((h) => h.name === "Subject")?.value || "";
          const { name, email } = parseFrom(fromH);
          const leadId = leadByEmail.get(email);
          if (!leadId) continue; // no es un lead conocido — no es "cliente", lo ignoramos
          const { data: exists } = await service.from("email_log").select("id").eq("source", "gmail-" + mb.key).eq("gmail_id", m.id).maybeSingle();
          if (exists) continue;
          const body = decodeBody(msg.payload) || msg.snippet || "";
          await service.from("email_log").insert({
            lead_id: leadId, to_addr: mb.email, subject: subjH, body,
            sender_label: name || email, source: "gmail-" + mb.key, direction: "in", gmail_id: m.id,
          });
          await service.from("leads").update({ last_reply_at: new Date().toISOString() }).eq("id", leadId).then(() => {}, () => {});
          matched++;
        }
        await service.from("gmail_sync_state").upsert({ mailbox: mb.key, last_synced_at: new Date().toISOString() });
        out[mb.key] = { seen, matched };
      } catch (e) {
        out[mb.key] = "error: " + String(e);
      }
    }
    return new Response(JSON.stringify({ ok: true, ...out }), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    console.error("FUNCTION_ERROR", String(e));
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
});
