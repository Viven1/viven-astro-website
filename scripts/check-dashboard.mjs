#!/usr/bin/env node
/* Tres cosas que el build NO detecta y que rompieron el dashboard hoy mismo:
 *
 *  1. Una función que se llama y ya no existe. Pasó al reemplazar un bloque por índices
 *     de texto: el corte iba de una función a otra y se llevó las quince del plan de
 *     rodaje que había en medio. Un identificador ausente es JavaScript válido hasta que
 *     se ejecuta, así que compila, se publica, y revienta en la cara del usuario.
 *  2. Dos elementos con el mismo id. getElementById devuelve el PRIMERO: "Abrir el brief"
 *     abría el Playbook vacío.
 *  3. Un id que se usa desde el JS y no existe en el HTML — salvo los que se crean con
 *     innerHTML, que son legítimos y por eso no se pueden exigir.
 *
 * Corre sobre el FUENTE y sobre el HTML construido. Sale con código 1 si hay algo.
 *   node scripts/check-dashboard.mjs
 */
import { readFileSync, existsSync } from 'node:fs';

const SRC = 'src/pages/dashboard/index.astro';
const OUT = 'dist/dashboard/index.html';
const src = readFileSync(SRC, 'utf8');
let fallos = 0;
const mal = (t, xs) => { fallos += xs.length; console.log(`\n✗ ${t} (${xs.length})`); xs.forEach((x) => console.log('   ·', x)); };

/* ── 1. llamadas sin definición ── */
const defs = new Set();
for (const m of src.matchAll(/(?:async\s+)?function\s+(\w+)\s*\(/g)) defs.add(m[1]);
/* Declaración múltiple en una línea: `let a = [], b = null, c = 0;`. Sin esto, todo lo
   que no fuera el primero contaba como indefinido. */
for (const m of src.matchAll(/^\s*(?:let|const|var)\s+([^;\n]+)/gm)) {
  for (const trozo of m[1].split(',')) {
    const n = trozo.trim().match(/^(\w+)/);
    if (n) defs.add(n[1]);
  }
}
/* Solo los prefijos del dashboard: lo demás son APIs del navegador y librerías. */
const llamadas = new Set([...src.matchAll(/\b((?:pj|crew|pbr|ned|pb|ana|seo|nw|au|cf|ab|lm|co|hm|of|pp|rc|bg|cq|vm|wq|limp|ob)[A-Z]\w+)\s*\(/g)].map((m) => m[1]));
const huerfanas = [...llamadas].filter((f) => !defs.has(f)).sort();
if (huerfanas.length) mal('Se llaman y no están definidas', huerfanas);

/* ── 2 y 3: sobre el HTML construido ── */
if (!existsSync(OUT)) {
  console.log('\n⚠ No hay dist/dashboard/index.html — corré `npx astro build` antes.');
} else {
  const out = readFileSync(OUT, 'utf8');
  const ids = [...out.matchAll(/\bid="([A-Za-z0-9_-]+)"/g)].map((m) => m[1]);
  const cuenta = {};
  ids.forEach((k) => { cuenta[k] = (cuenta[k] || 0) + 1; });
  const dup = Object.keys(cuenta).filter((k) => cuenta[k] > 1).sort();
  if (dup.length) mal('Ids repetidos — getElementById devuelve solo el primero', dup);

  /* Los ids que el JS toca con $('x') y no existen en el HTML. Se descartan los que el
     propio código crea: si el id aparece dentro de un id="..." en un string de JS, es
     un elemento dibujado en tiempo de ejecución y está bien que no esté en el HTML. */
  /* Solo los que se usan SIN guarda: `$('x').value`. Un `if ($('x'))` o un `$('x') || nada`
     son a propósito —quedan restos de pantallas que se sacaron y el código los busca por
     las dudas— y marcarlos sería ruido que hace ignorar el chequeo entero. */
  const enJS = new Set([...src.matchAll(/\$\('([a-z0-9-]+)'\)\s*\./g)].map((m) => m[1]));
  /* Un id creado en tiempo de ejecución vale igual, se escriba como quiera:
     id="x" dentro de un string, id='x', o el clásico `caja.id = 'x'`. */
  const creados = new Set([
    ...[...src.matchAll(/id="([a-z0-9-]+)"/g)].map((m) => m[1]),
    ...[...src.matchAll(/id=\\?'([a-z0-9-]+)\\?'/g)].map((m) => m[1]),
    ...[...src.matchAll(/\.id\s*=\s*'([a-z0-9-]+)'/g)].map((m) => m[1]),
    ...[...src.matchAll(/id="' \+ /g)].map(() => '__dinamico__'),
  ]);
  const set = new Set(ids);
  const fantasma = [...enJS].filter((k) => !set.has(k) && !creados.has(k)).sort();
  if (fantasma.length) mal('El JS los busca y no existen ni se crean', fantasma);
}

if (!fallos) console.log('✓ dashboard: sin llamadas huérfanas, sin ids repetidos, sin ids fantasma');
process.exit(fallos ? 1 : 0);
