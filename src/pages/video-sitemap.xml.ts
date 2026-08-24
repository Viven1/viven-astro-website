// Video sitemap AUTO-GENERADO en cada build (antes: public/video-sitemap.xml
// a mano — mismo problema que el sitemap principal: se desactualizaba, y
// mezclaba thumbnails de vumbnail/vimeocdn que pueden romperse).
// Fuente: projects.json (1 video por página de proyecto, thumbnail propio) +
// los 3 case studies narrativos + el showreel de la home.
import projects from '../data/projects.json';

const SITE = 'https://www.viven.ch';
const esc = (s: string) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

type Entry = { loc: string; player: string; thumb: string; title: string; desc: string };

export async function GET() {
  const entries: Entry[] = [];

  for (const p of projects as Record<string, any>[]) {
    if (!p.slug || !p.vimeo || !p.stills || !p.stills.length) continue;
    entries.push({
      loc: `${SITE}/${p.slug}/`,
      player: `https://player.vimeo.com/video/${p.vimeo}`,
      thumb: p.stills[0].startsWith('http') ? p.stills[0] : SITE + p.stills[0],
      title: [p.client, p.headline].filter(Boolean).join(' — '),
      desc: p.headline || [p.service, p.client].filter(Boolean).join(' for '),
    });
  }

  // case studies narrativos (mismos datos que su VideoObject en la página)
  const CASES: { path: string; vimeo: string; thumb: string; title: string }[] = [
    { path: '/en/case-study-meteomatics-simplifying-complexity-with-viven-ags-video-solutions/', vimeo: '772421307', thumb: '/assets/heroes/case-772421307.jpg', title: 'Meteomatics — Explainer series by Viven' },
    { path: '/de/case-study-meteomatics-komplexitaet-vereinfachen-mit-den-videos-von-viven-ag/', vimeo: '772421307', thumb: '/assets/heroes/case-772421307.jpg', title: 'Meteomatics — Explainer-Serie von Viven' },
    { path: '/es/caso-de-exito-meteomatics-simplificando-la-complejidad-con-las-soluciones-en-video-de-viven-ag/', vimeo: '772421307', thumb: '/assets/heroes/case-772421307.jpg', title: 'Meteomatics — Serie de explainers de Viven' },
    { path: '/en/case-study-how-viven-helped-siemens-switzerland-amplify-their-employer-branding/', vimeo: '828322230', thumb: '/assets/heroes/case-828322230.jpg', title: 'Siemens — Employer branding film by Viven' },
    { path: '/de/case-study-wie-viven-siemens-schweiz-dabei-half-sein-employer-branding-zu-staerken/', vimeo: '828322230', thumb: '/assets/heroes/case-828322230.jpg', title: 'Siemens — Employer-Branding-Film von Viven' },
    { path: '/es/caso-de-exito-como-viven-ayudo-a-siemens-a-ampliar-su-marca-de-empleador/', vimeo: '828322230', thumb: '/assets/heroes/case-828322230.jpg', title: 'Siemens — Film de employer branding de Viven' },
    { path: '/en/case-study-sv-group-bringing-it-operations-and-hospitality-together/', vimeo: '861150876', thumb: '/assets/heroes/case-861150876.jpg', title: 'SV Group — Innovation film by Viven' },
    { path: '/de/case-study-sv-group-it-betrieb-und-gastfreundschaft-perfekt-vereint/', vimeo: '861150876', thumb: '/assets/heroes/case-861150876.jpg', title: 'SV Group — Innovationsfilm von Viven' },
    { path: '/es/caso-de-exito-sv-group-it-operaciones-y-hospitalidad-perfectamente-integrados/', vimeo: '861150876', thumb: '/assets/heroes/case-861150876.jpg', title: 'SV Group — Film de innovación de Viven' },
  ];
  for (const c of CASES) {
    entries.push({ loc: SITE + c.path, player: `https://player.vimeo.com/video/${c.vimeo}`, thumb: SITE + c.thumb, title: c.title, desc: c.title });
  }

  // showreel de la home (3 idiomas)
  for (const lg of ['en', 'de', 'es']) {
    entries.push({ loc: `${SITE}/${lg}/`, player: 'https://player.vimeo.com/video/1057568537', thumb: `${SITE}/assets/heroes/home-hero-1600.jpg`, title: 'Viven — Showreel', desc: "Viven's showreel of films for leading brands including UBS, Siemens, Porsche and ON." });
  }

  // agrupar por página (una <url> puede tener varios <video:video>)
  const byLoc = new Map<string, Entry[]>();
  for (const e of entries) {
    if (!byLoc.has(e.loc)) byLoc.set(e.loc, []);
    byLoc.get(e.loc)!.push(e);
  }

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:video="http://www.google.com/schemas/sitemap-video/1.1">
${[...byLoc.entries()].map(([loc, vids]) => `  <url>
    <loc>${esc(loc)}</loc>
${vids.map((v) => `    <video:video>
      <video:thumbnail_loc>${esc(v.thumb)}</video:thumbnail_loc>
      <video:title>${esc(v.title)}</video:title>
      <video:description>${esc(v.desc)}</video:description>
      <video:player_loc>${esc(v.player)}</video:player_loc>
    </video:video>`).join('\n')}
  </url>`).join('\n')}
</urlset>`;

  return new Response(xml, { headers: { 'Content-Type': 'application/xml; charset=utf-8' } });
}
