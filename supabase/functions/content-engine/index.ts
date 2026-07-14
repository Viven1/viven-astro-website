// Supabase Edge Function: content-engine
// El MOTOR DE CONTENIDO: corre por cron lunes/miércoles/viernes, toma el próximo
// tema de content_queue, escribe el artículo en EN + su versión NATIVA en DE
// (misma lógica y prompt que ai-blog), los guarda como BORRADORES en blogs
// (nunca publica solo — Sebastián aprueba en el tab Blog) y avisa por push.
//
// Deploy:   supabase functions deploy content-engine --no-verify-jwt
// Schedule: SQL 0032 (cron L/M/V 05:30 UTC ≈ 07:30 CH)
// Secrets:  ANTHROPIC_API_KEY, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY (ya seteados)

import { createClient } from "jsr:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const service = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } });

// Media por categoría: MUCHAS imágenes reales por categoría (no una sola) +
// video solo cuando encaja. pickMedia() consulta blogs.hero_image para saber
// qué se usó y CUÁNDO, y siempre prioriza la que lleva más tiempo sin salir
// (o nunca salió) — así nunca se repite dos veces seguidas y, si el pool de
// la categoría es chico, el repeat queda espaciado semanas por diseño en vez
// de por suerte.
const P = "/projects/";
const MEDIA: Record<string, { imgs: string[]; video?: string }> = {
  corporate: { imgs: [
    P + "stadtspital-zurich-mis-spital-mis-laebe/01-pital_Mis_L_be_VIVEN_Video_Agency_011.jpeg",
    P + "stadtspital-zurich-mis-spital-mis-laebe/04-Spital_Mis_L_be_VIVEN_Video_Agency_018.jpg",
    P + "stadtspital-zurich-mis-spital-mis-laebe/06-Spital_Mis_L_be_VIVEN_Video_Agency_017.jpg",
    P + "stadtspital-zurich-women-in-medicine/01-men_in_Medicine_VIVEN_Video_Agency_015.jpg",
    P + "stadtspital-zurich-women-in-medicine/03-men_in_Medicine_VIVEN_Video_Agency_016.jpg",
    P + "kyan-health-making-mental-well-being-a-superpower-at-work/01-th__VIVEN_Video_Film_Production-005.jpeg",
    P + "kyan-health-making-mental-well-being-a-superpower-at-work/04-th__VIVEN_Video_Film_Production-008.jpeg",
    P + "kyan-health-making-mental-well-being-a-superpower-at-work/06-th__VIVEN_Video_Film_Production-006.jpeg",
    P + "devenir-a-merkle-interactive-experience/01-Devenir_Merkle_VIVEN_Video_Agency_044.jpg",
    P + "devenir-a-merkle-interactive-experience/04-Devenir_Merkle_VIVEN_Video_Agency_017.jpg",
    P + "devenir-a-merkle-interactive-experience/06-Devenir_Merkle_VIVEN_Video_Agency_016.jpg",
  ], video: "861150876" },
  employer: { imgs: [
    P + "siemens-shaping-the-future-together-employer-branding-campaign/01-RORES_clean_VIVEN.00_18_49_20.Still052.jpg",
    P + "siemens-shaping-the-future-together-employer-branding-campaign/04-RORES_clean_VIVEN.00_10_04_04.Still034.jpg",
    P + "siemens-shaping-the-future-together-employer-branding-campaign/06-RORES_clean_VIVEN.00_18_16_23.Still051.jpg",
    P + "siemens-shaping-the-future-together-employer-branding-campaign/08-RORES_clean_VIVEN.00_00_29_06.Still017.jpg",
    P + "kpmg-consultepreneur-employer-branding/01-UNIVERSUM_KPMG_2.jpeg",
    P + "kpmg-consultepreneur-employer-branding/03-UNIVERSUM_KPMG_15.jpg",
    P + "kpmg-consultepreneur-employer-branding/05-UNIVERSUM_KPMG_3.jpeg",
    P + "kpmg-consultepreneur-employer-branding/07-UNIVERSUM_KPMG_7.jpeg",
    P + "ubs-coffee-stain-employer-branding-campaign/01-randing_Campaign_Viven_Video_Agency_7.jpeg",
    P + "ubs-coffee-stain-employer-branding-campaign/03-randing_Campaign_Viven_Video_Agency_5.jpeg",
    P + "ubs-coffee-stain-employer-branding-campaign/05-randing_Campaign_Viven_Video_Agency_8.jpeg",
    P + "ubs-coffee-stain-employer-branding-campaign/07-randing_Campaign_Viven_Video_Agency_9.jpeg",
    P + "ubs-more-than-code-employer-branding/01-S_Tech_Employer_Branding_Campaign_2.jpeg",
    P + "ubs-more-than-code-employer-branding/04-S_Tech_Employer_Branding_Campaign_7.jpeg",
    P + "ubs-more-than-code-employer-branding/06-S_Tech_Employer_Branding_Campaign_3.jpeg",
    P + "employer-branding-campaign-for-lem/01-LEM_Employer_Branding_Video_Agentur_7.jpg",
    P + "employer-branding-campaign-for-lem/03-LEM_Employer_Branding_Video_Agentur_11.jpg",
    P + "employer-branding-campaign-for-lem/05-LEM_Employer_Branding_Video_Agentur_1.jpg",
    P + "employer-branding-campaign-for-lem/07-LEM_Employer_Branding_Video_Agentur_5.jpg",
  ], video: "412290258" },
  product: { imgs: [
    P + "meteomatics-product-campaign-brand-video/02-Meteomatics_VIVEN_Video_Agentur_040.jpg",
    P + "meteomatics-product-campaign-brand-video/04-Meteomatics_VIVEN_Video_Agentur_030.jpg",
    P + "meteomatics-product-campaign-brand-video/06-Meteomatics_VIVEN_Video_Agentur_063.jpg",
    P + "meteomatics-product-campaign-brand-video/08-Meteomatics_VIVEN_Video_Agentur_002.jpg",
    P + "anybotics-anymal-c-product-launch/01-on2019-08-22-12h10m12s489-1-1024x512.jpg",
    P + "anybotics-anymal-c-product-launch/03-tion2019-08-22-12h09m05s955-1024x512.jpg",
    P + "anybotics-anymal-c-product-launch/05-C_VIVEN_AG_Video_Production_1024x512.jpg",
    P + "franke-the-office-hero-horeca-product-launch/01-ro__VIVEN_Video_Film_Production-007.jpeg",
    P + "franke-the-office-hero-horeca-product-launch/04-ro__VIVEN_Video_Film_Production-004.jpeg",
    P + "franke-the-office-hero-horeca-product-launch/07-ca__VIVEN_Video_Film_Production-004.jpeg",
    P + "franke-the-office-hero-horeca-product-launch/10-ca__VIVEN_Video_Film_Production-005.jpeg",
    P + "v-zug-combair-600-how-to-video-campaign/01-UG_How_To_Videos_Viven_Video_Agency_38.jpg",
    P + "v-zug-combair-600-how-to-video-campaign/04-UG_How_To_Videos_Viven_Video_Agency_23.jpg",
    P + "v-zug-combair-600-how-to-video-campaign/07-ZUG_How_To_Videos_Viven_Video_Agency_8.jpg",
  ], video: "1068759296" },
  social: { imgs: [
    P + "fifa-living-football-social-media-campaign/01-Living_Football_Viven_Video_Agentur6.jpeg",
    P + "fifa-living-football-social-media-campaign/03-Living_Football_Viven_Video_Agentur10.jpeg",
    P + "fifa-living-football-social-media-campaign/05-Living_Football_Viven_Video_Agentur11.jpeg",
    P + "fifa-living-football-social-media-campaign/07-Living_Football_Viven_Video_Agentur15.jpeg",
    P + "carvolution-tvc-social-media-campaign/01-2sec_EN_B_v20210824_COMPOSED.Still0013.jpg",
    P + "carvolution-tvc-social-media-campaign/03-2sec_EN_B_v20210824_COMPOSED.Still009.jpeg",
    P + "carvolution-tvc-social-media-campaign/05-sec_EN_B_v20210824_COMPOSED.Still0012.jpeg",
    P + "carvolution-tvc-social-media-campaign/07-2sec_EN_B_v20210824_COMPOSED.Still005.jpeg",
    P + "nile-spring-winter-campaign/01-Nile_Winter_Campaign_1.jpeg",
    P + "nile-spring-winter-campaign/03-Nile_Winter_Campaign_3.jpeg",
    P + "nile-spring-winter-campaign/05-Nile_Spring_Campaign10.jpeg",
    P + "nile-spring-winter-campaign/07-Nile_Spring_Campaign2.jpeg",
    P + "porsche-on-the-road-to-electromobility/01-tric_Transfer_Social_Media_Campaign_6.jpeg",
    P + "porsche-on-the-road-to-electromobility/04-ric_Transfer_Social_Media_Campaign_14.jpeg",
    P + "porsche-on-the-road-to-electromobility/07-ric_Transfer_Social_Media_Campaign_15.jpeg",
  ], video: "828322230" },
  howto: { imgs: [
    P + "kanebo-sensai-skincare-how-to-video-campaign/01-re_How_To_Videos_Viven_Video_Agency_51.jpg",
    P + "kanebo-sensai-skincare-how-to-video-campaign/03-re_How_To_Videos_Viven_Video_Agency_54.jpg",
    P + "kanebo-sensai-skincare-how-to-video-campaign/05-re_How_To_Videos_Viven_Video_Agency_53.jpg",
    P + "kanebo-sensai-skincare-how-to-video-campaign/07-re_How_To_Videos_Viven_Video_Agency_23.jpg",
    P + "v-zug-combair-600-how-to-video-campaign/02-UG_How_To_Videos_Viven_Video_Agency_20.jpg",
    P + "v-zug-combair-600-how-to-video-campaign/05-UG_How_To_Videos_Viven_Video_Agency_18.jpg",
    P + "v-zug-combair-600-how-to-video-campaign/08-ZUG_How_To_Videos_Viven_Video_Agency_6.jpg",
  ], video: "1026464530" },
  event: { imgs: [
    P + "fifa-living-football-social-media-campaign/02-Living_Football_Viven_Video_Agentur17.jpeg",
    P + "fifa-living-football-social-media-campaign/04-Living_Football_Viven_Video_Agentur9.jpeg",
    P + "fifa-living-football-social-media-campaign/06-Living_Football_Viven_Video_Agentur3.jpeg",
    P + "fifa-living-football-social-media-campaign/08-Living_Football_Viven_Video_Agentur14.jpeg",
    P + "nile-spring-winter-campaign/02-Nile_Winter_Campaign_4.jpeg",
    P + "nile-spring-winter-campaign/04-Nile_Winter_Campaign_6.jpeg",
    P + "nile-spring-winter-campaign/06-Nile_Spring_Campaign13.jpeg",
    P + "nile-spring-winter-campaign/08-Nile_Winter_Campaign_5.jpeg",
    P + "devenir-a-merkle-interactive-experience/02-Devenir_Merkle_VIVEN_Video_Agency_030.jpg",
    P + "devenir-a-merkle-interactive-experience/05-Devenir_Merkle_VIVEN_Video_Agency_020.jpg",
    P + "devenir-a-merkle-interactive-experience/07-Devenir_Merkle_VIVEN_Video_Agency_003.jpg",
  ], video: "757649241" },
  brand: { imgs: [
    P + "sv-group-innovation-film-brand-video/01-Inovation_film_VIVEN_Video_Agentur_018.jpg",
    P + "sv-group-innovation-film-brand-video/03-Inovation_film_VIVEN_Video_Agentur_002.jpg",
    P + "sv-group-innovation-film-brand-video/05-Inovation_film_VIVEN_Video_Agentur_017.jpg",
    P + "sv-group-innovation-film-brand-video/07-Inovation_film_VIVEN_Video_Agentur_008.jpg",
    P + "nccr-robotics-brand-video/01-Brand_Video_Viven_Video_Production_19.jpg",
    P + "nccr-robotics-brand-video/03-Brand_Video_Viven_Video_Production_24.jpg",
    P + "nccr-robotics-brand-video/05-s_Brand_Video_Viven_Video_Production_7.jpg",
    P + "nccr-robotics-brand-video/07-Brand_Video_Viven_Video_Production_13.jpg",
    P + "pmi-why-science-matters-brand-video/02-VIVEN_Film_Production_Why_Science_010.jpeg",
    P + "pmi-why-science-matters-brand-video/04-VIVEN_Film_Production_Why_Science_004.jpeg",
    P + "pmi-why-science-matters-brand-video/06-VIVEN_Film_Production_Why_Science_027.jpeg",
    P + "pmi-why-science-matters-brand-video/08-VIVEN_Film_Production_Why_Science_033.jpeg",
    P + "sevensense-brand-video/01-Sevensense_Brand_Video_13.jpg",
    P + "sevensense-brand-video/03-Sevensense_Brand_Video_14.jpg",
    P + "sevensense-brand-video/05-Sevensense_Brand_Video_18.jpg",
    P + "sevensense-brand-video/07-Sevensense_Brand_Video_3.jpg",
    P + "villa-malaga-el-tiempo-de-un-vino-documentary-film/01-Villa_Malaga_Doc_1.jpg",
    P + "villa-malaga-el-tiempo-de-un-vino-documentary-film/03-Villa_Malaga_Doc_4.jpg",
    P + "villa-malaga-el-tiempo-de-un-vino-documentary-film/05-Villa_Malaga_Doc_3.jpg",
  ], video: "502153490" },
  process: { imgs: [
    P + "siemens-shaping-the-future-together-employer-branding-campaign/02-RORES_clean_VIVEN.00_13_13_20.Still042.jpg",
    P + "siemens-shaping-the-future-together-employer-branding-campaign/03-RORES_clean_VIVEN.00_09_29_23.Still033.jpg",
    P + "siemens-shaping-the-future-together-employer-branding-campaign/05-RORES_clean_VIVEN.00_12_48_09.Still040.jpg",
    P + "siemens-shaping-the-future-together-employer-branding-campaign/07-RORES_clean_VIVEN.00_20_12_10.Still059.jpg",
    P + "himmelfahrtskommando-feature-film/01-Feature_Film_Himmelfahrtskommando3.jpeg",
    P + "himmelfahrtskommando-feature-film/03-Feature_Film_Himmelfahrtskommando2.jpeg",
    P + "himmelfahrtskommando-feature-film/05-Feature_Film_Himmelfahrtskommando1.jpeg",
    P + "singularity-sci-fi-feature-film/01-Singularity_Feature_Film_7.jpeg",
    P + "singularity-sci-fi-feature-film/03-Singularity_Feature_Film_6.jpeg",
    P + "singularity-sci-fi-feature-film/05-Singularity_Feature_Film_4.jpeg",
    P + "porsche-on-the-road-to-electromobility/02-tric_Transfer_Social_Media_Campaign_7.jpeg",
    P + "porsche-on-the-road-to-electromobility/05-ric_Transfer_Social_Media_Campaign_11.jpeg",
    P + "porsche-on-the-road-to-electromobility/08-ric_Transfer_Social_Media_Campaign_16.jpeg",
  ] },
  general: { imgs: [
    P + "carvolution-tvc-social-media-campaign/02-2sec_EN_B_v20210824_COMPOSED.Still006.jpeg",
    P + "carvolution-tvc-social-media-campaign/04-2sec_EN_B_v20210824_COMPOSED.Still008.jpeg",
    P + "carvolution-tvc-social-media-campaign/06-sec_EN_B_v20210824_COMPOSED.Still0011.jpeg",
    P + "carvolution-tvc-social-media-campaign/08-2sec_EN_B_v20210824_COMPOSED.Still002.jpeg",
    P + "devenir-a-merkle-interactive-experience/03-Devenir_Merkle_VIVEN_Video_Agency_024.jpg",
    P + "devenir-a-merkle-interactive-experience/08-Devenir_Merkle_VIVEN_Video_Agency_008.jpg",
    P + "kyan-health-making-mental-well-being-a-superpower-at-work/02-th__VIVEN_Video_Film_Production-009.jpeg",
    P + "kyan-health-making-mental-well-being-a-superpower-at-work/05-th__VIVEN_Video_Film_Production-001.jpeg",
    P + "kyan-health-making-mental-well-being-a-superpower-at-work/07-th__VIVEN_Video_Film_Production-003.jpeg",
    P + "villa-malaga-el-tiempo-de-un-vino-documentary-film/02-Villa_Malaga_Doc_2.jpg",
    P + "villa-malaga-el-tiempo-de-un-vino-documentary-film/04-Villa_Malaga_Doc_7.jpg",
    P + "villa-malaga-el-tiempo-de-un-vino-documentary-film/06-Villa_Malaga_Doc_5.jpg",
  ] },
};

