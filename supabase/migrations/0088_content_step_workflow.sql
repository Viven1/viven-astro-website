-- 0088: migra el follow-up de contenido (function content-followup) al
-- sistema de Workflows/Automations ya existente en el dashboard — pedido
-- explícito: "esos emails los quiero dentro del workflow, asi puedo
-- agregarle cosas y enviar a otro workflow y conectarlos entre ellos".
--
-- Nuevo step type 'content_step' (motor extendido en automations-run) y
-- nuevo filtro trigger_config.category en triggers lead_new — ver comentarios
-- en supabase/functions/automations-run/index.ts.
--
-- OJO — hallazgo real al hacer esto: el cron 'viven-automations' está
-- apagado desde la migración 0060 ("pausa total de emails automatizados",
-- 2026-07-13) y NUNCA se reactivó cuando se armó el Outbox con aprobación
-- (la condición que la propia 0060 pedía para revertir). Todo el motor de
-- Workflows estuvo muerto en la práctica desde entonces — la única automation
-- que existía (Referral post-proyecto) está enabled=false, así que reactivar
-- el cron acá no dispara nada viejo por sorpresa. Se reactiva con el mismo
-- patrón de header Authorization que el resto de los crons (0081).
do $$ begin perform cron.unschedule('viven-automations'); exception when others then null; end $$;
select cron.schedule('viven-automations', '*/20 * * * *', $$
  select net.http_post(
    url := 'https://lumoevaotokgqnpybkyf.supabase.co/functions/v1/automations-run',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization',
      'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')),
    body := '{}'::jsonb
  );
$$);

-- apaga el cron viejo de content-followup — el nuevo motor (automations-run)
-- reemplaza su lógica de punta a punta. Las tablas content_followup_state/
-- content_followup_log y la función quedan sin usar por ahora (no se borran
-- todavía — se confirma primero que el reemplazo funciona en producción,
-- mismo criterio que se usó para borrar nurture en 0085).
do $$ begin perform cron.unschedule('viven-content-followup'); exception when others then null; end $$;

