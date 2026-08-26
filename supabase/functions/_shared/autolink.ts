// Links clickeables en los emails que mandamos. UN solo lugar.
//
// Sebastián, 26 ago 2026: "siempre que uses links en ese chat — que sean clickables.
// sino nadie lo hace". Tenía razón: un link que hay que copiar y pegar no lo usa nadie,
// y el botón de reservar suele ser justo la acción que el email pide.
//
// Vivía copiado en cuatro funciones, y por eso el arreglo llegó a tres: send-outreach
// —la que manda los emails que él escribe a mano desde la ficha— se quedó con la versión
// vieja, que solo enlazaba "https://…". Un "viven.ch/book/" pelado le salía como texto
// muerto (lo reportó de nuevo el 26 ago). Ahora hay una sola implementación y quien la
// arregle la arregla para todas.
//
// Agarra dominios pelados (viven.ch/book/), www., https:// y direcciones de email
// (que van a mailto:). Deja en paz "8.1%" y "CHF 1.234,50" — probado.

const TLD_LINK = "ch|com|org|net|io|de|es|fr|it|at|li|co|ai|app|dev|me|swiss|eu";

export const RE_LINK = new RegExp(
  "([a-z0-9._%+-]+@[a-z0-9.-]+\\.[a-z]{2,}" +
  "|https?:\\/\\/[^\\s<>()]+" +
  "|www\\.[^\\s<>()]+" +
  "|(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)+(?:" + TLD_LINK + ")(?:\\/[^\\s<>()]*)?)", "gi");

export function autolink(txt: string, color = "#5b7cfa"): string {
  return txt.replace(RE_LINK, (m: string) => {
    let cola = "";
    const fin = m.match(/[.,;:!?]+$/);
    if (fin) { cola = fin[0]; m = m.slice(0, -cola.length); }
    const href = /^[a-z0-9._%+-]+@/i.test(m) ? "mailto:" + m
      : (/^https?:\/\//i.test(m) ? m : "https://" + m);
    return `<a href="${href}" style="color:${color}">${m}</a>` + cola;
  });
}
