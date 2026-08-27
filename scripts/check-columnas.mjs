/* Verifica que las columnas que el código pide EXISTAN en la base.
 *
 * Es la clase de bug que más caro sale: `select('id,name,email,rol')` cuando la columna se
 * llama `role` no rompe el build ni da error de sintaxis — devuelve un error de PostgREST en
 * runtime, y la pantalla queda vacía sin decir por qué. Pasó dos veces el mismo día
 * (project_contacts.rol, project_files.storage_path).
 *
 * Lee el esquema de /tmp/schema_map.json (lo baja check-columnas:sync) y recorre el
 * dashboard y las Edge Functions buscando .from('tabla').select('a,b,c').
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';

const MAPA = '/tmp/schema_map.json';
if (!existsSync(MAPA)) { console.log('· sin esquema local, se saltea (correr check-columnas:sync)'); process.exit(0); }
const schema = JSON.parse(readFileSync(MAPA, 'utf8'));

const archivos = [
  'src/pages/dashboard/index.astro',
  'src/pages/portal/index.astro',
  ...readdirSync('supabase/functions', { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== '_shared')
    .map((d) => `supabase/functions/${d.name}/index.ts`)
    .filter(existsSync),
];

/* .from("tabla") … .select("col,col") — el select puede venir en la misma línea o encadenado
   en la siguiente, así que se mira una ventana corta después del from. */
const RE_FROM = /\.from\(\s*["'`]([a-z0-9_]+)["'`]\s*\)/g;
const RE_SELECT = /\.select\(\s*["'`]([^"'`]*)["'`]/;

let problemas = 0, revisados = 0;
for (const f of archivos) {
  const src = readFileSync(f, 'utf8');
  for (const m of src.matchAll(RE_FROM)) {
    const tabla = m[1];
    const cols = schema[tabla];
    if (!cols) continue;                      // vista, tabla de otro esquema o typo de tabla
    /* La ventana se corta en el próximo .from( y en el próximo ; — si no, un
       `.from("offers").update(...)` se comía el .select() de la consulta de abajo y el
       chequeo denunciaba columnas inexistentes en la tabla equivocada. Un chequeo que
       grita en falso se ignora, y entonces no sirve para nada. */
    let ventana = src.slice(m.index + m[0].length, m.index + 400);
    const corte = Math.min(
      ...[ventana.indexOf('.from('), ventana.indexOf(';')].filter((i) => i >= 0).concat([ventana.length]),
    );
    ventana = ventana.slice(0, corte);
    const sel = ventana.match(RE_SELECT);
    if (!sel || !sel[1] || sel[1].includes('*')) continue;
    /* Y si entre el from y el select hay una escritura, ese select es de otra consulta. */
    if (/\.(update|insert|upsert|delete)\s*\(/.test(ventana.slice(0, ventana.indexOf('.select(')))) continue;
    revisados++;
    const pedidas = sel[1]
      .replace(/\([^)]*\)/g, '')              // relaciones embebidas: tabla(col,col)
      .split(',').map((c) => c.trim().split(':').pop().trim())
      .filter((c) => c && /^[a-z0-9_]+$/.test(c));
    const faltan = pedidas.filter((c) => !cols.includes(c));
    if (faltan.length) {
      const linea = src.slice(0, m.index).split('\n').length;
      console.error(`✘ ${f}:${linea}  ${tabla} no tiene: ${faltan.join(', ')}`);
      const parecidas = faltan.map((c) => {
        const cerca = cols.filter((x) => x.includes(c) || c.includes(x) || x.replace(/e$/, '') === c.replace(/e$/, ''));
        return cerca.length ? `${c} → ¿${cerca.join(' o ')}?` : null;
      }).filter(Boolean);
      if (parecidas.length) console.error(`   ${parecidas.join(' · ')}`);
      problemas++;
    }
  }
}
console.log(problemas
  ? `\n✘ ${problemas} select(s) piden columnas que no existen`
  : `✓ columnas: ${revisados} selects verificados contra el esquema real`);
process.exit(problemas ? 1 : 0);
