-- Licencias sin cliente atado: dónde recordar que ya avisamos.
--
-- license-remind dedupea los avisos buscando el marcador [LIC#id:fecha:hito] entre los
-- títulos de lead_tasks. Pero lead_tasks.lead_id es NOT NULL, así que una licencia sin
-- cliente no puede generar tarea — y sin tarea no hay marcador, y sin marcador el push
-- sale todos los días para siempre. Las dos licencias que hay hoy están exactamente así.
--
-- Este campo guarda el último marcador avisado en la propia fila de la licencia, que es
-- donde pertenece: no depende de que exista un contacto.
alter table public.licenses add column if not exists last_alert text;
comment on column public.licenses.last_alert is
  'Último marcador [LIC#id:fecha:hito] avisado por license-remind. Evita repetir el push a diario en licencias sin cliente atado.';
