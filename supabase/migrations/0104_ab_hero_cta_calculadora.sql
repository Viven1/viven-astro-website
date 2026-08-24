-- Primer test A/B real (aprobado sobre mockup): CTA del hero de la home EN.
-- A (control): "Start a project" → /en/contact/
-- B (variante): "Get a price in 60 seconds" → calculadora — pide menos
-- compromiso; hipótesis: más clicks y más leads vía calculadora.
-- El cambio de data-en acompaña al de texto porque setLang() re-aplica los
-- data-attrs al cargar (el runtime A/B ya re-aplica a los 700ms igualmente).
-- Resultados: dashboard → Sistema → A/B (exposiciones en ab_hits, conversión
-- por tag en leads.ab). El autostop de 0074 lo corta solo si hay ganador.
insert into public.ab_tests (name, url_path, status, split_pct, changes, start_at, notes)
values (
  'Hero CTA: precio en 60s vs start a project',
  '/en/',
  'running',
  50,
  '[
    {"sel": ".hero-cta .btn-primary", "idx": 0, "type": "text",
     "from": "Start a project", "to": "Get a price in 60 seconds"},
    {"sel": ".hero-cta .btn-primary", "idx": 0, "type": "attr", "name": "data-en",
     "from": "Start a project", "to": "Get a price in 60 seconds"},
    {"sel": ".hero-cta .btn-primary", "idx": 0, "type": "href",
     "from": "/en/contact/", "to": "/en/video-cost-calculator/"}
  ]'::jsonb,
  now(),
  'Aprobado 2026-07-24 sobre mockup. B apunta a la calculadora: menos compromiso, más leads.'
);
