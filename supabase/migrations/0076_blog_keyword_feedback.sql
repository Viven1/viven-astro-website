-- 0076_blog_keyword_feedback.sql
-- Sebastián: "quiero que la función de contenido SIEMPRE me diga qué keyword es
-- importante para ese blog y de qué ranking arrancó, para decidir si vale la
-- pena escribirlo — si solo juzgo por el texto no sé si vale la pena o no."
-- Quiere DATO de keyword+ranking pegado a cada borrador, no solo prosa de IA.
--
-- content_queue guarda la keyword objetivo (viene de keyword_opportunities,
-- SQL 0070, cuando el tema se manda a la cola desde el SEO Keyword Manager).
-- content-engine hace un lookup EN VIVO a Search Console de esa keyword exacta
-- al escribir el artículo y computa un veredicto DETERMINÍSTICO (reglas fijas
-- sobre la posición real, no otra opinión de IA) — se guarda en blogs para
-- que se vea en el tab Blog y en el email de aprobación.
--
-- Todas las columnas nullable: temas legacy/manuales (sin keyword objetivo)
-- siguen funcionando igual, solo no tienen dato de ranking para mostrar.
-- Idempotente: se puede correr varias veces sin romper nada.

alter table public.content_queue add column if not exists target_keyword text;
alter table public.content_queue add column if not exists keyword_why text;
alter table public.content_queue add column if not exists keyword_priority int;

alter table public.blogs add column if not exists target_keyword text;
alter table public.blogs add column if not exists keyword_current_position numeric;
alter table public.blogs add column if not exists keyword_verdict text;          -- nuevo | quick_win | ya_rankea_bien | dudoso | sin_keyword
alter table public.blogs add column if not exists keyword_verdict_why text;
