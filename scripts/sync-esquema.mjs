/* Baja el esquema real a /tmp/schema_map.json para que check-columnas pueda comparar.
   Se corre a mano cuando cambia la base (una migración nueva); el chequeo se saltea solo
   si el archivo no está, así que un clon recién bajado no falla el build por esto. */
import { writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

const token = readFileSync(`${homedir()}/.supabase-token`, 'utf8').trim();
const REF = 'lumoevaotokgqnpybkyf';
const r = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query:
    "select table_name, string_agg(column_name, ',' order by column_name) cols " +
    "from information_schema.columns where table_schema='public' group by table_name" }),
});
const filas = await r.json();
if (!Array.isArray(filas)) { console.error('no pude leer el esquema:', filas); process.exit(1); }
const mapa = Object.fromEntries(filas.map((f) => [f.table_name, f.cols.split(',')]));
writeFileSync('/tmp/schema_map.json', JSON.stringify(mapa));
console.log(`✓ esquema al día: ${filas.length} tablas`);
