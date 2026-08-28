/* EN QUÉ IDIOMA LE ESCRIBIMOS A CADA PERSONA.

   La regla, de Sebastián (27 ago 2026): «siempre en el idioma de la persona, sino
   alemán o inglés». El español NUNCA se adivina: solo él y Sofía trabajan en
   castellano, y los dos lo tienen cargado en su ficha. Adivinar español porque es
   el idioma en que está escrito el código le mandó a un técnico suizo la hoja del
   día de rodaje en un idioma que no habla.

   Cuando la ficha no dice nada hay que elegir entre los otros dos, y el dominio del
   email es la única señal que tenemos:

     .ch/.de/.at/.li  → alemán, territorio germanoparlante
     otro dominio     → inglés, que es la lengua franca
     sin email        → alemán: estamos en Zúrich, y sin ninguna señal esa es la apuesta

   El tercer caso importa más de lo que parece. Al 27 ago 2026, seis de los siete técnicos
   no tienen idioma cargado NI email, así que caen todos ahí; mandarlos a inglés porque un
   dominio vacío no termina en .ch sería una respuesta rigurosa y equivocada.
   Es una apuesta, no un dato: se corrige cargando el idioma en la ficha. */

export type Idioma = "es" | "en" | "de";

const TLD_ALEMAN = /\.(ch|de|at|li)$/i;

/** El idioma cargado si es válido; si no, alemán o inglés según el dominio. Nunca español. */
export function idiomaDe(cargado?: unknown, email?: string | null): Idioma {
  const l = String(cargado ?? "").trim().toLowerCase();
  if (l === "es" || l === "en" || l === "de") return l;
  return idiomaPorEmail(email);
}

/** Sin ficha: la apuesta por dominio. Separada porque el importador también la usa. */
export function idiomaPorEmail(email?: string | null): Idioma {
  const dom = String(email ?? "").split("@")[1]?.trim() ?? "";
  if (!dom) return "de";
  return TLD_ALEMAN.test(dom) ? "de" : "en";
}