function classify(topic: string): string {
  const t = topic.toLowerCase();
  return /corporate|internal comm/.test(t) ? "corporate"
    : /employer|recruit|talent|gen z/.test(t) ? "employer"
    : /product/.test(t) ? "product"
    : /social/.test(t) ? "social"
    : /how-to|explainer|support|onboarding|e-learning/.test(t) ? "howto"
    : /event|stream|trade show/.test(t) ? "event"
    : /cost|price|roi|choose|brief|timeline|process|shoot day|batch/.test(t) ? "process"
    : /brand|marketing|video seo|multilingual|trend/.test(t) ? "brand" : "general";
}
// Elige la imagen del pool de la categoría que lleva MÁS tiempo sin usarse
// (o nunca usada), consultando el historial real de blogs.hero_image — así
// nunca se repite la misma seguida y, si hay que repetir, es porque ya
// pasaron semanas (todo el resto del pool también se usó hace poco).
async function pickMedia(topic: string): Promise<{ hero: string; video: string | null }> {
  const cat = classify(topic);
  const m = MEDIA[cat] || MEDIA.general;
  const { data: recent } = await service.from("blogs").select("hero_image, created_at").not("hero_image", "is", null).order("created_at", { ascending: false }).limit(200);
  const lastUsed: Record<string, number> = {};
  (recent ?? []).forEach((r: { hero_image: string; created_at: string }) => {
    const t = new Date(r.created_at).getTime();
    if (!(r.hero_image in lastUsed) || t > lastUsed[r.hero_image]) lastUsed[r.hero_image] = t;
  });
  const scored = m.imgs.map((img) => ({ img, last: lastUsed[img] ?? 0 })).sort((a, b) => a.last - b.last);
  // entre las 3 menos usadas recientemente, elegimos al azar (variedad sin perder el criterio de antigüedad)
  const pool = scored.slice(0, Math.min(3, scored.length));
  const hero = pool[Math.floor(Math.random() * pool.length)].img;
  return { hero, video: m.video || null };
}

