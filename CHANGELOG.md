# Changelog

Registro en criollo de qué se agregó, cuándo, y a qué commit/tag volver si algo se rompe.
Cada entrada = un checkpoint (no cada commit — serían cientos). El tag de git es el punto real de restore; esto es el índice para entender qué hay en cada uno.

Cómo revertir a un checkpoint: `git log --oneline` para ver commits, o `git checkout <tag>` para mirarlo sin tocar `main`, o pedime "revertí a `<tag>`" y lo hago con cuidado (nunca fuerzo un push sin avisar).

---

## 2026-07-12 — checkpoint-2026-07-12-b (sesión larga, muchísimo agregado)

**Antes de hoy:** sitio Astro trilingüe (EN/DE/ES) + dashboard CRM propio sobre Supabase — leads/deals, ofertas, propuestas, booking, blog con motor de contenido IA, calculadora de costos, Google Ads, analytics.

**Se agregó/arregló hoy (orden aprox.):**
- Fix real de "las sesiones bajan": el KPI de Analytics era una foto fija (nunca se refrescaba solo) + un cap silencioso de PostgREST subestimaba las filas — paginación real con `.range()`.
- Bug del Workflow "no hace nada": los botones de Workflows/Google Ads/Newsletter estaban atados al init del tab A/B Tests por error — ahora se atan siempre al cargar.
- Panel "👥 Inscriptos" en cada Workflow (quién está en qué paso, frenar/reactivar/agregar gente a mano).
- Notificaciones (campana): filtro de datos de test que inflaba el conteo; hilo de emails por contacto (`email_log`) con sync de respuestas por Gmail (`gmail-sync`, pendiente de que actives el OAuth de las 3 casillas).
- Blog: las imágenes se repetían siempre las mismas 2 — pool ampliado a todo `/public/projects/*` + selección por antigüedad de uso.
- Brief: nombre/apellido ahora obligatorios, 3 preguntas nuevas (acción/sentimiento/destino), preguntas reordenadas fácil→difícil.
- Fix real del idioma que nunca cambiaba solo: `_redirects` interceptaba `/` antes de que corriera el JS que lee `navigator.language`.
- PWA: botón "🔄 Nueva versión" cuando hay una versión nueva corriendo (nunca recarga solo).
- Newsletter: generación con IA desde un título + modo "una persona" además de segmento completo.
- Auditoría total (bugs reales encontrados y arreglados): XSS guardado en el hilo de emails (nombre de lead sin escapar), textarea en pantalla completa que dejaba el dashboard trabado, varios más — ver commits de esa fecha para el detalle completo.
- **5 features estilo Keap/HubSpot**: Licencias/renovaciones (cron -90/-30/0 días), firma electrónica en propuestas (checkbox + IP), facturación (numeración automática, PDF, marcar pagada), referidos con atribución real (`?ref=<code>` propio por cliente), portal del cliente público (`/portal/`, estado de producción + feedback).
- Segunda auditoría sobre esos 5 features: token del portal era `Math.random()` (débil) → `crypto.randomUUID()`; rate-limit en el feedback público; bug de que las licencias solo avisaban una vez en toda su vida en vez de una vez por ciclo de renovación; race condition en el botón de factura.

**SQL corridas hoy:** 0044 a 0052 (email_log, gmail_sync_state, automation_runs insert/delete, brief first/last name, licenses, proposal signature, invoices, referrals, client portal).

**Estado:** build limpio, todo deployado y pusheado a `main`. Sin bugs conocidos pendientes.

---

## 2026-08-12 — barrido de los 404 heredados del sitio viejo

**Por qué:** revisando qué hacer con backlinks apareció que Google todavía
muestra URLs del sitio viejo (WordPress/HubSpot) y que varias daban 404 — o
sea que el link externo que apunta ahí no le suma nada al dominio.

**Cómo se midió (esto es lo importante para repetirlo):** no se fue de a una.
Se le pidió a Wayback la lista de TODAS las URLs archivadas de viven.ch (1041
rutas reales), se probó cada una contra producción y quedaron 381 en 404.

**Qué se hizo:** 196 eran páginas de contenido y ahora tienen su 301 a la
página del mismo tema y del mismo idioma — el portfolio viejo (`/project/*`),
el glosario (`/what-is-*`, `/de/was-ist-*`), las landings de servicio, las
páginas de ciudad y las de "production services". Las otras 185 eran archivos
por fecha/categoría/autor/tag del WordPress: wildcard al índice de blog o de
proyectos del idioma. Cada uno de los 90 destinos se verificó que devolviera
200 ANTES de escribir la regla — un 301 a un 404 es peor que el 404.

