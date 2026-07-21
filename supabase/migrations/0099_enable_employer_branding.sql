-- Employer Branding se quedó apagado por un doble-click en el toggle del
-- dashboard (bug real: el botón no se deshabilitaba durante el request,
-- así que un segundo click mientras la lista se refrescaba lo prendía y
-- apagaba de nuevo). Se activa acá para que quede igual que sus hermanos
-- (brand, corporate, howto, social), todos ya activados por Sebastián.
update public.automations
set enabled = true, updated_at = now()
where id = 'c118f878-61fe-4a49-852d-0aa7e25e7094';