const INTERNAL = ["services/brand-video", "services/product-video", "services/employer-branding", "services/how-to-video", "services/social-media-video", "services/corporate-video", "projects", "contact", "faq", "blog", "resources"];

// ---- feedback de keyword+ranking (SQL 0076) --------------------------------
// Sebastián no quiere juzgar un tema "solo por el texto" — quiere el DATO de
// en qué posición está HOY la keyword objetivo antes de decidir si escribir
// el blog vale la pena. Mismo patrón de OAuth que gsc-stats/ai-keywords.
async function googleToken(): Promise<string> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: Deno.env.get("GOOGLE_CLIENT_ID")!,
      client_secret: Deno.env.get("GOOGLE_CLIENT_SECRET")!,
      refresh_token: Deno.env.get("GOOGLE_REFRESH_TOKEN")!,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) throw new Error("google_token " + res.status + " " + (await res.text()).slice(0, 160));
  return (await res.json()).access_token;
}
// Posición ACTUAL (últimos 28 días) de una keyword exacta en Search Console.
// Si no hay fila (0 impresiones / nunca buscada), position vuelve null — ese
// es justamente el dato de "sin visibilidad hoy", no un error.
async function gscKeywordPosition(keyword: string): Promise<{ position: number | null; impressions: number }> {
  try {
    const token = await googleToken();
    let site = Deno.env.get("GSC_SITE") || "";
    if (!site) {
      const sres = await fetch("https://searchconsole.googleapis.com/webmasters/v3/sites", { headers: { Authorization: "Bearer " + token } });
      const entries = sres.ok ? ((await sres.json()).siteEntry ?? []) : [];
      const ok = entries.filter((e: { permissionLevel?: string }) => e.permissionLevel !== "siteUnverifiedUser").map((e: { siteUrl: string }) => e.siteUrl);
      const pref = ["sc-domain:viven.ch", "https://www.viven.ch/", "https://viven.ch/"];
      site = pref.find((p) => ok.includes(p)) || ok[0] || "https://viven.ch/";
    }
    const end = new Date(Date.now() - 2 * 864e5), start = new Date(end.getTime() - 28 * 864e5);
    const ymd = (x: Date) => x.toISOString().slice(0, 10);
    const res = await fetch(`https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site)}/searchAnalytics/query`, {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({
        startDate: ymd(start), endDate: ymd(end),
        dimensions: ["query"],
        dimensionFilterGroups: [{ filters: [{ dimension: "query", operator: "equals", expression: keyword }] }],
        rowLimit: 1,
      }),
    });
    if (!res.ok) return { position: null, impressions: 0 };
    const rows = (await res.json()).rows ?? [];
    if (!rows.length) return { position: null, impressions: 0 };
    return { position: Number(rows[0].position), impressions: Number(rows[0].impressions || 0) };
  } catch (e) {
    console.error("GSC_KEYWORD_LOOKUP_ERROR", String(e));
    return { position: null, impressions: 0 }; // best-effort: nunca tumba la escritura del artículo por esto
  }
}
// Veredicto DETERMINÍSTICO (reglas fijas, no otra opinión de la IA) — mismos
// cortes que usa el SEO Keyword Manager (SQL 0070) para clasificar quick_win.
const KW_VERDICT_LABEL: Record<string, string> = {
  nuevo: "nuevo, sin ranking previo",
  quick_win: "quick win",
  ya_rankea_bien: "ya rankea bien — reconsiderar",
  dudoso: "dudoso, validar volumen",
  sin_keyword: "sin keyword objetivo",
};
function keywordVerdict(targetKeyword: string | null, gsc: { position: number | null; impressions: number }): { verdict: string; why: string } {
  if (!targetKeyword) return { verdict: "sin_keyword", why: "Tema libre, sin keyword objetivo asociado — no hay dato de ranking para evaluar." };
  if (gsc.position == null) return { verdict: "nuevo", why: "Sin visibilidad hoy — contenido genuinamente nuevo, vale la pena si hay volumen de búsqueda real." };
  if (gsc.impressions < 3) {
    return { verdict: "dudoso", why: "Posición actual muy baja (" + gsc.position.toFixed(1) + ") o casi sin impresiones (" + gsc.impressions + " en 28 días) — validar si hay volumen de búsqueda real antes de invertir en el artículo." };
  }
  if (gsc.position <= 3) return { verdict: "ya_rankea_bien", why: "Ya rankea en el top 3 (posición " + gsc.position.toFixed(1) + ") — escribir contenido nuevo para esta keyword probablemente no suma mucho; considerá reforzar la página existente en vez de un artículo nuevo." };
  if (gsc.position <= 20) return { verdict: "quick_win", why: "Ya tenés tracción (posición " + gsc.position.toFixed(1) + ") — este es justamente el rango donde un artículo nuevo/reforzado puede empujarla a primera página. Alta probabilidad de que valga la pena." };
  return { verdict: "dudoso", why: "Posición actual muy baja (" + gsc.position.toFixed(1) + ") o casi sin impresiones — validar si hay volumen de búsqueda real antes de invertir en el artículo." };
}
// Contexto REAL de competencia (pedido explícito de Sebastián: no solo nuestro
// propio dato de ranking, sino qué está pasando AFUERA ahora mismo para esa
// keyword) — una llamada a Claude con la tool web_search, mismo patrón que
// ai-keywords/index.ts pero acotada (2-3 búsquedas, no una investigación
// completa) porque acá es solo un chequeo de contexto antes de escribir.
// Corre UNA vez por grupo (no 3x por idioma) — best-effort: si falla, el
// artículo se escribe igual, solo sin el párrafo de contexto de competencia.
async function webSearchKeywordContext(keyword: string): Promise<string> {
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 500,
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }],
        messages: [{ role: "user", content: `Sos el estratega SEO de viven.ch, productora de video en Zúrich (compite en el mercado suizo/DACH). Buscá en Google AHORA MISMO la keyword "${keyword}" y contame, en 2-3 frases MUY concretas (nada genérico): ¿quiénes son los resultados top HOY (dominios reales), qué ángulo o formato cubren, y qué tan difícil parece competir por esa keyword? Respondé SOLO esas 2-3 frases en español, texto plano, sin JSON, sin markdown, sin preámbulo.` }],
      }),
    });
    if (!res.ok) return "";
    const data = await res.json();
    const text = (data.content ?? []).filter((c: { type: string }) => c.type === "text").map((c: { text: string }) => c.text).join(" ").trim();
    return text.replace(/\s+/g, " ").slice(0, 600);
  } catch (e) {
    console.error("KW_WEBSEARCH_ERROR", String(e));
    return "";
  }
}

