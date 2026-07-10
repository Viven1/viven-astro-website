-- ============================================================
-- ACCESO AL DASHBOARD — pegar en Supabase → SQL Editor → Run
-- Permite LEER los datos (y editar el status de los leads) SOLO
-- al usuario sebastian@viven.ch, vía login en /dashboard/.
--
-- Se puede ejecutar las veces que haga falta (borra y recrea).
--
-- ⚠️ ANTES DE USAR EL DASHBOARD, crea tu usuario:
--    Supabase → Authentication → Users → Add user →
--    email: sebastian@viven.ch + contraseña fuerte
--    (marca "Auto Confirm User")
-- ============================================================

-- limpiar versiones anteriores de estas policies (cualquier email)
drop policy if exists "owner reads leads"       on public.leads;
drop policy if exists "owner updates leads"     on public.leads;
drop policy if exists "owner deletes leads"     on public.leads;
drop policy if exists "owner reads pageviews"   on public.pageviews;
drop policy if exists "owner reads video_stats" on public.video_stats;

-- lectura de leads
create policy "owner reads leads" on public.leads
  for select to authenticated
  using ((auth.jwt() ->> 'email') = 'sebastian@viven.ch');

-- editar leads (cambiar status: new → contacted → won…)
create policy "owner updates leads" on public.leads
  for update to authenticated
  using ((auth.jwt() ->> 'email') = 'sebastian@viven.ch')
  with check ((auth.jwt() ->> 'email') = 'sebastian@viven.ch');

-- borrar leads (spam, pruebas) — solo desde el dashboard
create policy "owner deletes leads" on public.leads
  for delete to authenticated
  using ((auth.jwt() ->> 'email') = 'sebastian@viven.ch');

-- lectura de analítica
create policy "owner reads pageviews" on public.pageviews
  for select to authenticated
  using ((auth.jwt() ->> 'email') = 'sebastian@viven.ch');

create policy "owner reads video_stats" on public.video_stats
  for select to authenticated
  using ((auth.jwt() ->> 'email') = 'sebastian@viven.ch');

-- los visitantes anónimos siguen igual: solo INSERT, nada más
