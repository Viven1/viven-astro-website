-- 0043: policy de UPDATE en automation_runs — faltaba desde el 0041.
-- El botón "✉️ Respondió" de la ficha necesita frenar (status='stopped') los
-- runs activos del lead; sin esta policy, la llamada fallaba silenciosamente
-- por RLS (0041 solo daba permiso de SELECT).

do $$ begin
  create policy "automation_runs_u" on public.automation_runs for update to authenticated using (true) with check (true);
exception when duplicate_object then null; end $$;
