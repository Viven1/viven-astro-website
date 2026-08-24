-- 0037: inversión de Google Ads (para CPL/CPA/ROAS del tab 🎯).
-- Se edita desde el dashboard; sincronizada entre dispositivos.

create table if not exists public.ads_settings (
  id int primary key,
  spend numeric not null default 0,
  updated_at timestamptz not null default now()
);
alter table public.ads_settings enable row level security;
do $$ begin
  create policy "ads_settings_rw" on public.ads_settings for all to authenticated using (true) with check (true);
exception when duplicate_object then null; end $$;
insert into public.ads_settings (id, spend) values (1, 0) on conflict (id) do nothing;
