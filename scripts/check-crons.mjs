/* Los crons que llaman a una function: ¿existe la function, y le mandan el secreto?
 *
 * El 27 ago había CINCO crons llamando sin el cron_secret —la function contestaba 403 y
 * pg_cron lo registraba como "succeeded", porque lo que succeeded es el net.http_post y no
 * la respuesta— y DOS apuntando a functions borradas hace meses. Motores apagados que
 * informaban que estaban vivos, uno de ellos el sync de Gmail.
 *
 * pg_cron no puede detectar esto solo: hay que preguntárselo.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';

const TOKEN = `${homedir()}/.supabase-token`;
if (!existsSync(TOKEN)) { console.log('· check-crons: sin token, se saltea'); process.exit(0); }
const REF = 'lumoevaotokgqnpybkyf';

const sql = async (query) => {
  const r = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${readFileSync(TOKEN, 'utf8').trim()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  return r.json();
};

let jobs;
try {
  jobs = await sql(
    "select jobname, active, substring(command from 'functions/v1/([a-z0-9-]+)') fn, " +
    "(command ilike '%cron_secret%') con_secreto from cron.job " +
    "where command ilike '%functions/v1/%'");
  if (!Array.isArray(jobs)) throw new Error(JSON.stringify(jobs).slice(0, 120));
} catch (e) {
  console.log(`· check-crons: no pude consultar (${String(e.message).slice(0, 60)}), se saltea`);
  process.exit(0);
}

const enRepo = new Set(readdirSync('supabase/functions', { withFileTypes: true })
  .filter((d) => d.isDirectory()).map((d) => d.name));

const fantasma = jobs.filter((j) => j.fn && !enRepo.has(j.fn));
const sinSecreto = jobs.filter((j) => !j.con_secreto);

if (fantasma.length) {
  console.error('✘ crons que llaman a una function que NO EXISTE (404 en cada corrida):');
  fantasma.forEach((j) => console.error(`   ${j.jobname} → ${j.fn}`));
}
if (sinSecreto.length) {
  console.error('✘ crons SIN el cron_secret (la function contesta 403 y pg_cron dice "succeeded"):');
  sinSecreto.forEach((j) => console.error(`   ${j.jobname} → ${j.fn}`));
}
if (!fantasma.length && !sinSecreto.length) {
  console.log(`✓ crons: los ${jobs.length} que llaman functions existen y mandan el secreto`);
}
process.exit(fantasma.length || sinSecreto.length ? 1 : 0);
