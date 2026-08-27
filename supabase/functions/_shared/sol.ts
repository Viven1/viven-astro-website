// Amanecer y atardecer de una posición y una fecha.
//
// Se calcula, no se pide a ningún servicio: es el algoritmo de la NOAA, determinista, y
// evita depender de una API que puede estar caída justo la noche anterior al rodaje. Un
// pronóstico puede fallar; la posición del sol, no.
//
// Devuelve horas LOCALES del huso que se le pase (Suiza: 1 en invierno, 2 en verano).
// Si el sol no sale o no se pone ese día —no pasa en Zúrich, pero sí arriba del círculo
// polar— devuelve null, y quien lo muestre dice que no hay dato. Nunca 00:00.

const rad = Math.PI / 180;

/** Offset horario de Suiza para esa fecha: CET (+1) o CEST (+2). */
export function husoSuizo(fecha: Date): number {
  /* El horario de verano europeo va del último domingo de marzo al último de octubre, a
     la 01:00 UTC. Se calcula en vez de hardcodear el año, que es como se rompen estas
     cosas en enero. */
  const y = fecha.getUTCFullYear();
  const ultimoDomingo = (mes: number) => {
    const d = new Date(Date.UTC(y, mes + 1, 0));       // último día del mes
    d.setUTCDate(d.getUTCDate() - d.getUTCDay());       // hacia atrás hasta el domingo
    d.setUTCHours(1, 0, 0, 0);
    return d;
  };
  return fecha >= ultimoDomingo(2) && fecha < ultimoDomingo(9) ? 2 : 1;
}

function diaJuliano(f: Date): number {
  return f.getTime() / 86400000 + 2440587.5;
}

/** `{ amanece, atardece }` en "HH:MM" locales, o null cada uno si ese día no ocurre. */
export function solEn(lat: number, lon: number, fechaISO: string, huso?: number) {
  const f = new Date(fechaISO + "T12:00:00Z");
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || isNaN(f.getTime())) {
    return { amanece: null, atardece: null };
  }
  const tz = huso ?? husoSuizo(f);
  const n = Math.round(diaJuliano(f) - 2451545.0 + 0.0008);
  const jNoon = n - lon / 360 + 2451545.0 + 0.0009;
  const M = (357.5291 + 0.98560028 * (jNoon - 2451545)) % 360;
  const C = 1.9148 * Math.sin(M * rad) + 0.02 * Math.sin(2 * M * rad) + 0.0003 * Math.sin(3 * M * rad);
  const L = (M + C + 180 + 102.9372) % 360;
  const jTransit = jNoon + 0.0053 * Math.sin(M * rad) - 0.0069 * Math.sin(2 * L * rad);
  const decl = Math.asin(Math.sin(L * rad) * Math.sin(23.44 * rad));

  /* -0.833° incluye la refracción atmosférica y el radio del disco solar: es el amanecer
     que ve una persona, no el centro geométrico del sol. */
  const cosOmega = (Math.sin(-0.833 * rad) - Math.sin(lat * rad) * Math.sin(decl)) /
                   (Math.cos(lat * rad) * Math.cos(decl));
  if (cosOmega > 1 || cosOmega < -1) return { amanece: null, atardece: null };
  const omega = Math.acos(cosOmega) / rad;

  const hhmm = (jd: number) => {
    const ms = (jd - 2440587.5) * 86400000;
    const d = new Date(ms + tz * 3600000);
    return String(d.getUTCHours()).padStart(2, "0") + ":" + String(d.getUTCMinutes()).padStart(2, "0");
  };
  return { amanece: hhmm(jTransit - omega / 360), atardece: hhmm(jTransit + omega / 360) };
}
