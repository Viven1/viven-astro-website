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
