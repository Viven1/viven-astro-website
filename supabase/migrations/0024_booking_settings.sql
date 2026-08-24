-- 0024: settings del booking (/book/) editables desde el dashboard — como HubSpot Meetings.
-- Una sola fila (id=1). Las edge functions booking-slots/booking-create la leen con service role.
create table if not exists public.booking_settings (
  id           int primary key default 1 check (id = 1),
  updated_at   timestamptz not null default now(),
  active       boolean not null default true,          -- OFF → /book/ muestra el link de respaldo
  work_start   int not null default 540,               -- minutos desde 00:00 Zúrich (540 = 09:00)
  work_end     int not null default 1050,              -- 1050 = 17:30
  days         int[] not null default '{1,2,3,4,5}',   -- ISO: 1=Lu … 7=Do
  notice_hours int not null default 4,                 -- aviso mínimo
  horizon_days int not null default 28,                -- hasta cuántos días adelante
  buffer_min   int not null default 0,                 -- colchón antes/después de cada call
  durations    int[] not null default '{15,30}',       -- opciones de duración
  host_name    text not null default 'Sebastian Cepeda',
  host_role    text not null default 'Founder — Viven AG, Zürich',
  msg_en       text,                                    -- mensaje extra post-booking (opcional)
  msg_de       text,
  msg_es       text
);
insert into public.booking_settings (id) values (1) on conflict (id) do nothing;
alter table public.booking_settings enable row level security;
drop policy if exists bkset_auth_all on public.booking_settings;
create policy bkset_auth_all on public.booking_settings for all to authenticated using (true) with check (true);
