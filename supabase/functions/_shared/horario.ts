// Horario laboral suizo — UNA sola definición para todo lo que manda emails.
//
// Regla de Sebastián: los newsletters salen lunes a viernes, 09:00–12:00 y
// 13:30–17:00, hora de Zúrich. Nunca después de las 17:00, nunca un fin de semana.
//
// Hasta el 2 sep 2026 esta regla vivía SOLO en newsletter-dispatch (el que manda
// los programados). «Aprobar y enviar» del dashboard llamaba directo a
// newsletter-send, que no la miraba, y una edición salió a 44 personas un
// miércoles a las 19:50. La regla tiene que vivir en el que envía: así ningún
// botón, cron ni llamada a mano la puede saltear.
// (Sebastián: "siempre esa regla, si hago aprobar y enviar que controle antes
// de enviar ciegamente".)

export const ZONA = "Europe/Zurich";
export const HORARIO_LABEL = "Lun-Vie 09:00-12:00 y 13:30-17:00 (Europe/Zurich)";
// ventanas en minutos desde medianoche. El hueco 12:00–13:30 es deliberado.
const VENTANAS: [number, number][] = [[9 * 60, 12 * 60], [13 * 60 + 30, 17 * 60]];
const DIAS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function zurich(d: Date): { dow: number; min: number; label: string } {
  const partes = new Intl.DateTimeFormat("en-GB", {
    timeZone: ZONA, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(d);
  const g = (t: string) => partes.find((x) => x.type === t)?.value ?? "";
  const hh = Number(g("hour")), mm = Number(g("minute"));
  return { dow: DIAS[g("weekday")] ?? 1, min: hh * 60 + mm, label: g("weekday") + " " + g("hour") + ":" + g("minute") };
}

export function enHorarioLaboral(d: Date): boolean {
  const { dow, min } = zurich(d);
  if (dow < 1 || dow > 5) return false;                       // sábado/domingo no
  return VENTANAS.some(([desde, hasta]) => min >= desde && min < hasta);
}

/* El próximo instante en que SÍ se puede mandar. Se avanza de a un minuto sobre
   la hora real, así el cambio de hora (CET/CEST) lo resuelve Intl y no yo.
   Como mucho recorre un fin de semana largo: 4 días × 1440 min. */
export function proximoHorarioLaboral(desde: Date): Date {
  const t = new Date(desde.getTime());
  t.setUTCSeconds(0, 0);
  for (let i = 0; i < 6 * 1440; i++) {
    if (enHorarioLaboral(t)) return t;
    t.setUTCMinutes(t.getUTCMinutes() + 1);
  }
  return t;
}
