-- Un solo nombre para el primer estado: 'nuevo'.
--
-- La base tenía las dos formas conviviendo: 168 'ganado', 13 'nuevo' y DOS 'new'
-- (los dos contactos cargados a mano el 24 ago 2026 — el importador de CSV escribía
-- status:'new'). El dashboard y las funciones normalizan las dos formas, así que no
-- rompía nada hoy; pero cualquier consulta futura que filtre por 'nuevo' —una RPC, un
-- reporte, un motor nuevo— se saltea esas filas en silencio, que es exactamente el tipo
-- de bug que no se ve hasta que falta alguien.
update public.leads set status = 'nuevo' where status = 'new';
