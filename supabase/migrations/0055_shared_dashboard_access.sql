-- 0055: RLS heredado de cuando el dashboard era de una sola persona.
-- leads/pageviews/video_stats seguían restringidos a auth.jwt() email =
-- sebastian@viven.ch — Sofia (o cualquier otro user autenticado) no veía
-- nada y no podía crear leads a mano. Se alinea con el patrón que ya usa
-- el resto de las tablas del dashboard: cualquier authenticated ve/edita
-- todo por igual.

drop policy if exists "owner read" on public.leads;
drop policy if exists "owner update leads" on public.leads;
drop policy if exists "owner delete leads" on public.leads;
create policy "authenticated_select_leads" on public.leads for select to authenticated using (true);
create policy "authenticated_insert_leads" on public.leads for insert to authenticated with check (true);
create policy "authenticated_update_leads" on public.leads for update to authenticated using (true) with check (true);
create policy "authenticated_delete_leads" on public.leads for delete to authenticated using (true);

drop policy if exists "owner read" on public.pageviews;
create policy "authenticated_select_pageviews" on public.pageviews for select to authenticated using (true);

drop policy if exists "owner read" on public.video_stats;
create policy "authenticated_select_video_stats" on public.video_stats for select to authenticated using (true);
