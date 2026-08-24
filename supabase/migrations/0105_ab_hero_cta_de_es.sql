-- El test del hero CTA (0104, home EN) extendido a DE y ES como tests
-- separados — cada idioma mide su propia conversión en el tab A/B.
-- Variante B: texto "precio en 60s" + link a la calculadora del idioma.
-- Igual que en 0104, se cambia también el data-attr del idioma porque
-- setLang() re-aplica los data-* al cargar.
insert into public.ab_tests (name, url_path, status, split_pct, changes, start_at, notes)
values
(
  'Hero CTA DE: Preis in 60s vs Projekt starten',
  '/de/',
  'running',
  50,
  '[
    {"sel": ".hero-cta .btn-primary", "idx": 0, "type": "text",
     "from": "Projekt starten", "to": "Preis in 60 Sekunden erhalten"},
    {"sel": ".hero-cta .btn-primary", "idx": 0, "type": "attr", "name": "data-de",
     "from": "Projekt starten", "to": "Preis in 60 Sekunden erhalten"},
    {"sel": ".hero-cta .btn-primary", "idx": 0, "type": "href",
     "from": "/de/contact/", "to": "/de/videoproduktion-kosten-rechner/"}
  ]'::jsonb,
  now(),
  'Extensión del test 0104 a DE, aprobado 2026-07-24.'
),
(
  'Hero CTA ES: precio en 60s vs iniciar proyecto',
  '/es/',
  'running',
  50,
  '[
    {"sel": ".hero-cta .btn-primary", "idx": 0, "type": "text",
     "from": "Iniciar proyecto", "to": "Conseguí tu precio en 60 segundos"},
    {"sel": ".hero-cta .btn-primary", "idx": 0, "type": "attr", "name": "data-es",
     "from": "Iniciar proyecto", "to": "Conseguí tu precio en 60 segundos"},
    {"sel": ".hero-cta .btn-primary", "idx": 0, "type": "href",
     "from": "/es/contact/", "to": "/es/calculadora-costos-video/"}
  ]'::jsonb,
  now(),
  'Extensión del test 0104 a ES, aprobado 2026-07-24.'
);
