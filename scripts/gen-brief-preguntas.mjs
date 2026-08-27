/* Escribe supabase/functions/_shared/brief-preguntas.ts a partir de las 12 preguntas del
 * portal. Las Edge Functions no pueden importar del sitio Astro, y el email de "el cliente
 * terminó el brief" salía con las CLAVES técnicas (tema, audiencia…) en vez de las
 * preguntas: doce respuestas sin su pregunta no dicen nada.
 * (Sebastián, 26 ago 2026: "faltan las preguntas no sirve de mucho asi".)
 *
 * Corre en el postbuild con --check: si alguien toca las preguntas y no regenera, el build
 * falla en vez de dejar que los dos archivos se separen en silencio.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { BRIEF, BRIEF_SECCIONES } from '../src/data/project-brief-i18n.js';

const DEST = 'supabase/functions/_shared/brief-preguntas.ts';
const salida =
`// GENERADO por scripts/gen-brief-preguntas.mjs — no editar a mano.
// La fuente es src/data/project-brief-i18n.js; el build falla si esto quedó viejo.

export const BRIEF_SECCIONES = ${JSON.stringify(BRIEF_SECCIONES)} as const;

export const BRIEF_Q: Array<{ k: string; sec: string; q: Record<string, string> }> = ${
  JSON.stringify(BRIEF.map((b) => ({ k: b.k, sec: b.sec, q: b.q })), null, 2)
};

/** La pregunta en el idioma pedido, o la clave si no la encuentra. */
export function preguntaDe(k: string, lang = "es"): string {
  const q = BRIEF_Q.find((b) => b.k === k);
  return (q && (q.q[lang] || q.q.en)) || k;
}

/** Las respuestas en el orden del cuestionario, no en el que las devuelve la base. */
export function enOrden<T extends { key: string }>(filas: T[]): T[] {
  const pos = new Map(BRIEF_Q.map((b, i) => [b.k, i]));
  return filas.slice().sort((a, b) => (pos.get(a.key) ?? 99) - (pos.get(b.key) ?? 99));
}
`;

if (process.argv.includes('--check')) {
  let actual = '';
  try { actual = readFileSync(DEST, 'utf8'); } catch { /* no existe */ }
  if (actual !== salida) {
    console.error('✘ brief-preguntas.ts quedó viejo respecto de project-brief-i18n.js');
    console.error('  Corré: node scripts/gen-brief-preguntas.mjs');
    process.exit(1);
  }
  console.log('✓ brief-preguntas.ts al día con el cuestionario del portal');
} else {
  writeFileSync(DEST, salida);
  console.log('✓ escrito ' + DEST + ' (' + BRIEF.length + ' preguntas)');
}
