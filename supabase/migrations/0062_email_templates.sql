-- 0062: base de plantillas editables para los emails automatizados (pedido
-- de Sebastián: "un lugar donde se ven los emails automatizados y puedo ir a
-- elegir como sean como base. y después vos los mandas. como una database de
-- emails"). Una fila = un touchpoint (key) en un idioma (lang). Si no hay fila,
-- la función que envía ese email sigue usando su default hardcodeado — esta
-- tabla es un OVERRIDE opcional, nunca un requisito (additive/backward-compat).
--
-- keys conocidas (ver editor 📚 Plantillas en el dashboard, tab Workflows):
--   nurture_step1        — bienvenida (nurture, paso 1)         [WIRED]
--   nurture_step2        — case study (nurture, paso 2)         [solo listado]
--   nurture_step3        — último toque (nurture, paso 3)       [solo listado]
--   calc_result           — resultado de la calculadora          [WIRED]
--   booking_confirmation — confirmación de call agendada         [WIRED]
--   review_request        — pedido de reseña Google              [solo listado]

create table if not exists public.email_templates (
  key         text not null,
  lang        text not null,
  subject     text not null default '',
  body        text not null default '',
  updated_at  timestamptz not null default now(),
  primary key (key, lang)
);
alter table public.email_templates enable row level security;
do $$ begin
  create policy "email_templates_auth_all" on public.email_templates for all to authenticated using (true) with check (true);
exception when duplicate_object then null; end $$;
