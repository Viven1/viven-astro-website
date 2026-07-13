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

<!-- Próxima entrada: agregar arriba de esta línea, mismo formato -->
