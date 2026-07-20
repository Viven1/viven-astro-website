-- 0082: content_followup — sigue el pedido explícito de Sebastián de reemplazar
-- el nurture genérico (borrado en la 0081) por follow-ups CONECTADOS AL
-- CONTENIDO real que pidió cada lead (categoría sacada de leads.message, el
-- mismo texto "🧮 CALCULADORA — 📦 Product video · ..." que ya arma calc-email).
--
-- Mismo patrón de seguridad que nurture: nunca sale un email solo (todo pasa
-- por outbox), se frena solo si el lead ya fue contactado, nunca a bajas/spam.

create table if not exists public.content_followup_state (
  id bigint generated always as identity primary key,
  lead_id bigint not null references public.leads(id) on delete cascade,
  category text not null,   -- 'product' | 'brand' | 'corporate' | 'employer' | 'howto' | 'social'
  status text not null default 'active',   -- 'active' | 'paused'
  source text not null default 'auto',     -- 'auto' (detectado en el message) | 'manual'
  enrolled_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (lead_id, category)
);
alter table public.content_followup_state enable row level security;
do $$ begin
  create policy "content_followup_state_rw" on public.content_followup_state for all to authenticated using (true) with check (true);
exception when duplicate_object then null; end $$;

-- 1 fila por (lead, categoría, paso) enviado — nunca se repite un paso.
create table if not exists public.content_followup_log (
  id bigint generated always as identity primary key,
  lead_id bigint not null references public.leads(id) on delete cascade,
  category text not null,
  step int not null,
  sent_at timestamptz not null default now(),
  unique (lead_id, category, step)
);
alter table public.content_followup_log enable row level security;
do $$ begin
  create policy "content_followup_log_r" on public.content_followup_log for select to authenticated using (true);
exception when duplicate_object then null; end $$;

insert into public.app_settings (key, value) values ('content_followup', '{"enabled": true}') on conflict (key) do nothing;

-- outbox ya tenía 'kind'/'step' (de nurture) pero no 'category' — la usamos
-- para saber qué secuencia (product/brand/...) es cada borrador.
alter table public.outbox add column if not exists category text;

-- cron cada hora, mismo horario que tenía nurture, mismo patrón de auth
-- (Authorization: Bearer CRON_SECRET vía Vault) que los demás cron.job desde
-- la 0081_cron_secret_headers.
do $$ begin perform cron.unschedule('viven-content-followup'); exception when others then null; end $$;
select cron.schedule('viven-content-followup', '20 * * * *', $$
  select net.http_post(
    url := 'https://lumoevaotokgqnpybkyf.supabase.co/functions/v1/content-followup',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization',
      'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')),
    body := '{}'::jsonb
  );
$$);
