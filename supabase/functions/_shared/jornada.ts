// La jornada de rodaje de VIVEN, y lo que cuesta pasarse.
//
// Sebastián, 26 ago 2026: "las reglas de rodaje son: 9 horas de rodaje más una de lunch. Y
// se puede hacer overtime hasta quince horas, pero esas valen más caro: 10-12 horas, esas
// dos valen 25% más de lo normal; 12-14, 50%; 15 arriba, 100% del precio por hora."
//
// ── Por qué vive acá y no adentro de cada prompt ──
// Esta regla decide tres cosas distintas: si un plan de rodaje es realista, cuánto sale una
// jornada que se estira, y qué se le factura al cliente. Escrita tres veces se separa en
// tres, y el día que cambie el convenio va a quedar bien en una sola.
//
// ── El supuesto que hay que tener a la vista ──
// "10-12 esas dos" son las horas 10 y 11. Después dijo "12-14 50%" y "15 arriba 100%", que
// deja la hora 14 sin tramo explícito. Se resuelve hacia ABAJO —14 va al 50%— porque cobrar
// de más sin que nadie lo haya dicho es peor error que cobrar de menos, y porque el salto al
// 100% él lo puso en 15.
// Si el criterio es otro, se cambia acá y cambia en todos lados.

export const JORNADA = {
  /** Horas de trabajo efectivo de una jornada normal. */
  horasNormales: 9,
  /** El almuerzo NO es tiempo de rodaje: la jornada normal ocupa 10 h en el set. */
  horasLunch: 1,
  /** Más de esto no se rueda, por caro que se pague. */
  topeAbsoluto: 15,
  /** Desde qué hora empieza cada recargo, y cuánto. */
  tramos: [
    { desde: 10, hasta: 11, recargo: 0.25 },
    { desde: 12, hasta: 14, recargo: 0.50 },
    { desde: 15, hasta: 99, recargo: 1.00 },
  ],
} as const;

/** El texto que se le pasa a la IA. Una sola redacción para todos los prompts. */
export const REGLA_JORNADA = `LA JORNADA DE RODAJE DE VIVEN (esto manda sobre cualquier otra estimación):
- Una jornada normal son ${JORNADA.horasNormales} horas de rodaje MÁS ${JORNADA.horasLunch} hora de almuerzo. En el set eso es ${JORNADA.horasNormales + JORNADA.horasLunch} horas.
- El almuerzo va SIEMPRE y no es tiempo de rodaje. Un plan sin comida se cae a media tarde.
- Se puede estirar hasta ${JORNADA.topeAbsoluto} horas, nunca más, y cada hora de más cuesta:
  · horas 10 y 11: +25% sobre la hora normal
  · horas 12 a 14: +50%
  · hora 15: +100%
- Si el trabajo no entra en ${JORNADA.horasNormales} horas, la respuesta correcta es DOS JORNADAS, no una jornada larga.
  Estirar es la excepción cara, no el plan. Si igual conviene estirar, decilo con el número:
  cuántas horas de más y qué recargo, para poder decidirlo con la plata a la vista.`;

/** Lo que cuesta una jornada de `horas` a `tarifaHora`, con los recargos aplicados. */
export function costoJornada(horas: number, tarifaHora: number) {
  const h = Math.max(0, Number(horas) || 0);
  const t = Math.max(0, Number(tarifaHora) || 0);
  const normales = Math.min(h, JORNADA.horasNormales);
  let total = normales * t;
  const detalle: Array<{ horas: number; recargo: number; costo: number }> = [];
  for (const tr of JORNADA.tramos) {
    const desde = Math.max(tr.desde, JORNADA.horasNormales + 1);
    const n = Math.max(0, Math.min(h, tr.hasta) - desde + 1);
    if (n <= 0) continue;
    const costo = n * t * (1 + tr.recargo);
    total += costo;
    detalle.push({ horas: n, recargo: tr.recargo, costo });
  }
  return {
    total,
    normales: normales * t,
    extra: total - normales * t,
    detalle,
    /* Pasarse del tope no es un recargo más: es que no se puede. Se dice, no se cobra. */
    pasaElTope: h > JORNADA.topeAbsoluto,
  };
}