-- el workflow real de Product Video, con el contenido EXACTO aprobado por
-- Sebastián (3 pasos EN/DE/ES, portado de content-followup/index.ts
-- CONTENT.product) armado como bloques (párrafo/grilla de 3 videos/link
-- card) editables desde el dashboard. trigger_config.category es el nuevo
-- filtro — matchea por el emoji de categoría en el mensaje de la
-- calculadora (mismo criterio que categoryOf() en automations-run).
with new_auto as (
  insert into public.automations (name, enabled, trigger, trigger_config, ab_split, steps_a, steps_b)
  values (
    '🎯 Product Video — contenido (calculadora)',
    true,
    'lead_new',
    '{"source":"calculator","category":"product","lang":"any"}'::jsonb,
    0,
    $json$[{"type":"wait","days":2},{"type":"content_step","from":"team","subject":{"en":"Three product videos worth a look","de":"Drei Produktvideos, die sich lohnen","es":"Tres videos de producto que vale la pena ver"},"blocks":[{"type":"p","muted":false,"text":{"en":"Hi {{first_name}},","de":"Hallo {{first_name}},","es":"Hola {{first_name}},"}},{"type":"p","muted":false,"text":{"en":"Since you were checking product video pricing — here's a few we've made, in case seeing the real thing is more useful than a range of numbers.","de":"Da Sie die Preise für Produktvideos geprüft haben — hier ein paar, die wir gemacht haben. Manchmal sagt das Ergebnis mehr als eine Preisspanne.","es":"Ya que estabas viendo precios de video de producto — acá van algunos que hicimos, por si ver el resultado real sirve más que un rango de números."}},{"type":"video_grid","items":[{"href":"https://www.viven.ch/en/meteomatics-product-campaign-brand-video/","img":"https://www.viven.ch/projects/meteomatics-product-campaign-brand-video/02-Meteomatics_VIVEN_Video_Agentur_040.jpg","caption":"Meteomatics"},{"href":"https://www.viven.ch/anybotics-anymal-c-product-launch/","img":"https://www.viven.ch/projects/anybotics-anymal-c-product-launch/01-on2019-08-22-12h10m12s489-1-1024x512.jpg","caption":"ANYbotics — ANYmal C"},{"href":"https://www.viven.ch/franke-the-office-hero-horeca-product-launch/","img":"https://www.viven.ch/projects/franke-the-office-hero-horeca-product-launch/01-ro__VIVEN_Video_Film_Production-007.jpeg","caption":"Franke — Office Hero"}]},{"type":"p","muted":true,"text":{"en":"Click any of them and it opens on our site. Wanted you to have these on hand.","de":"Einfach anklicken — es öffnet sich auf unserer Website. Wollten Ihnen diese einfach zur Verfügung stellen.","es":"Hacé clic en cualquiera y se abre en nuestro sitio. Quisimos que los tengas a mano."}},{"type":"p","muted":true,"text":{"en":"— Viven Team","de":"— Viven Team","es":"— Viven Team"}}]},{"type":"wait","days":3},{"type":"content_step","from":"team","subject":{"en":"How product videos actually move e-commerce numbers","de":"Wie Produktvideos die E-Commerce-Zahlen wirklich bewegen","es":"Cómo los videos de producto mueven de verdad los números de e-commerce"},"blocks":[{"type":"p","muted":false,"text":{"en":"Hi {{first_name}},","de":"Hallo {{first_name}},","es":"Hola {{first_name}},"}},{"type":"p","muted":false,"text":{"en":"Thought this might be useful while you're figuring out your own project:","de":"Dachte, das könnte nützlich sein, während Sie Ihr eigenes Projekt planen:","es":"Pensé que esto podría servirte mientras armás tu propio proyecto:"}},{"type":"link_card","icon":"📝","href":{"en":"https://www.viven.ch/en/blog/how-brands-increase-e-commerce-conversions-with-product-videos/","de":"https://www.viven.ch/de/blog/so-steigern-marken-ihre-e-commerce-konversionen-mit-produktvideos/","es":"https://www.viven.ch/es/blog/video-de-producto-como-convertir-caracteristicas-en-ventas/"},"title":{"en":"How Brands Increase E-commerce Conversions With Product Videos","de":"So steigern Marken ihre E-Commerce-Konversionen mit Produktvideos","es":"Video de producto: cómo convertir características en ventas"}},{"type":"p","muted":true,"text":{"en":"Short read — real examples of what changes when a product video is made with intent, not just nice footage.","de":"Kurze Lektüre — echte Beispiele, was sich ändert, wenn ein Produktvideo mit Absicht gemacht wird, nicht nur mit schönen Bildern.","es":"Lectura corta — ejemplos reales de lo que cambia cuando un video de producto se hace con intención, no solo con buenas imágenes."}},{"type":"p","muted":true,"text":{"en":"— Viven Team","de":"— Viven Team","es":"— Viven Team"}}]},{"type":"wait","days":4},{"type":"content_step","from":"team","subject":{"en":"The other reason product videos work","de":"Der andere Grund, warum Produktvideos wirken","es":"Otra cosa que hace que un video de producto valga la pena"},"blocks":[{"type":"p","muted":false,"text":{"en":"Hi {{first_name}},","de":"Hallo {{first_name}},","es":"Hola {{first_name}},"}},{"type":"p","muted":false,"text":{"en":"One more angle, less obvious than \"more sales\":","de":"Noch ein Blickwinkel, weniger offensichtlich als «mehr Verkäufe»:","es":"Otro ángulo, menos obvio que \"más ventas\":"}},{"type":"link_card","icon":"📝","href":{"en":"https://www.viven.ch/en/blog/how-product-videos-shorten-the-sales-cycle-for-brands/","de":"https://www.viven.ch/de/blog/wie-produktvideos-den-verkaufsprozess-für-marken-verkuerzen/","es":"https://www.viven.ch/es/services/product-video/"},"title":{"en":"How Product Videos Shorten the Sales Cycle for Brands","de":"Wie Produktvideos den Verkaufsprozess für Marken verkürzen","es":"Cómo trabajamos los videos de producto"}},{"type":"p","muted":true,"text":{"en":"It's less about marketing and more about saving your own sales team time on every call. If any of this is useful, happy to talk it through — book a free 15-min call at https://www.viven.ch/book/. If not, no worries either way, we won't keep nudging.","de":"Es geht weniger um Marketing als darum, Ihrem Sales-Team bei jedem Gespräch Zeit zu sparen. Falls das nützlich ist, sprechen wir gerne darüber — gratis 15-Min-Call auf https://www.viven.ch/book/. Falls nicht, auch gut, wir haken nicht weiter nach.","es":"Menos sobre marketing y más sobre ahorrarle tiempo a tu propio equipo de ventas en cada llamada. Si algo de esto te sirve, hablemos — reservá una llamada gratis de 15 min en https://www.viven.ch/book/. Si no, sin problema, no vamos a insistir."}},{"type":"p","muted":true,"text":{"en":"— Viven Team","de":"— Viven Team","es":"— Viven Team"}}]}]$json$::jsonb,
    '[]'::jsonb
  )
  returning id
)
-- backfill de las 2 inscripciones reales que ya tenía content_followup_state
-- (lead 49 Alfred, enrolado 2026-07-15, ya con el paso 1 pendiente de OK en
-- outbox → arranca en step_idx=3, el paso 2, que ya vence hoy; lead 58,
-- enrolado hoy 2026-07-20 → arranca en step_idx=0, el primer wait).
insert into public.automation_runs (automation_id, lead_id, variant, step_idx, next_at, status, created_at)
select id, 49, 'a', 3, now(), 'active', '2026-07-15 14:43:25.396463+00'::timestamptz from new_auto
union all
select id, 58, 'a', 0, now(), 'active', '2026-07-20 08:23:59.095056+00'::timestamptz from new_auto;
