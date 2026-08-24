-- 0050: Facturas — cierra el círculo propuesta/oferta ganada → factura, sin
-- salir del dashboard. Snapshot de items/cliente al momento de facturar (si la
-- oferta cambia después, la factura ya emitida no se mueve).

create table if not exists public.invoices (
  id bigint generated always as identity primary key,
  offer_id bigint,
  lead_id bigint,
  number text not null unique,
  client_company text, client_contact text, client_address text, client_zip_city text, client_phone text, client_email text,
  title text,
  items jsonb not null default '[]'::jsonb,
  vat_rate numeric not null default 8.1,
  net numeric not null default 0,
  gross numeric not null default 0,
  status text not null default 'draft',  -- draft | sent | paid
  issued_at timestamptz not null default now(),
  due_date date,
  paid_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists invoices_offer_idx on public.invoices (offer_id);
create index if not exists invoices_lead_idx on public.invoices (lead_id);
alter table public.invoices enable row level security;
do $$ begin
  create policy "invoices_auth_all" on public.invoices for all to authenticated using (true) with check (true);
exception when duplicate_object then null; end $$;
