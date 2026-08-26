-- El email de quien monta, para poder mandarle las notas del cliente.
--
-- Sebastián, 26 ago 2026: "toca poder enviar al editor que trabaja en eso… cuando
-- ponemos el contacto del editor, ponemos el email y un botón para nosotros enviar al
-- editor. Le envía el xml más todos los comentarios con timestamps para que lo vea en
-- el email."
--
-- Las dos cosas en el mismo envío y no una: el .xml sirve adentro de Premiere, pero el
-- montajista lee el email antes de abrir nada. Si las notas solo viajan adjuntas, la
-- primera lectura obliga a importar un archivo.
alter table public.projects
  add column if not exists editor_email text;

comment on column public.projects.editor_email is
  'A quién se le mandan las notas del cliente con timecode. Puede ser freelance: no tiene por qué estar en team_profiles.';
