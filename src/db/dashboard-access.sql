-- ============================================================
-- ACCESO AL DASHBOARD — pegar en Supabase → SQL Editor → Run
-- Permite LEER los datos (y editar el status de los leads) SOLO
-- al usuario con el email de abajo, vía login en /dashboard/.
--
-- ⚠️ ANTES DE USAR EL DASHBOARD, crea tu usuario:
--    Supabase → Authentication → Users → Add user →
--    email: sebastian@entropia-studios.com  +  contraseña fuerte
--    (marca "Auto Confirm User")
-- Si prefieres otro email, cámbialo aquí abajo en las 5 líneas.
-- ============================================================

-- lectura de leads
create policy "owner reads leads" on public.leads
  for select to authenticated
  using ((auth.jwt() ->> 'email') = 'sebastian@entropia-studios.com');

-- editar leads (cambiar status: new → contacted → won…)
create policy "owner updates leads" on public.leads
  for update to authenticated
  using ((auth.jwt() ->> 'email') = 'sebastian@entropia-studios.com')
  with check ((auth.jwt() ->> 'email') = 'sebastian@entropia-studios.com');

-- lectura de analítica
create policy "owner reads pageviews" on public.pageviews
  for select to authenticated
  using ((auth.jwt() ->> 'email') = 'sebastian@entropia-studios.com');

create policy "owner reads video_stats" on public.video_stats
  for select to authenticated
  using ((auth.jwt() ->> 'email') = 'sebastian@entropia-studios.com');

-- los visitantes anónimos siguen igual: solo INSERT, nada más
