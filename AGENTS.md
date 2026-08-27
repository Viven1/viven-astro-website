## Development

When starting the dev server, use background mode:

```
astro dev --background
```

Manage the background server with `astro dev stop`, `astro dev status`, and `astro dev logs`.

## Documentation

Full documentation: https://docs.astro.build

Consult these guides before working on related tasks:

- [Adding pages, dynamic routes, or middleware](https://docs.astro.build/en/guides/routing/)
- [Working with Astro components](https://docs.astro.build/en/basics/astro-components/)
- [Using React, Vue, Svelte, or other framework components](https://docs.astro.build/en/guides/framework-components/)
- [Adding or managing content](https://docs.astro.build/en/guides/content-collections/)
- [Adding styles or using Tailwind](https://docs.astro.build/en/guides/styling/)
- [Supporting multiple languages](https://docs.astro.build/en/guides/internationalization/)

## Lo primero de cada sesión: vaciar la cola de aprobados

Sebastián aprueba cosas desde el teléfono (ideas de CRO, acciones sobre un
cliente). Cada aprobación cae en `public.work_queue` y se muestra en Hoy →
"🤖 Aprobado, falta hacerlo", con los días que lleva esperando.

**Antes de ponerte a hacer otra cosa, mirá qué hay pendiente:**

```sql
select id, source, title, detail, url, approved_at,
       (now()::date - approved_at::date) as dias_esperando
from public.work_queue
where status in ('pending','doing')
order by approved_at;
```

(SQL Editor del proyecto `lumoevaotokgqnpybkyf`, o desde el dashboard logueado
con `supabase.from('work_queue')`.)

Reglas:
- Si hay algo, decíselo a Sebastián al empezar, con los días de espera. Una cosa
  aprobada hace ocho días es un problema, no un ítem más.
- Al terminar algo, marcalo hecho (botón ✓ en Hoy, o `status='done'` +
  `done_note` en una línea). Eso dispara una push "✅ Hecho: …" — así se entera
  sin venir a preguntar.
- Si algo no se puede hacer, no lo dejes ahí: cancelalo y explicá por qué.

Aprobar sin que esto se vacíe es peor que no tener el botón: promete y no cumple.

## Migraciones: `supabase db push`, ya no el SQL Editor

Durante mucho tiempo las migraciones se corrían pegándolas a mano en el SQL Editor, así
que la tabla de historial de Supabase se quedó en la 0054 mientras el esquema real iba
por la 0159. Con ese desfase, `supabase db push` intentaba reaplicar cien migraciones
viejas y moría en la primera policy repetida — por eso nadie lo usaba, y por eso el
desfase crecía.

El 26 ago 2026 se reparó el historial entero (`supabase migration repair --status
applied <version>`, una por una: el comando NO acepta varias juntas). Hoy está al día.

**A partir de ahora:**

```bash
npx supabase db push
```

Si se queja con `LegacyDbPushMissingRemoteError`, es porque hay una migración local con
número anterior a la última aplicada; ahí va `--include-all`.

Y escribí las migraciones idempotentes igual (`create table if not exists`,
`create or replace function`, `add column if not exists`): es la red que permitió
reparar el historial sin miedo a romper nada.

⚠️ La carpeta está sincronizada y a veces duplica archivos como `0157_algo 2.sql`.
Son copias byte a byte del original y hay que borrarlas antes de pushear —
si no, la misma migración entra dos veces en el historial.

---

## Los chequeos automáticos

`npm run build` corre solo, al final, tres verificaciones. **Ninguna necesita red**, así que
un clon recién bajado compila igual:

| chequeo | qué atrapa |
|---|---|
| `check-dashboard` | funciones llamadas que no existen, ids repetidos, ids que el JS lee y no están en el HTML |
| `gen-brief-preguntas --check` | que las 12 preguntas del brief que usan las Edge Functions sigan siendo las del portal |
| `check-columnas` | `select('...rol')` cuando la columna se llama `role` — falla en runtime y deja la pantalla vacía sin decir por qué |

`check-columnas` compara contra `/tmp/schema_map.json`. Cuando cambia la base:

```bash
npm run esquema
```

Y hay dos que **sí** necesitan red y token, así que van aparte y a mano:

```bash
npm run revisar
```

- `check-functions` — functions desplegadas que no están en el repo (un redeploy las borra)
  y functions del repo que nunca se desplegaron (el cron que las llame da 404).
- `check-crons` — crons que apuntan a una function inexistente, y crons que llaman sin el
  `cron_secret`. Este último es el peor de todos: la function contesta 403 y `pg_cron` lo
  registra como **succeeded**, porque lo que salió bien es el `net.http_post` y no la
  respuesta. El 27 ago 2026 había cinco así —uno era el sync de Gmail, que llevaba días
  muerto— y dos apuntando a functions borradas hace meses.

**Conviene correr `npm run revisar` después de tocar crons o functions**, y cuando algo
automático "no anda" sin dar error.

### Y uno más, después de publicar

```bash
npm run produccion
```

`check-produccion` abre las páginas **en producción** y verifica que cada archivo que piden
exista de verdad. El 27 ago 2026 el dashboard servía un HTML que pedía un `.css` con 404:
la pantalla salía **sin su hoja de estilos**, y no se notaba desde un navegador con el
service worker instalado —sirve la copia guardada— así que el bug sobrevivió a tres rondas
de "no cambió nada". El HTML servido y sus assets venían de builds distintos.

Nada lo detectaba: el Action decía `Deployed`, el build local estaba bien y el sitio
respondía 200 en las URLs que el workflow comprueba. Faltaba mirar **adentro** del HTML.

Ojo con el `200`: el Worker puede devolver la página 404 con status 200, así que el chequeo
además mira si un `.css` o `.js` empieza con `<!doctype` — si empieza así, no existe.

### Cómo verificar un deploy, en orden

1. `sed -n '10p' dist/dashboard-sw.js` — qué versión se construyó.
2. El log del Action: `Uploaded N files` y `Deployed`.
3. `npm run produccion` — que los assets del HTML vivo existan.
4. Recién ahí, comparar el bundle vivo con el local:
   `curl -s https://www.viven.ch/_astro/<bundle>.js | cmp - dist/_astro/<bundle>.js`

**Lo que NO sirve:** buscar nombres de función en el HTML servido. El JS va a un bundle
externo y está **minificado** —los nombres se renombran—, y el CSS va a otro archivo. Hay
que buscar textos visibles ("Cargar contactos"), no identificadores. Y `curl` desde fuera de
Europa pega en un borde de Cloudflare con su propia copia: `cf-cache-status: HIT` con
`no-cache` ignorado. Ver [[maestro-deploy-propagacion-cdn]] en las memorias.
