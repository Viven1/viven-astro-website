-- Tokens de push nativo (APNs) de la app iOS del dashboard. Separado de
-- push_subscriptions (Web Push/VAPID, usado por la PWA) porque APNs necesita
-- un device token binario-en-hex, no un endpoint/keys de Web Push — push-send
-- manda por ambos caminos según qué tenga cada usuario.
-- Solo se escribe desde la función register-device-token (service role) tras
-- validar el JWT del usuario logueado — sin políticas de cliente directo.
create table if not exists device_tokens (
  id bigint generated always as identity primary key,
  user_email text not null,
  platform text not null default 'ios',
  device_token text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists device_tokens_user_email_idx on device_tokens (lower(user_email));
alter table device_tokens enable row level security;
