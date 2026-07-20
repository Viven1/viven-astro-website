-- 0087: columna category en blogs — pedido explícito: "el blog no tiene
-- filtros para entender que tipos de blogs tenemos... sino tienen que leer
-- todo y nadie lo hará". content-engine YA clasifica cada post con
-- classify(topic) para elegir la imagen (MEDIA[cat]), pero nunca guardaba el
-- resultado — se recalcula acá mismo para no duplicar categorías nuevas.
--
-- Mismo topic para las 3 filas de un grupo (content-engine escribe
-- topic: item.topic idéntico en EN/DE/ES) → mismo category sin importar el
-- idioma, calculado una sola vez por grupo en la práctica.

alter table public.blogs add column if not exists category text;

-- backfill de los posts existentes: MISMA lógica y MISMO orden de precedencia
-- que classify(topic) en content-engine/index.ts (case-insensitive).
update public.blogs set category = case
  when topic ~* 'corporate|internal comm' then 'corporate'
  when topic ~* 'employer|recruit|talent|gen z' then 'employer'
  when topic ~* 'product' then 'product'
  when topic ~* 'social' then 'social'
  when topic ~* 'how-to|explainer|support|onboarding|e-learning' then 'howto'
  when topic ~* 'event|stream|trade show' then 'event'
  when topic ~* 'cost|price|roi|choose|brief|timeline|process|shoot day|batch' then 'process'
  when topic ~* 'brand|marketing|video seo|multilingual|trend' then 'brand'
  else 'general'
end
where category is null;