async function pushAll(title: string, body: string, url: string) {
  const pub = Deno.env.get("VAPID_PUBLIC_KEY"), priv = Deno.env.get("VAPID_PRIVATE_KEY");
  if (!pub || !priv) return;
  webpush.setVapidDetails("mailto:info@viven.ch", pub, priv);
  const { data: subs } = await service.from("push_subscriptions").select("*");
  const payload = JSON.stringify({ title, body, url });
  for (const s of subs ?? []) {
    try { await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload); }
    catch (e) { const c = (e as { statusCode?: number }).statusCode; if (c === 404 || c === 410) await service.from("push_subscriptions").delete().eq("id", s.id); }
  }
}

async function writeArticle(topic: string, lang: string, localize: boolean) {
  const language = lang === "de" ? "German" : lang === "es" ? "Spanish" : "English";
  const market = lang === "de" ? "Swiss/DACH (German-speaking)" : lang === "es" ? "Spanish-speaking (Spain + Latin America, and Spanish speakers in Switzerland)" : "international";
  const localizeNote = localize
    ? `\n\nIMPORTANT — this is the ${language} version of an existing article on the same subject. Do NOT translate. Write a fresh, NATIVE ${language} article: research mentally what keywords a ${language}-speaking audience in the ${market} market ACTUALLY types into Google for this topic (their real search phrasing, not a translation of the English keyword), and use those exact terms naturally in the title, H2s, slug and body. Localize examples, currency framing and search intent. It must read as originally written for that market.`
    : "";
  const prompt = `You write SEO blog articles for VIVEN AG, a video production company in Zürich (clients: UBS, Siemens, Porsche, ON, FIFA, Philips). Goal: rank on Google + AI overviews and drive leads.

Write a complete, genuinely useful article in ${language} about: "${topic}".${localizeNote}

Rules:
- 700–1100 words. Natural, expert, non-fluffy. Answer the search intent directly in the first paragraph.
- German = SWISS High German: NEVER use "ß" — always "ss" (Strasse, gross, heisst, ausserdem). This is non-negotiable for a Swiss company.
- Structure: a strong lead paragraph, then 4–6 <h2> sections (with <h3> and <ul> where useful). No <h1>.
- Weave in 2–4 internal links using EXACTLY this placeholder form: [[slug|anchor text]] where slug is one of: ${INTERNAL.join(", ")}. Use them naturally.
- Never claim the founder made a "Netflix original" — the correct fact is: produced the first Swiss feature film on Netflix.
- End with a short CTA paragraph inviting the reader to contact Viven.
- Add 3 FAQ Q&A pairs for schema (concise answers).
- SEO title ≤ 60 chars ("| Viven" is added by us). Meta description ≤ 155 chars.
- slug: kebab-case, ascii.

Respond ONLY with valid minified JSON, no markdown fences:
{"title":"...","slug":"...","description":"...","eyebrow":"Industry insight","lead":"first paragraph, plain text","body_html":"<h2>...</h2><p>...</p>","faq":[{"q":"...","a":"..."}]}`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 4000,
      system: "You output ONLY a single valid minified JSON object. No markdown, no code fences, no commentary.",
      messages: [{ role: "user", content: prompt }, { role: "assistant", content: "{" }],
    }),
  });
  if (!res.ok) throw new Error("Anthropic " + res.status + " " + (await res.text()).slice(0, 200));
  const data = await res.json();
  let text = (data.content?.[0]?.text ?? "").trim();
  if (!text.startsWith("{")) text = "{" + text;
  text = text.replace(/```json|```/g, "").trim();
  const last = text.lastIndexOf("}");
  if (last > -1) text = text.slice(0, last + 1);
  let p: { title?: string; slug?: string; description?: string; eyebrow?: string; lead?: string; body_html?: string; faq?: unknown[] } | null = null;
  try { p = JSON.parse(text); } catch { p = null; }
  if (!p || !p.body_html) throw new Error("artículo inválido (" + lang + ")");
  if (lang === "de") { // Schweizer Hochdeutsch: sin ß, siempre ss (garantizado por código, no solo por prompt)
      for (const k of ["title", "description", "lead", "body_html"]) if (typeof p[k] === "string") p[k] = p[k].replaceAll("ß", "ss");
      if (Array.isArray(p.faq)) p.faq = p.faq.map((f: { q?: string; a?: string }) => ({ q: String(f.q ?? "").replaceAll("ß", "ss"), a: String(f.a ?? "").replaceAll("ß", "ss") }));
    }
    p.faq = Array.isArray(p.faq) ? p.faq.slice(0, 5) : [];
  p.slug = String(p.slug || topic).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 70);
  return p;
}

