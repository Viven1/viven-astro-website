-- Borrar un proyecto tiene que llevarse TODO lo suyo.
--
-- project_briefs, project_contacts y project_scripts no tenían clave foránea a projects:
-- al borrar el proyecto quedaban filas huérfanas apuntando a un id que ya no existe. No
-- molestan a la vista, pero un ref reusado en el futuro heredaría el brief de un proyecto
-- borrado — y eso sí se ve, en la pantalla equivocada.
--
-- Se limpian primero las que ya quedaron sueltas, si hay.

delete from project_briefs   where project_id is not null and project_id not in (select id from projects);
delete from project_contacts where project_id is not null and project_id not in (select id from projects);
delete from project_scripts  where project_id is not null and project_id not in (select id from projects);

alter table project_briefs
  add constraint project_briefs_project_fk
  foreign key (project_id) references projects(id) on delete cascade;

alter table project_contacts
  add constraint project_contacts_project_fk
  foreign key (project_id) references projects(id) on delete cascade;

alter table project_scripts
  add constraint project_scripts_project_fk
  foreign key (project_id) references projects(id) on delete cascade;
