/* Guardia previa al build.
 *
 * El proyecto vive en una carpeta sincronizada (los archivos tienen
 * com.apple.fileprovider.dir#N). Eso mete dos clases de basura que NO rompen la
 * compilación —por eso son peligrosas— pero sí rompen el sitio publicado:
 *
 *   1. Copias " 2" (`index 2.astro`, `BookingApp 2.astro`). Astro las publica
 *      como páginas reales. Ya pasó: /dashboard/index 2/ se desplegó.
 *   2. Nombres en forma Unicode NFD (la `ü` como u + diéresis suelta). El
 *      sitemap los publica en NFC y Cloudflare sirve por coincidencia exacta de
 *      bytes: Google recibe 404 y la página nunca se indexa. Ya pasó con cinco
 *      posts DE, y las carpetas viejas REAPARECIERON solas después de borrarlas.
 *
 * Por eso esto corre en `prebuild`: sin la guardia, el build sale "exitoso" y el
 * problema se descubre semanas después en Search Console.
 *
 * No borra nada: falla y dice exactamente qué mover. Borrar es decisión de quien
 * mira, porque una copia " 2" podría tener trabajo real adentro.
 */
import { readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';

const RAIZ = 'src';
const IGNORAR = new Set(['node_modules', '.git', 'dist', '.astro']);

const copias = [];
const nfd = [];

function recorrer(dir) {
  for (const nombre of readdirSync(dir)) {
    if (IGNORAR.has(nombre)) continue;
    const ruta = join(dir, nombre);

    // " 2.astro", " 3.ts", o carpeta " 2"
    if (/ \d+(\.[^.]+)?$/.test(nombre)) copias.push(ruta);

    // NFD: el nombre cambia al normalizarlo a NFC → está descompuesto
    if (nombre !== nombre.normalize('NFC')) nfd.push(ruta);

    if (statSync(ruta).isDirectory()) recorrer(ruta);
  }
}

recorrer(RAIZ);

if (copias.length === 0 && nfd.length === 0) {
  console.log('✓ sin duplicados ni nombres NFD en src/');
  process.exit(0);
}

console.error('\n✖ BUILD DETENIDO — basura de la carpeta sincronizada en src/\n');

if (copias.length) {
  console.error('  Copias duplicadas (Astro las publicaría como páginas reales):');
  for (const c of copias) console.error('    ' + c);
  console.error('\n  Comprobá que sean idénticas al original y movelas fuera:');
  console.error('    diff "<original>" "<copia>"   # si no imprime nada, es copia exacta\n');
}

if (nfd.length) {
  console.error('  Nombres en forma Unicode NFD (Google recibiría 404 en estas rutas):');
  for (const n of nfd) console.error('    ' + basename(n));
  console.error('\n  Renombralos a ASCII (ü→ue, ä→ae, ö→oe) y agregá la ruta vieja');
  console.error('  al mapa RETIRED de worker.js para no dejar un 404.\n');
}

process.exit(1);
