-- 0061: Ofertas — validez editable + textos personales + idioma
-- El rediseño del editor de ofertas (4 pasos) guarda:
--   valid_until   → fecha de validez editable (antes clavada en +30 días en el código)
--   intro_text    → texto personal de intro (sale en el PDF, en el email y arriba de las posiciones)
--   closing_text  → texto personal de cierre (antes del pie legal)
--   lang          → idioma de la oferta: 'de' | 'en' | 'es' (PDF + email en el idioma del cliente)
-- El dashboard funciona también SIN esta migración (saveOffer quita las columnas que falten
-- y reintenta), pero los campos no persisten hasta correrla.

alter table offers add column if not exists valid_until date;
alter table offers add column if not exists intro_text text;
alter table offers add column if not exists closing_text text;
alter table offers add column if not exists lang text;
