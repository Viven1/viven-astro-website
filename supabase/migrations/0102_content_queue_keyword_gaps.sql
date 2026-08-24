-- Gaps de keywords detectados en GSC (90 días) sin página que los ataque —
-- van a la cola del motor de contenido (cron L/M/V escribe EN+DE+ES como
-- borradores; Sebastián aprueba antes de publicar). Prioridad = impresiones
-- ya existentes con posición mala o sin página dedicada.
insert into public.content_queue (topic, priority, target_keyword, keyword_why)
values
  ('Business video production: what it costs and how it works for Swiss companies', 9, 'business video production',
   '60 impresiones/90d en posición 18.3 — a un empujón de página 1 y sin página dedicada'),
  ('Corporate training video production: formats that employees actually finish', 8, 'corporate training video production',
   'Posición 10.6 con 8 impresiones sin página dedicada — quick win'),
  ('Animated video production for business: when animation beats live action', 8, 'animated video production',
   'Cluster de 3 queries (animierte videos produktion 13.5, animiertes video produktion 22.3, animated video content 21.6) sin ninguna página de animación'),
  ('Conference video production: turning one event into a month of content', 7, 'conference video production',
   'Posición 56 con 8 impresiones — tema evento/conferencia sin página propia'),
  ('B2B Erklärvideo: So vereinfachen Schweizer Firmen komplexe Produkte', 7, 'b2b erklärvideo',
   'Query alemana en posición 24.7 — los posts explainer existen en DE pero ninguno ataca el término exacto');
