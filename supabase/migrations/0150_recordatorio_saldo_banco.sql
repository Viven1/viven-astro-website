-- "Avisame para cambiarlo cada dos semanas" — Sebastián, 25 ago 2026.
--
-- El saldo del banco es el punto de partida de TODA la proyección de Cash Flow: el
-- runway, el próximo mes en rojo y la alerta de umbral salen de ahí. El 25 ago el
-- último cargado era del 24 de julio, o sea que los tres números eran de hace un mes y
-- nadie lo sabía. El aviso vive en cashflow-alert (que ya corre a diario) y esta columna
-- es la que evita que, una vez vencido, moleste todos los días.
alter table public.cashflow_alert_settings
  add column if not exists saldo_recordado_at date;
comment on column public.cashflow_alert_settings.saldo_recordado_at is
  'Última vez que se avisó que el saldo del banco está viejo. El aviso se repite cada 14 días, no a diario.';
