// Supabase Edge Function: cola-a-repo
//
// EL PROBLEMA: Sebastián aprueba cosas desde el teléfono y caen en work_queue.
// Ahí se quedaban esperando a que una sesión mía las mirara — las dos del 14 de
// agosto esperaron diez días. Un agente programado en la nube podría trabajarlas
// solo, pero corre en la infraestructura de Anthropic y NO tiene credenciales de
// esta base: no puede leer work_queue ni debería poder.
//
// LA SOLUCIÓN: invertir la dirección. Esta function corre acá, donde sí hay
// permisos, y deja la cola ESCRITA en el repo (.claude/cola-de-trabajo.md). El
// agente lee un archivo del repo que ya clona igual, sin credenciales de por
// medio y sin exponer la base.
//
// Y avisa: manda una push con lo que quedó pendiente. Aprobar sin enterarse de
// nada es lo que hacía que la cola no sirviera.
//
// Deploy: supabase functions deploy cola-a-repo --no-verify-jwt
// Auth:   Authorization: Bearer <CRON_SECRET>

import { createClient } from "jsr:@supabase/supabase-js@2";

const service = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";
const GH_TOKEN = Deno.env.get("GITHUB_TOKEN")!;
const REPO = Deno.env.get("GITHUB_REPO") || "Viven1/viven-astro-website";
// Rama PROPIA, que no publica nada: el deploy solo corre con pushes a main.
// Escribir la cola en main dispararía un deploy del sitio entero por un archivo
// de texto y además metería cambios en main sin que Sebastián los apruebe —
// justo lo que pidió evitar. Acá la cola vive aislada y el agente la lee de esta
// rama, que nunca toca producción.
const BRANCH = Deno.env.get("COLA_BRANCH") || "cola-de-trabajo";
const RUTA = ".claude/cola-de-trabajo.md";

const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } });
const gh = {
  "Authorization": `Bearer ${GH_TOKEN}`,
  "Accept": "application/vnd.github+json",
  "User-Agent": "viven-cola",
  "X-GitHub-Api-Version": "2022-11-28",
};

Deno.serve(async (req) => {
  const token = (req.headers.get("Authorization") || "").replace("Bearer ", "").trim();
  if (!CRON_SECRET || token !== CRON_SECRET) return json({ error: "no autorizado" }, 401);

  const { data: pendientes, error } = await service
    .from("work_queue")
    .select("id, source, title, detail, url, approved_at, status")
    .in("status", ["pending", "doing"])
    .order("approved_at");
  if (error) return json({ error: error.message }, 500);

  const hoy = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Zurich" });
  const dias = (iso: string) => Math.floor((Date.now() - new Date(iso).getTime()) / 864e5);

  const cuerpo = [
    "<!-- Lo escribe sola la function cola-a-repo, todos los días. No editar a mano. -->",
    "# Cola de trabajo aprobada por Sebastián",
    "",
    `Actualizada: ${hoy} · ${pendientes?.length ?? 0} pendientes`,
    "",
    "Cada ítem lo aprobó Sebastián desde el teléfono. El agente diario los trabaja",
    "y deja un PR; el merge sigue siendo decisión suya.",
    "",
    ...(pendientes?.length
      ? pendientes.flatMap((p) => [
          `## #${p.id} — ${p.title}`,
          `- **Esperando:** ${dias(p.approved_at)} días (aprobado ${String(p.approved_at).slice(0, 10)})`,
          `- **Origen:** ${p.source}${p.url ? ` · ${p.url}` : ""}`,
          "",
          `${p.detail ?? ""}`,
          "",
        ])
      : ["_No hay nada pendiente._", ""]),
  ].join("\n");

  // ¿cambió respecto de lo que ya está en el repo? si no, no commitear por commitear
  const url = `https://api.github.com/repos/${REPO}/contents/${RUTA}`;
  const actual = await fetch(`${url}?ref=${BRANCH}`, { headers: gh });
  let sha: string | undefined;
  if (actual.ok) {
    const j = await actual.json();
    sha = j.sha;
    const previo = new TextDecoder().decode(
      Uint8Array.from(atob(String(j.content).replace(/\s/g, "")), (c) => c.charCodeAt(0)),
    );
    if (previo.replace(/Actualizada:.*/, "") === cuerpo.replace(/Actualizada:.*/, "")) {
      return json({ ok: true, sin_cambios: true, pendientes: pendientes?.length ?? 0 });
    }
  }

  const put = await fetch(url, {
    method: "PUT",
    headers: { ...gh, "Content-Type": "application/json" },
    body: JSON.stringify({
      message: `cola: ${pendientes?.length ?? 0} pendientes al ${hoy}`,
      content: btoa(String.fromCharCode(...new TextEncoder().encode(cuerpo))),
      branch: BRANCH,
      ...(sha ? { sha } : {}),
    }),
  });
  if (!put.ok) return json({ error: `GitHub ${put.status}: ${(await put.text()).slice(0, 200)}` }, 502);

  // avisar: sin esto la cola vuelve a ser un lugar donde las cosas se pierden
  const viejas = (pendientes ?? []).filter((p) => dias(p.approved_at) >= 3);
  if (viejas.length) {
    await service.functions.invoke("push-send", {
      body: {
        title: `🤖 ${viejas.length} aprobadas esperando`,
        body: viejas.slice(0, 3).map((p) => `${p.title} (${dias(p.approved_at)}d)`).join(" · "),
        url: "https://www.viven.ch/dashboard/?tab=hoy",
      },
    }).catch(() => {});
  }

  return json({ ok: true, pendientes: pendientes?.length ?? 0, avisadas: viejas.length });
});
