/* ¿La página que sirve producción pide archivos que existen?
 *
 * El 27 ago 2026 el dashboard en producción pedía _astro/index.BDnsy71c.css y ese archivo
 * devolvía 404: la pantalla se servía SIN su hoja de estilos. No se notaba desde un
 * navegador con el service worker instalado —sirve la copia guardada— así que el bug vivió
 * hasta que Sebastián dijo tres veces «no cambió nada» y yo tres veces le contesté que era
 * caché suyo. El HTML servido y sus assets venían de builds distintos.
 *
 * Nada lo detectaba: el Action decía «Deployed», el build local estaba bien y el sitio
 * respondía 200 en todas las URLs que el workflow comprueba. Lo que faltaba era mirar
 * ADENTRO del HTML y verificar cada asset que pide.
 *
 * Se corre a mano después de publicar: `npm run produccion`.
 */
const PAGINAS = [
  'https://www.viven.ch/dashboard/',
  'https://www.viven.ch/portal/',
  'https://www.viven.ch/',
];

let problemas = 0;
for (const url of PAGINAS) {
  const cacheBuster = `${url.includes('?') ? '&' : '?'}chk=${Date.now()}`;
  let html;
  try {
    const r = await fetch(url + cacheBuster);
    if (!r.ok) { console.error(`✘ ${url} → HTTP ${r.status}`); problemas++; continue; }
    html = await r.text();
  } catch (e) {
    console.error(`✘ ${url} → ${String(e.message).slice(0, 60)}`);
    problemas++; continue;
  }

  const assets = [...new Set([...html.matchAll(/(?:href|src)="(\/_astro\/[^"]+)"/g)].map((m) => m[1]))];
  if (!assets.length) { console.log(`· ${url} — sin assets de _astro`); continue; }

  const malos = [];
  for (const a of assets) {
    try {
      const r = await fetch(new URL(a, url).href);
      /* Un 200 no alcanza: el Worker sirve la página 404 con status 200 en algunos casos,
         y ahí el "archivo" es un HTML. Un .css o .js que empieza con <!DOCTYPE no existe. */
      const txt = (await r.text()).slice(0, 60).trimStart();
      const esHtml = txt.toLowerCase().startsWith('<!doctype') || txt.toLowerCase().startsWith('<html');
      if (!r.ok || esHtml) malos.push(`${a} → ${r.ok ? 'devuelve HTML (no existe)' : 'HTTP ' + r.status}`);
    } catch (e) {
      malos.push(`${a} → ${String(e.message).slice(0, 40)}`);
    }
  }

  if (malos.length) {
    console.error(`✘ ${url} pide ${malos.length} archivo(s) que no están:`);
    malos.forEach((m) => console.error(`   ${m}`));
    console.error('   → el HTML y sus assets vienen de builds distintos: redesplegá.');
    problemas += malos.length;
  } else {
    console.log(`✓ ${url} — sus ${assets.length} asset(s) existen`);
  }
}
process.exit(problemas ? 1 : 0);

/* ── Además: textos que se le muestran al cliente sin traducir ──
 * El portal es trilingüe, pero es fácil escribir una frase suelta en español al agregar una
 * función. Un cliente suizo-alemán ve el portal en alemán y de golpe «Todavía no te lo
 * mandamos por email». El 27 ago había OCHO así, varias del mismo día.
 * El diccionario TX se excluye: ahí el español es correcto.
 */
import { readFileSync as _leer } from 'node:fs';
const _src = _leer('src/pages/portal/index.astro', 'utf8');
const _i = _src.indexOf('var TX = {');
const _fuera = _i < 0 ? _src : _src.slice(0, _i) + _src.slice(_src.indexOf('\n  };', _i));
const _marcas = /'[^']*\b(Todavía|Tocá|Pedinos|avisanos|copiala|Mandámelo|arrancó|Escribí|Contestá|Mirá)\b[^']*'/g;
const _sueltos = [...(_fuera.matchAll(_marcas))].map((m) => m[0].slice(0, 64));
if (_sueltos.length) {
  console.error(`\n✘ portal: ${_sueltos.length} texto(s) en español fuera del diccionario TX`);
  _sueltos.forEach((t) => console.error(`   ${t}`));
  console.error('   → el cliente alemán los ve así. Movelos a TX (en/de/es).');
  process.exitCode = 1;
} else {
  console.log('✓ portal: sin textos en español fuera del diccionario');
}
