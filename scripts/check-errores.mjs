/* LOS ERRORES QUE YA PASARON, MIRADOS.
 *
 * El dashboard escribe en `dash_perf_log` cada carga y cada error que atrapa. Nadie lo
 * miraba. El 28 ago 2026 esa tabla tenía, arriba de todo, un `dePrueba is not defined`
 * mío de hacía dos horas: la sección de señales de Hoy venía rota desde la v197 y ningún
 * chequeo del build lo podía ver, porque es un error de ámbito que solo existe al correr.
 *
 * Un error acá vale más que veinte reglas estáticas: pasó de verdad, en la pantalla de
 * alguien. Se corre con `npm run revisar`, y devuelve 1 si hay errores nuevos.
 */
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';

const TOKEN = `${homedir()}/.supabase-token`;
if (!existsSync(TOKEN)) { console.log('· check-errores: sin token, se saltea'); process.exit(0); }
const DIAS = Number(process.argv[2] || 3);

let filas;
try {
  const r = await fetch('https://api.supabase.com/v1/projects/lumoevaotokgqnpybkyf/database/query', {
    method: 'POST',
    headers: { Authorization: `Bearer ${readFileSync(TOKEN, 'utf8').trim()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: `
      select phases->>'msg' msg, phases->>'donde' donde, phases->>'tab' tab,
             count(*) veces, max(at)::timestamp(0)::text ultima, min(at)::timestamp(0)::text primera
      from dash_perf_log
      where phases->>'kind' = 'error' and at > now() - interval '${DIAS} days'
      group by 1,2,3 order by max(at) desc limit 20` }),
  });
  filas = await r.json();
  if (!Array.isArray(filas)) throw new Error(JSON.stringify(filas).slice(0, 120));
} catch (e) {
  console.log(`· check-errores: no pude consultar (${String(e.message).slice(0, 60)}), se saltea`);
  process.exit(0);
}

if (!filas.length) { console.log(`✓ errores: ninguno en la app en los últimos ${DIAS} días`); process.exit(0); }

console.error(`\n✗ la app tiró ${filas.reduce((a, f) => a + Number(f.veces), 0)} error(es) en los últimos ${DIAS} días:\n`);
for (const f of filas) {
  const donde = [f.donde, f.tab].filter(Boolean).join(' · ') || 'sin ubicar';
  console.error(`   ${f.msg}`);
  console.error(`      ${f.veces}× · ${donde} · última ${f.ultima}\n`);
}
console.error('   Un error acá ya le pasó a alguien en su pantalla. Ningún chequeo del build');
console.error('   los ve: son de ámbito, de datos o de red, y solo existen al correr.\n');
process.exit(1);
