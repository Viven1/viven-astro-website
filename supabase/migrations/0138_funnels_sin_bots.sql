-- ============================================================================
--  Viven — Funnels con drop-off, sin bots (0138). Hermana de la 0137.
--
--  El paso 0 de cada funnel ('view') se dispara al cargar la página: un bot que
--  renderiza /kostenkalkulation/ y se va queda registrado como "vio la
--  calculadora". Los pasos siguientes exigen tocar algo, así que ningún bot llega.
--  Resultado: la base del funnel estaba inflada y el drop-off del primer escalón
--  parecía catastrófico cuando en realidad medía tráfico automático abandonando
--  una página que nunca quiso ver.
--
--  Mismo criterio que la 0137: con p_solo_personas la ventana se recorta al 24/08,
--  porque antes de esa fecha no hay con qué separar.
-- ============================================================================

drop function if exists public.rpc_funnel_steps(text, int);

create or replace function public.rpc_funnel_steps(p_funnel text, p_days int default 28, p_solo_personas boolean default false)
returns table(step int, label text, sessions bigint)
language sql security definer set search_path = public as $$
  with fe as (
    select f.step, f.label, f.session_id
    from funnel_events f
    where f.funnel = p_funnel
      and f.created_at >= case when p_solo_personas
                               then greatest(now() - (p_days || ' days')::interval, public.humanos_desde())
                               else now() - (p_days || ' days')::interval end
      and (not p_solo_personas
           or exists (select 1 from session_activity a where a.session_id = f.session_id))
  )
  select fe.step, min(fe.label), count(distinct fe.session_id)::bigint
  from fe group by fe.step order by fe.step;
$$;

revoke execute on function public.rpc_funnel_steps(text, int, boolean) from public, anon;
grant  execute on function public.rpc_funnel_steps(text, int, boolean) to authenticated;
