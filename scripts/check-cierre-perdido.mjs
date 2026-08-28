/* SI EL PAPEL ESTÁ PERDIDO, EL DEAL SE CIERRA SOLO.
 *
 * Sebastián, 28 ago 2026: "si está en perdida es deal cerrado, eso tiene que salir
 * automáticamente, sino no sirve. Pensé que estaba así".
 *
 * Existía la cascada en un sentido —cerrar el deal marcaba sus ofertas— pero no al revés:
 * perder la propuesta dejaba el deal en «propuesta» para siempre. Cinco clientes tenían el
 * papel perdido y solo dos el deal cerrado. No es prolijidad: el win rate se calcula con la
 * ETAPA DEL DEAL, así que cada pérdida sin cerrar lo infla — daba 33% donde lo real es 14%.
 *
 * Las dos mitades que este chequeo cuida, porque las dos se rompen sin hacer ruido:
 *  1. Que cierre cuando NO QUEDA NADA VIVO — y solo entonces. Perder un paquete no es
 *     perder el cliente: mientras haya una oferta en pie, el trato sigue abierto.
 *  2. Que las `tier` no cuenten. Una propuesta de tres paquetes crea tres ofertas `tier`
 *     —la misma plata— y si entran al conteo, un deal con paquetes vivos parecería cerrado.
 */
import { readFileSync } from 'node:fs';

const src = readFileSync('src/pages/dashboard/index.astro', 'utf8');
const i = src.indexOf('  async function cerrarDealSiNoQuedaNada(');
if (i < 0) { console.error('✗ no encontré cerrarDealSiNoQuedaNada en el dashboard'); process.exit(1); }
const cuerpo = src.slice(i, src.indexOf('\n  }', i) + 4);

const correr = async ({ deal, ofertas, propuestas }) => {
  const cerrados = [];
  const fn = new Function('dealsList', 'propsAll', 'offersForDeal', 'stageOf', 'setDealStage', 'toast',
    cuerpo + '; return cerrarDealSiNoQuedaNada;');
  await fn([deal], propuestas, () => ofertas, (x) => x,
    async (id, stage) => { cerrados.push({ id, stage }); return true; }, () => {})(deal.lead_id, 'motivo');
  return cerrados;
};

const D = { id: 'd1', lead_id: 'L1', stage: 'propuesta' };
const casos = [
  { t: 'todo perdido → cierra',
    deal: D, ofertas: [{ status: 'lost' }], propuestas: [{ lead_id: 'L1', status: 'lost' }], cierra: true },
  { t: 'queda una oferta enviada → NO cierra',
    deal: D, ofertas: [{ status: 'lost' }, { status: 'sent' }], propuestas: [], cierra: false },
  { t: 'queda una propuesta enviada → NO cierra',
    deal: D, ofertas: [{ status: 'lost' }], propuestas: [{ lead_id: 'L1', status: 'sent' }], cierra: false },
  { t: 'sin papeles → NO cierra (no hay nada que perder)',
    deal: D, ofertas: [], propuestas: [], cierra: false },
  { t: 'los paquetes (tier) no cuentan: con uno vivo igual cierra',
    deal: D, ofertas: [{ status: 'lost' }, { status: 'tier' }], propuestas: [], cierra: true },
  { t: 'el deal ya ganado no se toca',
    deal: { ...D, stage: 'ganado' }, ofertas: [{ status: 'lost' }], propuestas: [], cierra: false },
  { t: 'el deal ya perdido no se vuelve a cerrar',
    deal: { ...D, stage: 'perdido' }, ofertas: [{ status: 'lost' }], propuestas: [], cierra: false },
  { t: 'las archivadas no cuentan como vivas',
    deal: D, ofertas: [{ status: 'lost' }, { status: 'sent', archived: true }], propuestas: [], cierra: true },
];

let fallos = 0;
for (const c of casos) {
  const r = await correr(c);
  const cerro = r.length > 0 && r[0].stage === 'perdido';
  if (cerro !== c.cierra) {
    console.error(`✗ ${c.t}\n    ${cerro ? 'cerró y no debía' : 'NO cerró y debía'}`);
    fallos++;
  }
}

if (fallos) { console.error(`\n  ${fallos} caso(s) mal. Un deal perdido sin cerrar infla el win rate en silencio.\n`); process.exit(1); }
console.log(`✓ cierre automático: el deal se cierra solo cuando no queda nada vivo (${casos.length} casos)`);
