-- Bucket PRIVADO para lead magnets: los PDFs salían de public/downloads/
-- (URL directa = gate salteable, detectado por Sebastián). Ahora viven acá
-- y solo se entregan vía URL firmada de la función magnet-download, después
-- de capturar el email.
insert into storage.buckets (id, name, public)
values ('magnets', 'magnets', false)
on conflict (id) do nothing;
