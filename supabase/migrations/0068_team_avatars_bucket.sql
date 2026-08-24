-- 0068: bucket público de Storage para las fotos de "👤 Mi perfil" (team_profiles.avatar_url).
-- Pedido de Sebastián — verificado en vivo: sin esto, subir foto falla con
-- "Bucket not found" (el resto del perfil ya funciona bien sin esto).

insert into storage.buckets (id, name, public)
values ('team-avatars', 'team-avatars', true)
on conflict (id) do nothing;

-- lectura pública (son fotos de perfil que salen en emails/firmas — no son privadas)
do $$ begin
  create policy "team-avatars public read"
  on storage.objects for select
  to public
  using (bucket_id = 'team-avatars');
exception when duplicate_object then null; end $$;

-- cualquier usuario logueado del dashboard puede subir/actualizar/borrar
-- (mismo patrón "authenticated using true" que el resto de las tablas de esta app)
do $$ begin
  create policy "team-avatars auth insert"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'team-avatars');
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "team-avatars auth update"
  on storage.objects for update
  to authenticated
  using (bucket_id = 'team-avatars');
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "team-avatars auth delete"
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'team-avatars');
exception when duplicate_object then null; end $$;
