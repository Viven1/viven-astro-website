/* NADIE DE AFUERA RECIBE ESPAÑOL POR DEFAULT.

   Regla de Sebastián (27 ago 2026): «siempre en el idioma de la persona, sino alemán o
   inglés». Solo él y Sofía trabajan en castellano y los dos lo tienen cargado en su ficha;
   cualquier español que salga de un DEFAULT es un email en un idioma que el que lo recibe
   probablemente no habla.

   El bug apareció tres veces seguidas en el mismo día —portal, plan de rodaje, notas al
   montajista— porque el código está escrito en español y el default se copia sin pensarlo.
   Por eso lo mira una máquina y no la memoria.

   Los avisos INTERNOS (to: info@viven.ch y demás casillas nuestras) sí van en español: los
   leen ellos dos. Se reconocen por el destinatario, no por una lista escrita a mano. */
import { readdirSync, readFileSync, existsSync } from 'node:fs';

const BASE = 'supabase/functions';
const fallas = [];

/** Los comentarios no mandan emails. Se borran de verdad (bloque incluido) y no con un
    regex por línea: el primer intento se disparó con el comentario que EXPLICA el bug. */
const sinComentarios = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));

const NUESTRA = (d) => /@viven\.ch/.test(d) || /alert_email|ALERT_EMAIL/.test(d);

for (const dir of readdirSync(BASE)) {
  const f = `${BASE}/${dir}/index.ts`;
  if (!existsSync(f)) continue;
  const crudo = readFileSync(f, 'utf8');
  /* Solo miramos funciones que MANDEN emails. Las de IA (ai-offer, ai-insights…) tienen
     default español a propósito: las llama el dashboard y las leen ellos dos. */
  if (!crudo.includes('api.resend.com/emails')) continue;

  const src = sinComentarios(crudo);
  const lineas = src.split('\n');

  /* Para cada línea, el `to:` que la precede: una misma función manda al cliente Y avisos
     internos a info@ (get-portal hace las dos cosas), así que la pregunta no es «esta
     función es interna» sino «este email puntual a quién va». */
  const destinoDe = [];
  let ultimo = null;
  for (const linea of lineas) {
    const m = linea.match(/to:\s*\[([^\]]{0,120})\]/);
    if (m) ultimo = m[1];
    destinoDe.push(ultimo);
  }

  lineas.forEach((linea, i) => {
    const n = i + 1;
    const interno = destinoDe[i] !== null && NUESTRA(destinoDe[i]);

    // 1) idioma fijo en español en una plantilla que le sale a alguien de afuera.
    //    `lang: "es" | "en"` es una ANOTACIÓN DE TIPO, no un valor: no cuenta.
    if (!interno && /\blang:\s*["']es["'](?!\s*[|,]\s*["'](en|de))/.test(linea))
      fallas.push(`${dir}/index.ts:${n} — plantilla con lang:"es" fijo, y este email le sale a alguien de afuera`);

    // 2) un default en español para una variable de idioma
    if (/\b(lang|idioma)\w*\s*(:[^=]*)?=\s*["']es["']/i.test(linea) && !/idiomaDe|idiomaSegun|idiomaPorEmail/.test(linea))
      fallas.push(`${dir}/index.ts:${n} — default "es"; usá idiomaDe() de _shared/idioma.ts`);

    // 3) el ternario clásico que cae en español
    if (/includes\([^)]*\)\s*\?[^:]+:\s*["']es["']/.test(linea))
      fallas.push(`${dir}/index.ts:${n} — el fallback del ternario es "es"`);
  });
}

if (fallas.length) {
  console.error(`\n✗ idioma: ${fallas.length} lugar(es) mandan español por default\n`);
  for (const x of fallas) console.error('  ' + x);
  console.error('\n  La regla y su porqué: supabase/functions/_shared/idioma.ts\n');
  process.exit(1);
}
console.log('✓ idioma: ningún email a gente de afuera cae en español por default');
