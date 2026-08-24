-- 0089: el contenido en alemán de content_step ya usa Sie (formal) en el
-- cuerpo ("Da Sie die Preise..."), pero el saludo decía "Hallo
-- {{first_name}}," (informal) — mezcla de registro, suena raro en alemán de
-- negocios. Pedido explícito de Sebastián: si es Sie, va apellido, no
-- nombre de pila. NO se adivina Herr/Frau (no hay campo de género en leads,
-- y adivinarlo por nombre de pila puede fallar con nombres
-- internacionales/ambiguos) — "Guten Tag {{last_name}}," es el patrón
-- seguro y aceptado en alemán de negocios cuando no se quiere adivinar
-- género. {{last_name}} ya lo resuelve fill() en automations-run (con
-- fallback a first_name si el lead no tiene apellido cargado).
update public.automations
set steps_a = replace(steps_a::text, 'Hallo {{first_name}},', 'Guten Tag {{last_name}},')::jsonb,
    updated_at = now()
where id = '95a42115-92ff-47cb-a6c3-eae1996b22b1';
