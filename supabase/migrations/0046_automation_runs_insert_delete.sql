-- 0046: faltaban las policies de INSERT/DELETE en automation_runs (0041/0043
-- solo dieron SELECT/UPDATE). Sin esto, el nuevo botón "➕ Agregar persona" del
-- panel de Inscriptos (Workflows) fallaba silenciosamente por RLS, y no había
-- forma de sacar del todo a alguien inscripto (solo pausar con status).

do $$ begin
  create policy "automation_runs_i" on public.automation_runs for insert to authenticated with check (true);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "automation_runs_d" on public.automation_runs for delete to authenticated using (true);
exception when duplicate_object then null; end $$;
