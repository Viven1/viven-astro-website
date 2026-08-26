-- ============================================================================
--  Los tests de Sebastián no son leads.
--
--  26 ago 2026: "todos los tests que hago con sebastian@viven.ch y
--  cepeda.sebastian@gmail.com no pueden contar como leads, o me falsifica todos los
--  datos."
--
--  Ya existía esInterno() en el dashboard, pero solo se usaba en cinco lugares de
--  analytics: las listas, el pipeline, los contadores y la tasa de conversión sí los
--  contaban. Probar la propia web subía el número de leads del mes.
--
--  Se marca en la BASE y no en la pantalla a propósito: hay tres puertas de entrada
--  (formularios del sitio, la calculadora, los magnets) y una regla que vive en una
--  sola de ellas es una regla que se va a olvidar en la próxima.
--
--  NO se borran: son la prueba de que el formulario funciona. Se marcan, y quedan a un
--  clic de distancia en su propio segmento.
--
--  Idempotente.
-- ============================================================================

alter table public.leads
  add column if not exists es_prueba boolean not null default false;

/* Una sola definición de "esto es una prueba". Si mañana se suma otra dirección, se
   cambia acá y vale para lo que entre y para lo que ya entró. */
create or replace function public.email_es_prueba(e text)
returns boolean language sql immutable as $$
  select coalesce(
    lower(btrim(e)) like '%@viven.ch'
    or lower(btrim(e)) in ('cepeda.sebastian@gmail.com')
    or lower(btrim(e)) like '%@entropia%'
    or lower(btrim(e)) like 'test@%'
    or lower(btrim(e)) like '%@test.%'
    or lower(btrim(e)) like '%@example.%'
  , false);
$$;

create or replace function public.leads_marcar_prueba()
returns trigger language plpgsql as $$
begin
  new.es_prueba := public.email_es_prueba(new.email);
  return new;
end $$;

drop trigger if exists leads_marcar_prueba_tg on public.leads;
create trigger leads_marcar_prueba_tg
  before insert or update of email on public.leads
  for each row execute function public.leads_marcar_prueba();

-- Los que ya están.
update public.leads
   set es_prueba = public.email_es_prueba(email)
 where es_prueba is distinct from public.email_es_prueba(email);

create index if not exists leads_es_prueba_idx on public.leads (es_prueba) where es_prueba;

comment on column public.leads.es_prueba is
  'Entró por una prueba nuestra, no es un lead. No se borra: se excluye de listas, contadores y conversión.';
