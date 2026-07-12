-- 0038: profundidad de video — hitos de retención 25/50/75/100.
-- site.js inserta una fila por hito alcanzado (pct); las filas viejas quedan
-- con pct=0 (= play). El panel 🎬 de Analytics arma dropoff y conversión.

alter table public.video_plays add column if not exists pct int not null default 0;
