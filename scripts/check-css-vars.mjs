/* UNA VARIABLE CSS SIN DEFINIR NO AVISA — SE VE.
   El 27 ago 2026, cinco variables (--panel, --panel-2, --won, --lost, --warn) tenían 20
   reglas apuntándoles y no estaban declaradas en ninguna hoja. Una propiedad con un var()
   sin definir es INVÁLIDA: el navegador la descarta y sigue. Los paneles quedaban
   transparentes y el «💰 ganados» salía del color que heredara en vez de verde. No lo dice
   la consola, no lo rompe el build; solo aparece mirando la pantalla.

   El chequeo mira LAS DOS hojas juntas, que es donde me equivoqué al buscarlo a mano: la
   paleta oscura vive en public/assets/site.css y la clara dentro del .astro. Buscar en una
   sola da un resultado prolijo y falso —248 usos de una variable «inexistente» que sí
   existe—. Y por eso también acepta las que se setean en línea (style="--stage:…"). */
import { readFileSync, existsSync } from 'node:fs';

const HOJAS = ['public/assets/site.css', 'src/pages/dashboard/index.astro', 'src/pages/portal/index.astro'];
const texto = HOJAS.filter(existsSync).map((f) => readFileSync(f, 'utf8')).join('\n');

/* La definición tiene que estar en la paleta BASE. Una variable declarada solo dentro de
   `:root[data-theme="light"]` no existe en oscuro —que es el default y lo que ve casi
   todo el mundo—, así que las reglas que la usan se descartan ahí y solo ahí.
   La primera versión de este chequeo unía todas las definiciones y daba verde justamente
   con ese caso: se lo probé sacando --won del oscuro y no dijo nada. */
const base = new Set();
const enTema = new Set();
for (const m of texto.matchAll(/(:root[^{]*)\{([^{}]*)\}/g)) {
  const dondeVan = /\[data-theme/.test(m[1]) ? enTema : base;
  for (const d of m[2].matchAll(/(--[\w-]+)\s*:/g)) dondeVan.add(d[1]);
}
/* Las que se setean en línea sobre el elemento —style="--stage:#c9ef73"— viven ahí y
   están bien: no son huérfanas. */
for (const m of texto.matchAll(/style=[^>]*?(--[\w-]+)\s*:/g)) base.add(m[1]);
for (const m of texto.matchAll(/'\s*\+?\s*['"]?(--[\w-]+):/g)) base.add(m[1]);

const usadas = new Map();
for (const m of texto.matchAll(/var\((--[\w-]+)(\s*,)?/g)) {
  if (m[2]) continue;                       // var(--x, fallback) se defiende sola
  usadas.set(m[1], (usadas.get(m[1]) || 0) + 1);
}
const huerfanas = [...usadas].filter(([v]) => !base.has(v)).sort((a, b) => b[1] - a[1]);

if (huerfanas.length) {
  console.error(`\n✗ variables CSS sin definir en la paleta base (${huerfanas.length}):\n`);
  for (const [v, n] of huerfanas)
    console.error(`   ${v.padEnd(16)} ${String(n).padStart(3)} uso(s)${enTema.has(v) ? '  — está solo en el tema claro: en oscuro no existe' : ''}`);
  console.error('\n  Una propiedad con var() sin definir es inválida y se descarta entera, sin avisar.');
  console.error('  Van en el :root de public/assets/site.css, y su versión clara en el bloque [data-theme="light"].\n');
  process.exit(1);
}
console.log(`✓ css: las ${usadas.size} variables usadas existen en la paleta base`);