**Verificación:** se volvió a pasar el barrido entero (661 rutas) contra
producción después del deploy. Queda 1 sola en 404, `/xmlrpc.php`, que es
ruido de bots de WordPress y tiene que seguir rota. Cero regresiones: ninguna
URL que ya daba 200 cambió de destino.

**Estado:** desplegado con `npx wrangler deploy` y pusheado a `main`.
`_redirects` quedó en 900 estáticas + 39 wildcards (los límites son 2000/100).

---

## 2026-08-22 — el newsletter contesta cuando alguien se suscribe (EN/DE/ES)

**Qué pasaba:** el form del footer decía "✓ Listo — estás en la lista" y ahí
terminaba todo. El siguiente email que esa persona recibía era la edición
mensual — hasta 30 días después. En el medio no tenía forma de saber si la
suscripción funcionó, cada cuánto le íbamos a escribir ni desde qué dirección,
que es justo lo que decide si el mes que viene el mail cae en Inbox o en
Promociones.

**Qué se agregó:** una bienvenida que sale al instante, en el idioma en el que
la persona estaba navegando (EN/DE/ES, fallback EN), con el mismo wrapper, el
mismo remitente (Sofia) y el mismo link de baja de un click que el resto del
newsletter. Dice lo único que hace falta decir ahí: uno por mes, qué trae, y
tres links que ya sirven hoy (calculadora de costos, blog, call de 15 min) —
todos con `utm_source=newsletter&utm_campaign=welcome`, así una venta que
empezó acá se ve como email y no como "directo".

- `supabase/functions/newsletter-welcome/index.ts` — la function. El texto de
  los tres idiomas vive ahí; DE en Sie, sin ß, saludo "Guten Tag" (regla 0089/0111).
  Sale de **info@viven.ch** y firma el equipo, no una persona (pedido de
  Sebastián): es un acuse de recibo del sitio, y si lo firma alguien, la
  respuesta cae en una casilla personal y el que contesta queda esperando.
- **APAGADO POR DEFECTO** (`app_settings.newsletter.welcome_enabled`, SQL 0130).
  "No mandes hasta que confirmemos 100%": deployar la function no puede ser lo
  mismo que empezar a escribirle a gente real. Se prende con el check 👋 del tab
  Newsletter del dashboard. El preview anda igual estando apagado — es lo que se
  usa para confirmar el texto. Prenderlo NO es retroactivo.
- `public/assets/site.js` — la llama DESPUÉS del insert del lead, best-effort:
  si la function está caída, la suscripción igual quedó hecha y el visitante no
  ve ningún error.
- `supabase/migrations/0130_newsletter_welcome.sql` — `newsletter_welcomes`:
  el log y, sobre todo, **el candado**. Índice único por email: una bienvenida
  por dirección, para siempre. El form es público y no tiene captcha, así que
  sin eso repetir el submit sería una forma barata de mandarle N emails a un
  tercero. La fila se reserva antes de mandar (dos clicks simultáneos no mandan
  dos veces) y se libera si Resend falla, para que un 500 pasajero no deje a
  alguien sin bienvenida para siempre.
- `supabase/functions/resend-events/index.ts` — tag `welcome_id`: apertura y
  click de la bienvenida quedan estampados. Es el único número que dice si
  sirve para algo.
- Dashboard → Newsletter: botones 👋 EN/DE/ES que se lo mandan a tu casilla
  para verlo como lo ve el suscriptor (no toca el log ni gasta el candado).

**Falta hacer a mano (no lo puedo hacer yo):**
1. Correr `supabase/migrations/0130_newsletter_welcome.sql` en el SQL Editor.
2. `supabase functions deploy newsletter-welcome --no-verify-jwt` y
   `supabase functions deploy resend-events --no-verify-jwt`.
3. Leer los tres emails y, recién ahí, **prender el check 👋** en Newsletter.
   Hasta que lo prendas no sale ni uno. (Si se deploya sin correr la SQL, el
   interruptor no se puede leer y la function tampoco manda: apagado.)

**Estado:** build limpio (504 páginas). Los tres emails se renderizaron y se
revisaron uno por uno; los 7 links que llevan (3 por idioma + /book/) se
verificaron contra el build: ninguno da 404.

---

<!-- Próxima entrada: agregar arriba de esta línea, mismo formato -->
