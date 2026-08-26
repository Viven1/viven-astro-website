-- Un artículo publicado por idioma y por grupo. Nunca dos.
--
-- El motor creó DOS filas para el mismo artículo, con segundos de diferencia (13:16:34 y
-- 13:16:41; 13:51:14 y 13:51:30), las dos marcadas 'published' y las dos apuntando a la
-- MISMA URL. La web sirve una y el dashboard deja editar la otra: es el "creé dos blogs
-- y guardé fotos y videos distintos, pero no publicó los que yo quería" de Sebastián.
--
-- Verificado con curl antes de tocar nada: la página en vivo tiene el título de la fila
-- 63 ("Produktvideo ODER Produktdemo") y de la 48 ("capacitación"), no el de sus mellizas
-- 62 y 47 —que son justo las que él venía editando—. Así que las que NO están en vivo
-- pasan a borrador: no se borra nada ni se cambia una coma de la web, solo deja de
-- mentir el estado. Sus ediciones siguen ahí, ahora visibles como borrador para poder
-- publicarlas a mano cuando él quiera.
update public.blogs set status='draft' where id in (62, 47);

-- Y que no vuelva a pasar: contra una carrera, el que tiene que decir que no es la base.
create unique index if not exists blogs_un_publicado_por_grupo_idioma
  on public.blogs (group_id, lang) where status = 'published';
