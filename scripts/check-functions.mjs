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
const verifyJwt = new Map();
try {
  const r = await fetch(`https://api.supabase.com/v1/projects/${REF}/functions`, {
    headers: { Authorization: `Bearer ${readFileSync(TOKEN, 'utf8').trim()}` },
  });
  const j = await r.json();
  if (!Array.isArray(j)) throw new Error(JSON.stringify(j).slice(0, 120));
  desplegadas = new Set(j.map((f) => f.slug));
  for (const f of j) verifyJwt.set(f.slug, f.verify_jwt);
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

/* Y que config.toml diga de CADA una si pide JWT.
   Nueve estaban sin declarar (27 ago 2026): con el valor sin escribir, quien pide o no la
   sesión lo decide la bandera que uno se acuerde de tipear en el deploy. Ponerle verify_jwt
   a una que el dashboard llama desde el navegador le mata el preflight de CORS, y la pantalla
   no dice «no autorizado» — se queda muda. Ver la nota de supabase-verify-jwt-y-cors. */
const cfg = readFileSync('supabase/config.toml', 'utf8');
const declarado = new Map(
  [...cfg.matchAll(/^\[functions\.([\w-]+)\]\s*\n\s*verify_jwt\s*=\s*(true|false)/gm)]
    .map((m) => [m[1], m[2] === 'true']),
);
const sinDeclarar = [...desplegadas].filter((f) => !declarado.has(f)).sort();
const distinto = [...desplegadas]
  .filter((f) => declarado.has(f) && declarado.get(f) !== !!verifyJwt.get(f))
  .map((f) => `${f} (config.toml dice ${declarado.get(f)}, el servidor tiene ${verifyJwt.get(f)})`);

if (sinDeclarar.length) console.error(`✘ sin verify_jwt en config.toml (el próximo deploy decide solo): ${sinDeclarar.join(', ')}`);
if (distinto.length) console.error(`✘ verify_jwt distinto al desplegado:\n   ${distinto.join('\n   ')}`);
if (!sinDeclarar.length && !distinto.length) console.log(`✓ verify_jwt: las ${desplegadas.size} declaradas coinciden con lo desplegado`);

process.exit(soloServidor.length || soloRepo.length || sinDeclarar.length || distinto.length ? 1 : 0);
