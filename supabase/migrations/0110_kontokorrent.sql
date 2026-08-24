-- Kontokorrent (línea de crédito): el piso real de liquidez es −límite.
-- El runway y el gráfico cuentan hasta agotar el crédito, no hasta cero.
alter table public.cashflow_alert_settings
  add column if not exists credit_limit_chf numeric not null default 0;
