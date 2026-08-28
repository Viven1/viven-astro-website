/* TRES PAQUETES NO SON TRES VENTAS.
 *
 * El 28 ago 2026 tres clientes tenían tres ofertas cada uno —Lite/Plus/Premium,
 * Essentials/Professional/Scaling— y el pipeline las SUMABA. Geistlich Pharma figuraba con
 * CHF 50.944 perdidos por un trabajo que como mucho valía 27.130, y el total de «perdido»
 * decía 135.450 donde lo honesto son ~68.000: exactamente el doble.
 *
 * Son alternativas: el cliente elige UNA. Ninguna tenía deal_id, así que el código las
 * colgaba todas del mismo negocio y las sumaba.
 *
 * La regla que cuida este chequeo: un negocio vale UNA oferta. Las ganadas sí se suman
 * —dos ganadas en el mismo trato son un upsell de verdad—; entre alternativas se cuenta la
 * mayor. Es fácil de romper sin querer volviendo a un `.reduce((a,o)=>a+offerNet(o),0)`,
 * que es lo que estaba escrito y se lee perfectamente natural.
 */
import { readFileSync } from 'node:fs';

const src = readFileSync('src/pages/dashboard/index.astro', 'utf8');
const trozo = (marca, fin) => {
  const i = src.indexOf(marca);
  if (i < 0) throw new Error(`no encontré ${marca.trim()}`);
  return src.slice(i, src.indexOf(fin, i) + fin.length);
};

const codigo = [
  "const esOpt = (it) => !!(it && it.opcional);",
  src.slice(src.indexOf('  const offerNet = (o) =>'), src.indexOf('\n', src.indexOf('  const offerNet = (o) =>'))),
  trozo('  /* CUÁNTO VALE UN TRATO CON VARIAS ALTERNATIVAS.', 'const dealValue = (d) => dealValueInfo(d).chf;'),
  trozo('  const dealLostValueInfo = (d)', 'const dealLostValue = (d) => dealLostValueInfo(d).chf;'),
].join('\n');

// los tres paquetes reales de Geistlich Pharma, con sus netos medidos contra la base
const paquete = (neto, status) => ({ status, discount_pct: 0, items: [{ qty: 1, price: neto }] });
const GEISTLICH = [paquete(27130, 'lost'), paquete(17520, 'lost'), paquete(6294, 'lost')];

/* 27130 + 17520 + 6294 = 50944 → promedio 16981,33 */
const casos = [
  { t: 'tres paquetes perdidos = el PROMEDIO, ni la suma ni el mayor',
    ofs: GEISTLICH, perdido: true, esperado: 16981, deN: 3, como: 'prom' },
  { t: 'tres paquetes mandados = el promedio',
    ofs: GEISTLICH.map((o) => ({ ...o, status: 'sent' })), perdido: false, esperado: 16981, deN: 3, como: 'prom' },
  { t: 'si uno está marcado recomendado, gana ese (no el promedio)',
    ofs: [paquete(27130, 'sent'), { ...paquete(17520, 'sent'), recommended: true }, paquete(6294, 'sent')],
    perdido: false, esperado: 17520, deN: 3, como: 'rec' },
  { t: 'una sola oferta = su valor, sin etiqueta rara',
    ofs: [paquete(9000, 'sent')], perdido: false, esperado: 9000, deN: 1, como: null },
  { t: 'dos GANADAS sí se suman (upsell de verdad)',
    ofs: [paquete(9000, 'won'), paquete(3000, 'won')], perdido: false, esperado: 12000, deN: 0, como: undefined },
  { t: 'sin ofertas: cae al valor cargado a mano',
    ofs: [], perdido: false, esperado: 5000, deN: 0, como: undefined },
];

let fallos = 0;
for (const c of casos) {
  const fn = new Function('offersForDeal', 'propsWonForDeal', 'propsSentForDeal',
    codigo + '; return { dealValueInfo, dealLostValueInfo };');
  const api = fn(() => c.ofs, () => 0, () => 0);
  const d = { id: 1, lead_id: 1, deal_value: 5000 };
  const r = c.perdido ? api.dealLostValueInfo(d) : api.dealValueInfo(d);
  const comoOk = c.como === undefined ? true : (r.como ?? null) === c.como;
  if (Math.round(r.chf) !== c.esperado || r.deN !== c.deN || !comoOk) {
    console.error(`✗ ${c.t}\n    dio CHF ${Math.round(r.chf)} (de ${r.deN}, ${r.como ?? 'sin criterio'}) · esperaba ${c.esperado} (de ${c.deN}, ${c.como ?? 'sin criterio'})`);
    fallos++;
  }
}

if (fallos) { console.error(`\n  ${fallos} caso(s) mal. Sumar alternativas dobla la plata en pantalla.\n`); process.exit(1); }
console.log(`✓ valor del deal: un trato vale UNA oferta: el recomendado, o el promedio (${casos.length} casos)`);