Deno.serve(async (req) => {
  try {
    // modo WRITE NOW: body {queue_id} escribe ESE tema ya (botón ⚡ del dashboard);
    // sin body: el cron toma el próximo pendiente por prioridad
    const body = await req.json().catch(() => ({}));
    let item: Record<string, unknown> | undefined;
    if (body.queue_id) {
      const { data: one, error: e1 } = await service.from("content_queue").select("*").eq("id", body.queue_id).neq("status", "working").maybeSingle();
      if (e1) return json({ error: e1.message }, 500);
      item = one ?? undefined;
      if (!item) return json({ error: "tema no encontrado (¿ya se está escribiendo?)" }, 404);
    } else {
      const { data: items, error } = await service.from("content_queue")
        .select("*").eq("status", "pending").order("priority", { ascending: false }).order("id").limit(1);
      if (error) return json({ error: error.message }, 500);
      item = (items ?? [])[0];
    }
    if (!item) return json({ ok: true, msg: "cola vacía — sembrá más temas en content_queue" });

    // feedback de keyword+ranking (SQL 0076): si el tema vino del SEO Keyword
    // Manager trae target_keyword — un solo lookup a GSC (no 3x, mismo dato
    // para las 3 versiones de idioma) + veredicto determinístico.
    const targetKeyword = (item.target_keyword as string | null | undefined)?.trim() || null;
    const kwGsc = targetKeyword ? await gscKeywordPosition(targetKeyword) : { position: null, impressions: 0 };
    const kw = keywordVerdict(targetKeyword, kwGsc);
    if (targetKeyword) {
      const ctx = await webSearchKeywordContext(targetKeyword);
      if (ctx) kw.why = kw.why + " Buscando en Google ahora: " + ctx;
    }

    await service.from("content_queue").update({ status: "working" }).eq("id", item.id);
    const groupId = crypto.randomUUID();
    const media = await pickMedia(item.topic);
    const made: { lang: string; id: number; title: string; lead: string; token: string | null; body: string; faq: { q: string; a: string }[] }[] = [];
    try {
      for (const [lg, loc] of [["en", false], ["de", true], ["es", true]] as [string, boolean][]) {
        const a = await writeArticle(item.topic, lg, loc);
        const token = crypto.randomUUID();
        // insert RESILIENTE: si faltan columnas nuevas (SQL 0034 sin correr), las saca y reintenta
        let row: Record<string, unknown> = {
          lang: lg, topic: item.topic, slug: a.slug, title: a.title, description: a.description,
          eyebrow: a.eyebrow || "Industry insight", lead: a.lead, body_html: a.body_html, faq: a.faq,
          status: "draft", group_id: groupId, hero_image: media.hero, video_id: media.video, approve_token: token,
          target_keyword: targetKeyword, keyword_current_position: kwGsc.position, keyword_verdict: kw.verdict, keyword_verdict_why: kw.why,
        };
        let ins = await service.from("blogs").insert(row).select("id").single();
        for (let tries = 0; ins.error && tries < 4; tries++) {
          const m = /'([^']+)' column/.exec(ins.error.message || "");
          if (!m || !(m[1] in row)) break;
          delete row[m[1]];
          ins = await service.from("blogs").insert(row).select("id").single();
        }
        if (ins.error) throw new Error("no pude guardar el borrador (" + lg + "): " + ins.error.message);
        made.push({ lang: lg.toUpperCase(), id: ins.data?.id, title: a.title, lead: a.lead || "", token: ("approve_token" in row) ? token : null, body: a.body_html || "", faq: (a.faq || []) as { q: string; a: string }[] });
      }
    } catch (e) {
      if (!made.length) { await service.from("content_queue").update({ status: "pending" }).eq("id", item.id); throw e; }
    }
    await service.from("content_queue").update({ status: "done", done_at: new Date().toISOString() }).eq("id", item.id);
    const kwPushLine = targetKeyword ? ` · 🎯 ${targetKeyword} · pos ${kwGsc.position != null ? kwGsc.position.toFixed(1) : "sin ranking"} · ${KW_VERDICT_LABEL[kw.verdict]}` : "";
    await pushAll("📝 Borradores listos: " + item.topic, made.map((m) => m.lang).join(" + ") + " esperan tu aprobación (email o tab Blog)." + kwPushLine, "/dashboard/");

    // email a Sebastián con preview + botones Publicar / Editar
    const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
    if (RESEND_API_KEY && made.length) {
      const FN = Deno.env.get("SUPABASE_URL") + "/functions/v1/blog-approve";
      // artículo COMPLETO legible en el email: hero + cuerpo entero + FAQ, botones arriba
      const clean = (h: string) => h.replace(/\[\[[^|\]]+\|([^\]]+)\]\]/g, "<strong>$1</strong>");
      // feedback de keyword+ranking (SQL 0076): mismo dato para las 3 versiones
      // de idioma, así que va UNA vez arriba de las cards, no repetido x3.
      const kwEmailBlock = targetKeyword ? `
        <div style="border:1px solid #dfe4ec;border-radius:12px;padding:14px 18px;margin:0 0 20px;background:#f7f9fc">
          <div style="font-size:13.5px;color:#1a2230"><b>🎯 Keyword objetivo:</b> ${targetKeyword} · <b>posición actual:</b> ${kwGsc.position != null ? kwGsc.position.toFixed(1) : "sin ranking — nuevo"} · <b>${KW_VERDICT_LABEL[kw.verdict]}</b></div>
          <div style="font-size:12.5px;color:#5b6472;margin-top:6px;line-height:1.6">${kw.why}</div>
        </div>` : "";
      const cards = made.map((m) => `
        <div style="border:1px solid #e3e6ec;border-radius:14px;padding:20px 22px;margin:0 0 22px">
          <div style="font-size:11px;letter-spacing:.08em;color:#8a94a8;font-weight:700">${m.lang}</div>
          <div style="font-size:19px;font-weight:700;margin:4px 0 12px">${m.title}</div>
          <div style="margin-bottom:14px">
            ${m.token ? `<a href="${FN}?id=${m.id}&t=${m.token}" style="display:inline-block;background:#ddf98f;color:#1c2508;font-weight:700;padding:10px 18px;border-radius:100px;text-decoration:none;margin-right:8px">🚀 Publicar ${m.lang}</a>` : ""}
            <a href="https://www.viven.ch/dashboard/" style="display:inline-block;border:1px solid #d5d9e2;color:#1a2230;font-weight:600;padding:10px 18px;border-radius:100px;text-decoration:none">✏️ Editar en el dashboard</a>
          </div>
          <img src="https://www.viven.ch${media.hero}" alt="" style="width:100%;border-radius:12px;margin-bottom:14px" />
          <div style="font-size:15px;color:#1a2230;line-height:1.7;font-style:italic;margin-bottom:12px">${m.lead}</div>
          <div style="font-size:14px;color:#333c4a;line-height:1.75">${clean(m.body)}</div>
          ${m.faq.length ? `<div style="margin-top:16px;padding-top:12px;border-top:1px solid #eceef2"><b style="font-size:13px">FAQ</b>${m.faq.map((f) => `<p style="font-size:13px;margin:8px 0 2px"><b>${f.q}</b><br>${f.a}</p>`).join("")}</div>` : ""}
          ${media.video ? `<p style="font-size:12.5px;color:#8a94a8;margin-top:12px">🎬 Al publicar se embebe también el video Vimeo ${media.video} al final del artículo.</p>` : ""}
        </div>`).join("");
      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: "Viven Content Engine <leads@viven.ch>", to: ["sebastian@viven.ch"],
          subject: "📝 Para aprobar: " + item.topic,
          html: `<div style="font-family:Inter,sans-serif;max-width:600px;margin:0 auto"><h2 style="font-size:18px">Nuevos borradores del motor de contenido</h2><p style="color:#5b6472;font-size:13.5px">Tema: <b>${item.topic}</b> · hero image ✓${media.video ? " · video ✓" : ""}. Un click en Publicar y sale a la web (deploy ~2 min); Editar abre el dashboard.</p>${kwEmailBlock}${cards}</div>`,
        }),
      }).catch(() => {});
    }
    return json({ ok: true, topic: item.topic, made: made.map((m) => m.lang) });
  } catch (e) {
    console.error("FUNCTION_ERROR", String(e));
    return json({ error: String(e) }, 500);
  }
});
