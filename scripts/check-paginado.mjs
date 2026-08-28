/* QUE EL PAGINADO TRAIGA TODO.
 *
 * fetchAllRows y fetchAllRowsFull son por dónde entra CADA fila del dashboard. Si pierden
 * una página, no falla nada: los totales salen más chicos y la pantalla se ve igual de
 * prolija. Ya pasó una vez con el tope de 1000 filas de leads, que se comió filas sin
 * decirlo.
 *
 * Se extraen las dos funciones del .astro y se corren contra un Supabase de mentira con N
 * filas conocidas. Se comprueban dos cosas: que traigan las N —sin repetir ni perder— y
 * que lo hagan con el mínimo de viajes de ida y vuelta, que es lo que se siente en el set
 * con mala señal. Los bordes 999/1000/1001 están a propósito: son donde se rompe.
 */
import { readFileSync } from 'node:fs';

const src = readFileSync('src/pages/dashboard/index.astro', 'utf8');
const sacar = (nombre) => {
  const i = src.indexOf(`  async function ${nombre}(`);
  if (i < 0) throw new Error(`no encontré ${nombre} en el dashboard`);
  return src.slice(i, src.indexOf('\n  }', i) + 4);
};

const fingir = (total) => {
  let viajes = 0;
  const filas = Array.from({ length: total }, (_, k) => ({ id: k }));
  return { supabase: { from: () => { const q = {
        select(c, o){ q._count = !!(o && o.count === 'exact'); q._head = !!(o && o.head); return q; },
        gte(){ return q; }, lte(){ return q; }, order(){ return q; },
        range(a, b){ viajes++; return Promise.resolve({ data: filas.slice(a, b + 1), error: null, count: q._count ? total : null }); },
        // un `await` sobre el builder sin .range() = la consulta de conteo con head:true
        then(res){ viajes++; return Promise.resolve({ data: null, error: null, count: total }).then(res); },
      }; return q; } }, viajes: () => viajes };
};

const TAMANOS = [0, 1, 13, 63, 205, 999, 1000, 1001, 2500, 15102];
let fallos = 0;

for (const [nombre, args] of [
  ['fetchAllRowsFull', ['t', '*', 'created_at']],
  ['fetchAllRows', ['t', '*', '2026-08-01', '2026-08-28', 'created_at']],
]) {
  const fn = new Function('supabase', sacar(nombre) + `; return ${nombre};`);
  for (const total of TAMANOS) {
    const { supabase, viajes } = fingir(total);
    const r = await fn(supabase)(...args);
    const filas = r.data || [];
    const unicas = new Set(filas.map((x) => x.id)).size;
    const esperados = Math.max(1, Math.ceil(total / 1000));
    if (filas.length !== total || unicas !== total) {
      console.error(`✗ ${nombre}(${total}): trajo ${filas.length} (${unicas} únicas) — faltan ${total - filas.length}`);
      fallos++;
    } else if (viajes() !== esperados) {
      console.error(`✗ ${nombre}(${total}): ${viajes()} viajes, alcanzaban ${esperados}`);
      fallos++;
    }
  }
}

if (fallos) { console.error(`\n  ${fallos} caso(s) mal. Una página perdida no da error: da totales más chicos.\n`); process.exit(1); }
console.log(`✓ paginado: las 2 funciones traen todo en ${TAMANOS.length} tamaños, con el mínimo de viajes`);
