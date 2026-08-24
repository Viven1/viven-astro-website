-- 0032: MOTOR DE CONTENIDO — cola de temas + cron L/M/V.
-- La función content-engine toma el próximo tema pendiente, escribe el artículo
-- EN + versión nativa DE como BORRADORES en blogs (aprobás en el tab Blog) y
-- avisa por push. Sembrada con 24 temas (~8 semanas a 3/semana).

create table if not exists public.content_queue (
  id         bigint generated always as identity primary key,
  topic      text not null,
  priority   int default 0,          -- mayor = antes
  status     text default 'pending', -- pending | working | done
  done_at    timestamptz,
  created_at timestamptz default now()
);
alter table public.content_queue enable row level security;
drop policy if exists cq_auth_all on public.content_queue;
create policy cq_auth_all on public.content_queue for all to authenticated using (true) with check (true);

insert into public.content_queue (topic, priority)
select * from (values
  ('How much does a corporate video cost in Switzerland in 2026 — real price ranges', 10),
  ('How to choose a video production company in Zurich: a practical checklist', 9),
  ('Video production ROI: how Swiss brands measure what a film returns', 8),
  ('Employer branding video ideas that actually attract Swiss talent', 8),
  ('B2B video marketing strategy for the DACH market', 7),
  ('One shoot, ten assets: how batch video production cuts cost per video', 7),
  ('Social media video in 2026: formats, lengths and specs per platform', 6),
  ('Testimonial videos: how to get your customers to say yes on camera', 6),
  ('Product video vs product demo: what converts better and when', 6),
  ('Explainer videos for complex products: lessons from tech shoots', 5),
  ('Multilingual video: one production for every Swiss language region', 5),
  ('Video SEO: how to get your videos ranking on Google and YouTube', 5),
  ('Corporate video trends 2026: what Swiss brands are producing now', 4),
  ('The real cost drivers of video production (and where not to save)', 4),
  ('Why your paid ads need dedicated video — not your brand film', 4),
  ('Recruiting Gen Z with video: what works in 2026', 3),
  ('How-to videos that reduce support tickets and onboarding time', 3),
  ('Live streaming corporate events: a realistic setup guide', 3),
  ('Drone footage in Switzerland: rules, permits and when it is worth it', 2),
  ('Internal communication videos employees actually watch', 2),
  ('Video for trade shows and events: before, during and after', 2),
  ('From brief to premiere: a realistic video production timeline', 1),
  ('Behind the scenes: what happens on a professional shoot day', 1),
  ('How AI is changing video production — and what stays human', 1)
) as seed(topic, priority)
where not exists (select 1 from public.content_queue);

-- cron: lunes, miércoles y viernes 05:30 UTC (≈07:30 CH)
create extension if not exists pg_cron;
create extension if not exists pg_net;
do $$ begin
  perform cron.unschedule('viven-content-engine');
exception when others then null; end $$;
select cron.schedule('viven-content-engine', '30 5 * * 1,3,5', $$
  select net.http_post(
    url := 'https://lumoevaotokgqnpybkyf.supabase.co/functions/v1/content-engine',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body := '{}'::jsonb
  );
$$);
