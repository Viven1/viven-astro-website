-- ============================================================================
--  Viven — el newsletter manual, en tres idiomas (0145)
--
--  La edición mensual automática (newsletter_issues) ya manda asunto y cuerpo en el
--  idioma de cada persona: guarda content = {en:{subject,html}, de:{...}, es:{...}}
--  y la función de envío elige el que corresponde. El newsletter MANUAL no: guardaba
--  un solo subject y un solo juego de bloques, así que un contacto alemán recibía
--  "Guten Tag" y después el texto en inglés — que se lee peor que no traducir nada.
--  Y no es un caso raro: de los 33 destinatarios reales, 24 son EN y 9 DE.
--
--  Esta columna le da al manual la MISMA forma que ya usa el automático, para que la
--  función de envío no tenga que aprender un formato nuevo:
--     blocks_i18n = { "en": [bloques…], "de": [bloques…], "es": [bloques…] }
--     subject_i18n = { "en": "…", "de": "…", "es": "…" }
--
--  Compatibilidad: las campañas viejas siguen con blocks/subject planos y se mandan
--  igual que siempre. Solo si hay versión para el idioma de esa persona se usa; si
--  no, cae al inglés y después al contenido plano. Nadie se queda sin email por esto.
-- ============================================================================

alter table public.newsletters
  add column if not exists blocks_i18n  jsonb,
  add column if not exists subject_i18n jsonb;

comment on column public.newsletters.blocks_i18n is
  'Bloques por idioma: {"en":[...],"de":[...],"es":[...]}. Si falta el idioma de la persona, se usa "en"; si tampoco está, el campo blocks plano.';
comment on column public.newsletters.subject_i18n is
  'Asunto por idioma. Mismo fallback que blocks_i18n.';
