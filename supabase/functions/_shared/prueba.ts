// ¿Este email es una prueba nuestra?
//
// UNA definición, y tiene que ser la MISMA que la de la base (public.email_es_prueba,
// migración 0162). Vivía copiada en cinco funciones y en ninguna estaba
// cepeda.sebastian@gmail.com: o sea que una prueba con esa dirección quedaba marcada
// como prueba en el dashboard pero los robots la trataban como un lead real —
// inscribiéndola en workflows, mandándole emails automáticos y contándola como
// conversión en Google Ads.
//
// (Sebastián, 26 ago 2026: "todos los tests que hago con sebastian@viven.ch y
// cepeda.sebastian@gmail.com no pueden contar como leads, o me falsifica todos los
// datos.")
//
// Si se suma una dirección nueva, va acá Y en la función SQL. Las dos, o vuelve el
// desfase.

const DIRECCIONES = new Set(["cepeda.sebastian@gmail.com"]);
const PATRONES = /@viven\.ch$|@entropia|@example\.|^test@|@test\./i;

export function esPrueba(email: unknown): boolean {
  const e = String(email ?? "").trim().toLowerCase();
  if (!e) return false;
  return DIRECCIONES.has(e) || PATRONES.test(e);
}

/* Para los `filter(...)` que ya existían con la forma TEST.test(x): mismo uso, misma
   respuesta, una sola fuente. */
export const TEST = { test: (e: unknown) => esPrueba(e) };
