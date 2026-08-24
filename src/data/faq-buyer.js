/* Las tres preguntas de compra, en un solo lugar: las usa el componente que las
   muestra (FaqBuyer.astro) y también el schema de cada página de servicio, para
   que lo que Google lee y lo que la persona ve digan lo mismo. */
export const FAQ_BUYER = [
  {
    en: { q: 'How does the production actually run, week by week?',
          a: 'Four stages with dates agreed before we start: concept and script (1–2 weeks), pre-production — casting, locations, schedule (1 week), the shoot (1–3 days), then edit, grade and sound with a first cut within two weeks of wrapping. You have one contact person the whole way, and every milestone has a date in writing before the first invoice.' },
    de: { q: 'Wie läuft die Produktion ab — Woche für Woche?',
          a: 'Vier Phasen, deren Termine vor dem Start feststehen: Konzept und Drehbuch (1–2 Wochen), Vorproduktion — Casting, Locations, Disposition (1 Woche), der Dreh (1–3 Tage), danach Schnitt, Farbkorrektur und Ton, mit einem ersten Schnitt innert zwei Wochen nach Drehschluss. Sie haben durchgehend eine Ansprechperson, und jeder Meilenstein hat ein schriftliches Datum, bevor die erste Rechnung kommt.' },
    es: { q: '¿Cómo es el proceso, semana por semana?',
          a: 'Cuatro etapas con fechas acordadas antes de empezar: concepto y guion (1–2 semanas), preproducción — casting, locaciones, plan de rodaje (1 semana), el rodaje (1–3 días), y después montaje, color y sonido, con un primer corte dentro de las dos semanas del final del rodaje. Tenés una sola persona de contacto en todo el camino, y cada hito tiene fecha por escrito antes de la primera factura.' },
  },
  {
    en: { q: 'Who owns the finished film, and for how long?',
          a: 'You do. The film, the footage and the project files are yours, with no expiry and no renewal fee to us. What does carry a term is what we license from third parties: music, stock and — when we cast professional talent — the usage agreed for their appearance, priced by territory and duration under the Swiss SSFV / SzeneSchweiz guidelines. All of that is written into the quote before the shoot, never invoiced afterwards.' },
    de: { q: 'Wem gehören die Nutzungsrechte am fertigen Film?',
          a: 'Ihnen. Der Film, das Rohmaterial und die Projektdateien gehören Ihnen — unbefristet und ohne Verlängerungsgebühr an uns. Befristet ist nur, was wir von Dritten lizenzieren: Musik, Stock und, wenn wir professionelle Darstellerinnen und Darsteller besetzen, deren vereinbarte Nutzung, die nach Gebiet und Dauer gemäss SSFV / SzeneSchweiz kalkuliert wird. Das steht alles vor dem Dreh in der Offerte und wird nie nachträglich verrechnet.' },
    es: { q: '¿De quién son los derechos del film terminado?',
          a: 'Tuyos. El film, el material bruto y los archivos del proyecto son tuyos, sin vencimiento y sin cuota de renovación hacia nosotros. Lo único con plazo es lo que licenciamos de terceros: música, stock y, cuando hay actores profesionales, el uso acordado de su imagen, que se calcula por territorio y duración según las pautas suizas SSFV / SzeneSchweiz. Todo eso va en el presupuesto antes del rodaje, nunca facturado después.' },
  },
  {
    en: { q: 'How many rounds of changes are included?',
          a: 'Two, and they are in the schedule with dates: one on the first cut, one on the near-final version. In practice what decides whether two is enough is not the number — it is whether one named person signs off. Feedback gathered from a committee contradicts itself and turns one edit into three, which is why we ask who the approver is before the shoot, not after the grade.' },
    de: { q: 'Wie viele Korrekturschleifen sind inklusive?',
          a: 'Zwei — und sie stehen mit Datum im Zeitplan: eine auf den ersten Schnitt, eine auf die Fast-Endfassung. Ob zwei reichen, entscheidet in der Praxis nicht die Zahl, sondern ob eine benannte Person freigibt. Feedback, das ein Gremium sammelt, widerspricht sich selbst und macht aus einem Schnitt drei. Deshalb klären wir vor dem Dreh, wer freigibt — nicht nach der Farbkorrektur.' },
    es: { q: '¿Cuántas rondas de correcciones entran?',
          a: 'Dos, y están en el cronograma con fecha: una sobre el primer corte y otra sobre la versión casi final. En la práctica lo que decide si dos alcanzan no es el número, es que apruebe una sola persona con nombre. El feedback juntado por un comité se contradice solo y convierte un montaje en tres — por eso preguntamos quién aprueba antes del rodaje, no después del color.' },
  },
];
