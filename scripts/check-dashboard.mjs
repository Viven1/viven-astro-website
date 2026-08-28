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
const PREFIJOS = /\b((?:pj|crew|pbr|ned|pb|ana|seo|nw|au|cf|ab|lm|co|hm|of|pp|rc|bg|cq|vm|wq|limp|ob)[A-Z]\w+)/g;
const llamadas = new Set();
/* Con paréntesis: pjPlanPDF(). */
for (const m of src.matchAll(new RegExp(PREFIJOS.source + '\\s*\\(', 'g'))) llamadas.add(m[1]);
/* Y SIN paréntesis, que es como se pasa a un listener:
   addEventListener('click', pjPlanMandar). Faltaba esta forma, y por eso el chequeo dejó
   pasar una función que no existía — el mismo tipo de error que el script existe para
   atrapar. (26 ago 2026.) */
for (const m of src.matchAll(new RegExp("addEventListener\\([^,]+,\\s*" + PREFIJOS.source, 'g'))) llamadas.add(m[1]);
for (const m of src.matchAll(new RegExp("setTimeout\\(\\s*" + PREFIJOS.source, 'g'))) llamadas.add(m[1]);
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


/* NINGÚN CAMPO DE PLATA EN type="number".
   Sebastián cargó 9.531 —nueve mil quinientos treinta y uno, a la europea— y el input lo
   leyó como nueve francos con medio. Sin error y sin verse: la proyección de liquidez quedó
   calculando la empresa con CHF 750 de costos fijos al mes. `type=number` lee el punto como
   decimal SIEMPRE, y encima no deja escribir el apóstrofo suizo.
   Van en type="text" inputmode="decimal" y se leen con numCHF(). */
{
  const DINERO = /chf|precio|price|cost|monto|amount|tarifa|budget|presupuesto|valor|honorar|sueldo|saldo|principal|cuota/i;
  const EXENTO = /%|pct|porcentaje|vat|iva|dias|days|qty|cantidad|width|height|step="0\.1"/i;
  const malos = [];
  src.split('\n').forEach((l, i) => {
    for (const inp of l.match(/<input[^>]*type=["']number["'][^>]*>/g) || []) {
      const ctx = l.slice(Math.max(0, l.indexOf(inp) - 90), l.indexOf(inp)) + inp;
      if (!DINERO.test(ctx) || EXENTO.test(inp)) continue;
      const id = (inp.match(/id=["']([^"']+)/) || [])[1] || (inp.match(/data-f=["']([^"']+)/) || [])[1]
        || (inp.match(/class=["']([^"']+)/) || [])[1] || '?';
      malos.push(`linea ${i + 1}: ${id}`);
    }
  });
  if (malos.length) mal('Campos de plata en type="number" — van type="text" inputmode="decimal" + numCHF()', malos);
}


/* CONSTANTES USADAS Y NUNCA DECLARADAS.
   El 28 ago 2026 escribí PLM_IDIOMA[g.idioma] y puse la declaración en un lugar donde el
   regex no pegó: el build pasó verde y el preview del plan de rodaje habría tirado
   ReferenceError al abrirlo. El chequeo miraba funciones huérfanas, no constantes.
   Solo mira las MAYÚSCULAS_CON_GUION porque son las del código propio: minúsculas trae
   media API del navegador y el ruido haría ignorar el chequeo entero. */
{
  /* Vale como declarada cualquiera que se ASIGNE en algún lado, no solo la que sigue a un
     `const`: se declaran en listas con coma —`const NAVY = [...], ACID = [...], MUT = ...`—
     y mirar solo la primera daba por sueltas a ACID, MUT, INK y LINE, que existen.
     Es un criterio flojo a propósito: lo que este chequeo tiene que encontrar es el nombre
     que no aparece asignado en NINGUNA parte. */
  const declaradas = new Set([
    ...[...src.matchAll(/([A-Z][A-Z0-9_]{2,})\s*=[^=]/g)].map((m) => m[1]),
    ...[...src.matchAll(/\bfunction\s+([A-Z][A-Z0-9_]{2,})\b/g)].map((m) => m[1]),
    ...[...src.matchAll(/([A-Z][A-Z0-9_]{2,})\s*:/g)].map((m) => m[1]),
  ]);
  const DEL_NAVEGADOR = new Set(['JSON', 'URL', 'URLSearchParams', 'FormData', 'Math', 'Date',
    'Promise', 'Set', 'Map', 'Array', 'Object', 'String', 'Number', 'Boolean', 'Intl', 'RegExp',
    'Error', 'Blob', 'File', 'FileReader', 'Image', 'Audio', 'Event', 'CustomEvent', 'Node',
    'DOMParser', 'AbortController', 'Notification', 'WebSocket', 'XMLHttpRequest', 'TextEncoder',
    'TextDecoder', 'Uint8Array', 'ArrayBuffer', 'BigInt', 'Symbol', 'WeakMap', 'WeakSet', 'Proxy',
    'Reflect', 'Infinity', 'NaN', 'IntersectionObserver', 'ResizeObserver', 'MutationObserver']);
  /* Sin comentarios NI textos. La primera versión los leía y daba 122 falsos: los títulos
     en mayúscula de los comentarios («EL PDF (…)», «NUNCA HARDCODED») entraban como
     constantes sin declarar. Un chequeo que grita en falso se ignora, y entonces no sirve
     para nada. Se blanquean en vez de borrarse, para no mover los números de línea. */
  const limpio = src
    .replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p) => p + ' '.repeat(m.length - p.length))
    .replace(/'(?:[^'\\\n]|\\.)*'/g, (m) => "'" + ' '.repeat(Math.max(0, m.length - 2)) + "'")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, (m) => '"' + ' '.repeat(Math.max(0, m.length - 2)) + '"')
    .replace(/`(?:[^`\\]|\\.)*`/g, (m) => '`' + m.slice(1, -1).replace(/[^\n]/g, ' ') + '`');
  const usadas = new Map();
  for (const m of limpio.matchAll(/(?<![\w.$'"`])([A-Z][A-Z0-9_]{2,})\s*[[.(]/g)) {
    if (DEL_NAVEGADOR.has(m[1]) || declaradas.has(m[1])) continue;
    usadas.set(m[1], (usadas.get(m[1]) || 0) + 1);
  }
  const sueltas = [...usadas].map(([n, c]) => `${n} (${c} uso${c === 1 ? '' : 's'})`);
  if (sueltas.length) mal('Constantes usadas y nunca declaradas — ReferenceError al usarlas', sueltas);
}

if (!fallos) console.log('✓ dashboard: sin llamadas huérfanas, sin ids repetidos, sin ids fantasma, sin plata en type=number, sin constantes sueltas');
process.exit(fallos ? 1 : 0);
