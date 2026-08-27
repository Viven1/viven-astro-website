/* Filas que apuntan a algo que ya no existe.
 *
 * No rompen nada a la vista: producen números raros y filas sin nombre, que después cuesta
 * explicar. Este chequeo los cuenta para poder decir «no es esto» rápido cuando aparece un
 * total que no cierra.
 *
 * Corrida del 27 ago 2026: 8 deals y 10 ofertas apuntando a leads borrados —todos con
 * valor 0 o `tier`, así que NO distorsionaban plata— y un crew de proyecto sin ficha
 * («Sofia» contra la ficha «Sofia Treviño»), que sí hacía que el plan de rodaje saliera
 * «sin teléfono» para alguien que lo tenía cargado.
 */
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';

const TOKEN = `${homedir()}/.supabase-token`;
if (!existsSync(TOKEN)) { console.log('· check-integridad: sin token, se saltea'); process.exit(0); }
const REF = 'lumoevaotokgqnpybkyf';

const SQL = `
select 'deals con lead inexistente' q, count(*) n, coalesce(sum(coalesce(deal_value,0)),0) plata
  from deals d where d.lead_id is not null and not exists (select 1 from leads l where l.id::text=d.lead_id::text)
union all
select 'ofertas con lead inexistente', count(*), 0
  from offers o where o.lead_id is not null and o.status <> 'tier'
   and not exists (select 1 from leads l where l.id::text=o.lead_id::text)
union all
select 'facturas sin lead válido', count(*), coalesce(sum(coalesce(gross,0)),0)
  from invoices i where i.lead_id is not null and not exists (select 1 from leads l where l.id::text=i.lead_id::text)
union all
select 'versiones sin proyecto', count(*), 0
  from project_versions v where not exists (select 1 from projects p where p.id=v.project_id)
union all
select 'crew de proyecto sin ficha', count(*), 0 from (
  select distinct e->>'nombre' nm from projects p,
    jsonb_array_elements(case when jsonb_typeof(p.crew::jsonb)='array' then p.crew::jsonb else '[]'::jsonb end) e
   where coalesce(e->>'nombre','') <> '') x
 where not exists (
   select 1 from crew c where lower(c.name)=lower(x.nm)
      or lower(c.name) like lower(x.nm) || ' %' or lower(x.nm) like lower(c.name) || ' %')
`;

let filas;
try {
  const r = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${readFileSync(TOKEN, 'utf8').trim()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: SQL }),
  });
  filas = await r.json();
  if (!Array.isArray(filas)) throw new Error(JSON.stringify(filas).slice(0, 120));
} catch (e) {
  console.log(`· check-integridad: no pude consultar (${String(e.message).slice(0, 60)}), se saltea`);
  process.exit(0);
}

let hay = 0;
for (const f of filas) {
  const n = Number(f.n), plata = Number(f.plata);
  if (!n) continue;
  hay++;
  console.error(`⚠️  ${f.q}: ${n}${plata ? ` · CHF ${plata.toLocaleString('de-CH')} en juego` : ' · sin plata asociada'}`);
}
console.log(hay ? '\n· son huérfanos: no rompen nada, pero salen sin nombre en las listas'
                : '✓ integridad: nada apunta a filas que ya no existen');
