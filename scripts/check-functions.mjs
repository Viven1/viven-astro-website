/* Compara las Edge Functions DESPLEGADAS contra las que hay en el repo.
 *
 * El 27 ago apareció `cola-a-repo` desplegada y sin estar en supabase/functions/: un
 * redeploy desde el repo la habría borrado sin que nadie se enterara, y es la function que
 * escribe la cola de aprobados. Al revés también importa: una function en el repo que nunca
 * se desplegó es código que nadie está corriendo, y el cron que la llame va a dar 404.
 *
 * Necesita ~/.supabase-token. Si no está, se saltea — no rompe el build de un clon nuevo.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';

const TOKEN = `${homedir()}/.supabase-token`;
if (!existsSync(TOKEN)) { console.log('· check-functions: sin token, se saltea'); process.exit(0); }

const REF = 'lumoevaotokgqnpybkyf';
let desplegadas;
try {
  const r = await fetch(`https://api.supabase.com/v1/projects/${REF}/functions`, {
    headers: { Authorization: `Bearer ${readFileSync(TOKEN, 'utf8').trim()}` },
  });
  const j = await r.json();
  if (!Array.isArray(j)) throw new Error(JSON.stringify(j).slice(0, 120));
  desplegadas = new Set(j.map((f) => f.slug));
} catch (e) {
  console.log(`· check-functions: no pude consultar (${String(e.message).slice(0, 60)}), se saltea`);
  process.exit(0);
}

const enRepo = new Set(
  readdirSync('supabase/functions', { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== '_shared' && existsSync(`supabase/functions/${d.name}/index.ts`))
    .map((d) => d.name),
);

const soloServidor = [...desplegadas].filter((f) => !enRepo.has(f)).sort();
const soloRepo = [...enRepo].filter((f) => !desplegadas.has(f)).sort();

if (soloServidor.length) {
  console.error(`✘ desplegadas y NO en el repo (se pierden en un redeploy): ${soloServidor.join(', ')}`);
  console.error(`   bajalas con: npx supabase functions download <nombre> --project-ref ${REF}`);
}
if (soloRepo.length) {
  console.error(`✘ en el repo y NO desplegadas (nadie las está corriendo): ${soloRepo.join(', ')}`);
}
if (!soloServidor.length && !soloRepo.length) {
  console.log(`✓ functions: las ${enRepo.size} del repo son las que están desplegadas`);
}
process.exit(soloServidor.length || soloRepo.length ? 1 : 0);
