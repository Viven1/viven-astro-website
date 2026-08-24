-- 0072: enriquecimiento con IA para EMPRESAS (co3) — mismo patrón que leads.enrichment/
-- leads.enriched_at (SQL 0021), pero a nivel companies. Pedido de Sebastián viendo la
-- ficha de "Thepinnacle" con casi todos los campos vacíos: "si ya tenes la url/domain
-- de la empresa, hace un google search y llena automáticamente". ai-enrich (SQL/función
-- ya existente, hoy solo wireada a Personas) ya busca en la web y devuelve
-- {persona, empresa:{nombre,resumen,web,industria,empleados,ubicacion,redes,noticias},
-- hooks, fuentes} — acá solo agregamos dónde guardarlo para una empresa.
alter table public.companies add column if not exists enrichment jsonb;
alter table public.companies add column if not exists enriched_at timestamptz;
