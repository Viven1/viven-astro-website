-- 0078: módulo Cash Flow (proyección de liquidez de Viven AG, estilo Tresio.ch).
--
-- Alcance: SOLO Viven AG, SOLO CHF (sin columna de moneda). Bexio (contabilidad)
-- todavía no tiene token — el campo source/bexio_id queda listo para conectarlo
-- después, pero HOY toda la carga es manual. Saldo bancario: carga manual en v1
-- (sin conexión bancaria automática). Acceso: superadmin únicamente (RLS via
-- public.is_superadmin(), SQL 0077).

create table if not exists public.cashflow_recurring_templates (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('income','expense')),
  description text not null,
  amount_chf numeric not null check (amount_chf > 0),
  frequency text not null default 'monthly' check (frequency in ('monthly','quarterly','yearly')),
  day_of_month int not null default 1 check (day_of_month between 1 and 28),
  start_date date not null default current_date,
  end_date date,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.cashflow_loans (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  principal_chf numeric not null,
  monthly_payment_chf numeric not null check (monthly_payment_chf > 0),
  start_date date not null,
  end_date date not null,
  notes text,
  created_at timestamptz not null default now()
);

create table if not exists public.cashflow_entries (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('income','expense')),
  source text not null default 'manual' check (source in ('manual','bexio')),
  bexio_id text,
  description text not null,
  amount_chf numeric not null check (amount_chf > 0),
  due_date date not null,
  recurring_template_id uuid references public.cashflow_recurring_templates(id) on delete set null,
  loan_id uuid references public.cashflow_loans(id) on delete set null,
  status text not null default 'projected' check (status in ('projected','confirmed','paid')),
  created_by text,
  created_at timestamptz not null default now()
);
create index if not exists cashflow_entries_due_date_idx on public.cashflow_entries(due_date);

create table if not exists public.cashflow_bank_balance (
  id uuid primary key default gen_random_uuid(),
  balance_chf numeric not null,
  as_of_date date not null default current_date,
  note text,
  created_by text,
  created_at timestamptz not null default now()
);
create index if not exists cashflow_bank_balance_as_of_idx on public.cashflow_bank_balance(as_of_date desc);

create table if not exists public.cashflow_alert_settings (
  id int primary key default 1 check (id = 1),
  min_balance_threshold_chf numeric not null default 15000,
  alert_email text not null default 'sebastian@viven.ch',
  enabled boolean not null default true,
  last_alerted_period text
);
insert into public.cashflow_alert_settings (id) values (1) on conflict (id) do nothing;

alter table public.cashflow_recurring_templates enable row level security;
alter table public.cashflow_loans enable row level security;
alter table public.cashflow_entries enable row level security;
alter table public.cashflow_bank_balance enable row level security;
alter table public.cashflow_alert_settings enable row level security;

drop policy if exists "cashflow_recurring_templates superadmin only" on public.cashflow_recurring_templates;
create policy "cashflow_recurring_templates superadmin only" on public.cashflow_recurring_templates
  for all to authenticated using (public.is_superadmin()) with check (public.is_superadmin());
drop policy if exists "cashflow_loans superadmin only" on public.cashflow_loans;
create policy "cashflow_loans superadmin only" on public.cashflow_loans
  for all to authenticated using (public.is_superadmin()) with check (public.is_superadmin());
drop policy if exists "cashflow_entries superadmin only" on public.cashflow_entries;
create policy "cashflow_entries superadmin only" on public.cashflow_entries
  for all to authenticated using (public.is_superadmin()) with check (public.is_superadmin());
drop policy if exists "cashflow_bank_balance superadmin only" on public.cashflow_bank_balance;
create policy "cashflow_bank_balance superadmin only" on public.cashflow_bank_balance
  for all to authenticated using (public.is_superadmin()) with check (public.is_superadmin());
drop policy if exists "cashflow_alert_settings superadmin only" on public.cashflow_alert_settings;
create policy "cashflow_alert_settings superadmin only" on public.cashflow_alert_settings
  for all to authenticated using (public.is_superadmin()) with check (public.is_superadmin());
