// Supabase Edge Function: lugar-rodaje
// De un texto de dirección saca: la posición, el link al mapa, el viaje desde VIVEN y la
// hora de la luz de ese día.
//
// Sebastián, 26 ago 2026: "lo hacemos con geolocación de la dirección del lugar" y
// "calcular también dirección de VIVEN AG a lugar de rodaje".
//
// ── Por qué se guarda en el proyecto ──
// Geocodificar y rutear son dos llamadas a servicios ajenos con límite de uso. La dirección
// de un rodaje no cambia, así que se resuelve UNA vez y queda en el proyecto. Se vuelve a
// pedir solo si el texto de la dirección cambió.
//
// ── Lo que NO hace ──
// No inventa. Si Nominatim no encuentra la dirección, devuelve el motivo y la pantalla lo
// dice: mandar a diez personas a una posición aproximada es peor que decirles que falta.
//
// Deploy: supabase functions deploy lugar-rodaje

import { createClient } from "jsr:@supabase/supabase-js@2";
import { solEn } from "../_shared/sol.ts";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

/* La base. Está en la oferta y en el pie del sitio; acá se repite porque es de donde sale
   el kilometraje que se le factura al cliente. */
const BASE = { texto: "Zeughausstrasse 31, 8004 Zürich", lat: 47.3757, lon: 8.5270 };

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const auth = req.headers.get("Authorization") ?? "";
    const u = createClient(SB_URL, SB_ANON, { global: { headers: { Authorization: auth } } });
    const { data: { user } } = await u.auth.getUser();
    if (!user) return json({ error: "unauthorized" }, 401);

    const body = await req.json().catch(() => ({}));
    const direccion = String(body.direccion || "").trim();
    const fecha = String(body.fecha || "").slice(0, 10);
    if (!direccion) return json({ error: "Sin dirección no hay nada que calcular. Cargá la locación del proyecto." });

    /* Nominatim pide un User-Agent que identifique la aplicación; sin él responde 403.
       Y se le da Suiza como sesgo: "Zeughausstrasse 31" existe en varias ciudades. */
    let pos: { lat: number; lon: number; nombre: string } | null = null;
    let motivo: string | null = null;
    try {
      const q = new URLSearchParams({ q: direccion, format: "jsonv2", limit: "1", countrycodes: "ch,de,at,fr,it" });
      const r = await fetch("https://nominatim.openstreetmap.org/search?" + q, {
        headers: { "User-Agent": "viven-crm/1.0 (info@viven.ch)", "Accept-Language": "de,en" },
      });
      if (r.ok) {
        const j = await r.json();
        if (Array.isArray(j) && j[0]) {
          pos = { lat: Number(j[0].lat), lon: Number(j[0].lon), nombre: String(j[0].display_name || direccion) };
        } else {
          motivo = "No se encontró esa dirección. Probá con la calle, el número y la ciudad.";
        }
      } else {
        motivo = "El buscador de direcciones no contestó (" + r.status + ").";
      }
    } catch (e) {
      motivo = "No se pudo buscar la dirección: " + String(e).slice(0, 80);
    }

    const maps = "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(direccion);

    if (!pos) {
      return json({ ok: true, direccion, maps, encontrada: false, motivo,
                    viaje: null, luz: null, base: BASE.texto });
    }

    /* El viaje EN AUTO desde la base. OSRM público: sin key, y si no contesta se dice —
       la distancia en línea recta no sirve para un plan de rodaje. */
    let viaje: { min: number; km: number } | null = null;
    let viajeMotivo: string | null = null;
    try {
      const ruta = `${BASE.lon},${BASE.lat};${pos.lon},${pos.lat}`;
      const r2 = await fetch(`https://router.project-osrm.org/route/v1/driving/${ruta}?overview=false`);
      if (r2.ok) {
        const j2 = await r2.json();
        const ru = j2 && Array.isArray(j2.routes) ? j2.routes[0] : null;
        if (ru) viaje = { min: Math.round(ru.duration / 60), km: Math.round(ru.distance / 100) / 10 };
        else viajeMotivo = "No se encontró una ruta en auto hasta ahí.";
      } else viajeMotivo = "El calculador de rutas no contestó (" + r2.status + ").";
    } catch (e) {
      viajeMotivo = "No se pudo calcular la ruta: " + String(e).slice(0, 80);
    }

    /* La luz. Se calcula de la posición y la fecha — no se pide a ningún servicio. */
    const luz = fecha ? solEn(pos.lat, pos.lon, fecha) : null;

    return json({
      ok: true, direccion, encontrada: true, nombre: pos.nombre,
      lat: pos.lat, lon: pos.lon, maps,
      viaje, viaje_motivo: viajeMotivo, base: BASE.texto,
      luz, luz_fuente: luz && luz.amanece ? "calculado de la dirección" : null,
      luz_motivo: !fecha ? "El proyecto no tiene fecha de rodaje." : null,
    });
  } catch (e) {
    console.error("FUNCTION_ERROR", String(e));
    return json({ error: String(e) }, 500);
  }
});
