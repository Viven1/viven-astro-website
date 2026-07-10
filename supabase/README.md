# Viven — Backend (Supabase) setup

Notificaciones de leads, follow-ups, sugerencias con IA y analytics server-side.
Proyecto: `lumoevaotokgqnpybkyf`.

## 0. Requisitos
- Dominio **verificado en Resend** (para mandar desde `leads@viven.ch`). Alta gratis: 3.000 emails/mes.
- Supabase CLI: `npm i -g supabase` → `supabase login` → `supabase link --project-ref lumoevaotokgqnpybkyf`

## 1. SQL (una vez)
Pegá `migrations/0001_followup_and_analytics.sql` en el **SQL Editor** de Supabase y ejecutá.
Crea: columnas de follow-up en `leads`, el trigger que programa follow-ups al pasar a *contacted*,
y las RPCs de analytics (`kpi_summary`, `daily_stats`, `channel_stats`, `page_stats`).

## 2. Secrets
```bash
supabase secrets set RESEND_API_KEY=re_xxxxxxxx
supabase secrets set ANTHROPIC_API_KEY=sk-ant-xxxxxxxx   # para las sugerencias de IA
supabase secrets set CRON_SECRET=$(openssl rand -hex 16)  # protege el cron; guardá el valor
```
`SUPABASE_URL`, `SUPABASE_ANON_KEY` y `SUPABASE_SERVICE_ROLE_KEY` ya existen por defecto.

## 3. Deploy de las funciones
```bash
supabase functions deploy lead-notify   --no-verify-jwt   # la llama un webhook, no un usuario
supabase functions deploy lead-followup  --no-verify-jwt  # la llama el cron
supabase functions deploy ai-suggest                      # verify-jwt ON: solo el dashboard logueado
```

## 4. Webhook de lead nuevo → email instantáneo
Supabase → **Database → Webhooks → New**:
- Tabla `leads`, evento **INSERT**
- Tipo: **Supabase Edge Function** → `lead-notify`
Listo: cada lead nuevo dispara un email a **info@viven.ch**.

## 5. Cron de follow-ups (diario)
En el SQL Editor, descomentá y completá la sección 3 de `0001_...sql`
(reemplazá `<PROJECT_REF>` = `lumoevaotokgqnpybkyf` y `<CRON_SECRET>` por el de arriba).
Requiere las extensiones `pg_cron` y `pg_net` (Database → Extensions).

## 6. Dashboard
Ya trae:
- **Realtime**: los leads nuevos aparecen solos (sin refresh) + toast.
- **✨ IA**: botón en cada lead → genera un follow-up personalizado con Claude.
- **Follow-up**: fecha del próximo seguimiento en el detalle del lead.
El swap de analytics a las RPCs lo hacemos juntos una vez que confirmes que el SQL corrió
(así lo verificamos contra datos reales sin romper lo que funciona).

## Cadencia de follow-up
Definida en `followup_offsets()` (SQL) y `OFFSETS` (lead-followup): **+2, +4, +7, +14 días, luego mensual**.
Cambiás el array en los dos lugares y listo. Se frena solo cuando el lead pasa a *won* o *lost*.

## Costos
- Resend: gratis hasta 3.000 emails/mes.
- Realtime + pg_cron: incluidos en el plan free.
- IA (Claude Haiku): ~USD 0,003–0,01 por sugerencia. Por uso, no fijo.
