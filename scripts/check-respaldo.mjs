/* EL RESPALDO SIN SEÑAL: QUE VUELVA TODO, Y APARTADO.
 *
 * Sebastián mira el tablero EN EL SET, donde no hay internet. El cartel de «sin conexión»
 * decía «se ve lo último que se cargó» y era mentira: no había respaldo, así que la app
 * abría con las listas vacías Y un cartel diciendo que estabas viendo datos viejos.
 *
 * Ahora cada carga buena deja una copia en localStorage y la siguiente sin red se
 * rehidrata de ahí. Dos cosas que este chequeo cuida, las dos rompibles en silencio:
 *
 *  1. Que se guarde aunque no haya lugar. localStorage tira QuotaExceededError, no
 *     devuelve false: sin el escalonado (completo → recortado → mínimo) una cuota llena
 *     dejaba sin respaldo Y sin aviso.
 *  2. Que las PRUEBAS sigan apartadas al volver. El respaldo las guarda por separado, pero
 *     loadCore vuelve a separarlas leyendo `allLeads`; si la rehidratación devolviera solo
 *     las reales, esa pasada dejaría leadsPrueba vacío y sin señal los proyectos de prueba
 *     volverían a contar como plata real. Es el bug del 28 ago reapareciendo por atrás.
 */
import { readFileSync } from 'node:fs';

const src = readFileSync('src/pages/dashboard/index.astro', 'utf8');
const trozo = (marca) => {
  const i = src.indexOf(marca);
  if (i < 0) throw new Error(`no encontré ${marca.trim()}`);
  return src.slice(i, src.indexOf('\n  }', i) + 4);
};
const codigo = ["const SNAP = 'vv_snap_v1';", trozo('  function snapGuardar('),
                trozo('  function snapLeer('), trozo('  function snapRehidratar(')].join('\n');

const lsFalso = (tope) => { const m = new Map(); return {
  getItem: (k) => (m.has(k) ? m.get(k) : null),
  removeItem: (k) => m.delete(k),
  setItem(k, v){ if (v.length > tope){ const e = new Error('QuotaExceededError'); e.name = 'QuotaExceededError'; throw e; } m.set(k, v); },
  peso: () => [...m.values()].reduce((a, v) => a + v.length, 0) }; };

let fallos = 0;
const mal = (t) => { console.error('✗ respaldo: ' + t); fallos++; };

// 1) vuelve todo, y las pruebas quedan apartadas tras la separación que hace loadCore
{
  const guion = `
    let allLeads=[{id:1,name:'A'},{id:2,name:'B'}], leadsPrueba=[{id:9,name:'P',es_prueba:true}];
    let dealsList=[{id:'d1',lead_id:1}], dealsPrueba=[{id:'d9',lead_id:9}], dealsReal=true;
    let offersList=[{id:'o1'}], propsAll=[{id:'p1'}], coMeta={'viven.ch':{}}, upBookings=[{id:'b1'}];
    ${codigo}
    snapGuardar();
    allLeads=[]; leadsPrueba=[]; dealsList=[]; dealsPrueba=[]; dealsReal=false;
    offersList=[]; propsAll=[]; coMeta={}; upBookings=[];
    const at = snapRehidratar();
    const _todos = allLeads || [];                    // lo mismo que hace loadCore sin red
    leadsPrueba = _todos.filter((l) => l.es_prueba);
    allLeads = _todos.filter((l) => !l.es_prueba);
    return { at, reales: allLeads.length, pruebas: leadsPrueba.length, deals: dealsList.length,
             dealsPrueba: dealsPrueba.length, offers: offersList.length, props: propsAll.length,
             co: Object.keys(coMeta).length, book: upBookings.length };`;
  const r = new Function('localStorage', guion)(lsFalso(5e6));
  if (!r.at) mal('no devolvió la fecha de la copia');
  if (r.reales !== 2 || r.pruebas !== 1) mal(`tras rehidratar quedaron ${r.reales} reales y ${r.pruebas} pruebas (esperaba 2 y 1)`);
  if (r.deals !== 1 || r.dealsPrueba !== 1) mal('los deals no volvieron apartados');
  if (r.offers !== 1 || r.props !== 1 || r.co !== 1 || r.book !== 1) mal('faltó rehidratar ofertas, propuestas, empresas o agenda');
}

// 2) el escalonado cuando no hay lugar
{
  const gordo = (n) => `Array.from({length:${n}},(_,i)=>({id:i,lead_id:i,x:'y'.repeat(400)}))`;
  const guion = (tope) => `
    let allLeads=${gordo(200)}, leadsPrueba=${gordo(2)};
    let dealsList=${gordo(200)}, dealsPrueba=${gordo(2)}, dealsReal=true;
    let offersList=${gordo(60)}, propsAll=${gordo(16)}, coMeta={}, upBookings=${gordo(8)};
    ${codigo}
    const ok = snapGuardar();
    const g = snapLeer();
    return { ok, claves: g ? Object.keys(g.d) : [] };`;
  const completo = new Function('localStorage', guion())(lsFalso(5e6));
  if (!completo.ok || !completo.claves.includes('offers')) mal('con lugar de sobra no guardó el respaldo completo');
  // un tope que deja pasar el recortado pero no el completo
  const recortado = new Function('localStorage', guion())(lsFalso(190_000));
  if (!recortado.ok) mal('sin lugar para el completo no cayó al recortado');
  else if (recortado.claves.includes('offers')) mal('el recortado igual metió las ofertas');
  else if (!recortado.claves.includes('deals')) mal('el recortado se comió los deals');
  // sin lugar para nada: se rinde limpio, no explota
  const nada = new Function('localStorage', guion())(lsFalso(50));
  if (nada.ok) mal('dijo que guardó cuando no entraba nada');
  if (nada.claves.length) mal('dejó una copia a medias, que es peor que ninguna');
}

if (fallos) { console.error(`\n  ${fallos} problema(s). Sin respaldo, el set es una pantalla vacía.\n`); process.exit(1); }
console.log('✓ respaldo: vuelve completo con su fecha, las pruebas apartadas, y se recorta si no hay lugar');
