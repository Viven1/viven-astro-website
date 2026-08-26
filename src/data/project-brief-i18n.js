/* Las 12 preguntas del Project Brief, en los tres idiomas.
 *
 * Son las que VIVEN ya usa en las llamadas — el cuestionario que Sebastián pasó el
 * 26 ago 2026, con las respuestas reales de Mettler Toledo como referencia de qué
 * profundidad se espera.
 *
 * Las CLAVES son las mismas en los tres idiomas: es lo que hace que el script se
 * genere igual sin importar en qué idioma contestó el cliente, y que un brief alemán
 * y uno inglés se puedan comparar.
 *
 * `op` son respuestas para tocar y `libre` es el texto. Casi todas llevan las dos: la
 * pregunta acota, el texto es donde está lo que sirve. Cinco no tienen `op` a propósito
 * —no hay lista corta que no empobrezca la respuesta.
 */

export const BRIEF_SECCIONES = ['historia', 'publico', 'mensaje', 'produccion'];

export const BRIEF = [
  /* ── 1. La historia ── */
  { k: 'tema', sec: 'historia', esencial: true,
    q: { en: 'What main topic do you wish to address in the video?',
         de: 'Welches Hauptthema soll das Video behandeln?',
         es: '¿Cuál es el tema principal del video?' },
    h: { en: 'What specific aspects of your activity, research or product would you like to emphasize? Identify three to five key points.',
         de: 'Welche Aspekte Ihrer Tätigkeit, Forschung oder Ihres Produkts sollen im Vordergrund stehen? Nennen Sie drei bis fünf Kernpunkte.',
         es: '¿Qué aspectos de tu actividad, investigación o producto querés destacar? Tres a cinco puntos clave.' },
    libre: { en: 'One point per line.', de: 'Ein Punkt pro Zeile.', es: 'Un punto por línea.' } },

  { k: 'audiencia', sec: 'publico', esencial: true,
    q: { en: 'Who is your intended audience?', de: 'Wer ist Ihre Zielgruppe?', es: '¿A quién le habla el video?' },
    h: { en: 'Pick the roles, and tell us where they are.',
         de: 'Wählen Sie die Rollen und sagen Sie uns, wo sie sind.',
         es: 'Elegí los roles y contanos dónde están.' },
    op: { en: ['Production manager', 'Quality manager', 'Service manager', 'R&D', 'Procurement', 'C-level', 'End consumer', 'Candidates'],
          de: ['Produktionsleitung', 'Qualitätsleitung', 'Serviceleitung', 'F&E', 'Einkauf', 'Geschäftsleitung', 'Endkunden', 'Bewerbende'],
          es: ['Producción', 'Calidad', 'Servicio', 'I+D', 'Compras', 'Dirección', 'Consumidor final', 'Candidatos'] },
    multi: true,
    libre: { en: 'Which countries or regions?', de: 'Welche Länder oder Regionen?', es: '¿Qué países o regiones?' } },

  { k: 'idioma', sec: 'publico', esencial: true,
    q: { en: 'In which language should the video be?', de: 'In welcher Sprache soll das Video sein?', es: '¿En qué idioma va el video?' },
    h: { en: 'Should the people on camera speak English, or their native language?',
         de: 'Sollen die Protagonisten Englisch sprechen oder ihre Muttersprache?',
         es: '¿Los protagonistas hablan en inglés o en su idioma?' },
    op: { en: ['English', 'German', 'French', 'Native language + subtitles', 'Several versions'],
          de: ['Englisch', 'Deutsch', 'Französisch', 'Muttersprache + Untertitel', 'Mehrere Versionen'],
          es: ['Inglés', 'Alemán', 'Francés', 'Idioma original + subtítulos', 'Varias versiones'] },
    multi: true },

  { k: 'terminos', sec: 'mensaje',
    q: { en: 'Are there terms or concepts the audience needs to learn?',
         de: 'Gibt es Begriffe oder Konzepte, die das Publikum verstehen muss?',
         es: '¿Hay términos o conceptos que el público tiene que entender?' },
    h: { en: 'So we understand them properly and can explain them well.',
         de: 'Damit wir sie richtig verstehen und gut erklären können.',
         es: 'Para entenderlos bien y poder explicarlos.' },
    libre: { en: 'The term, and what it means in one line.', de: 'Der Begriff, und was er in einer Zeile bedeutet.', es: 'El término, y qué significa en una línea.' } },

  { k: 'accion', sec: 'mensaje', esencial: true,
    q: { en: 'After watching, what should the audience do?',
         de: 'Was soll das Publikum nach dem Video tun?',
         es: 'Después de verlo, ¿qué querés que haga?' },
    h: { en: 'A purchase, an enquiry, a visit — or reassessing something they believe?',
         de: 'Ein Kauf, eine Anfrage, ein Besuch — oder etwas überdenken, das sie glauben?',
         es: '¿Una compra, una consulta, una visita — o repensar algo que creen?' },
    op: { en: ['Buy', 'Get in touch', 'Visit a page', 'Apply', 'Change their mind'],
          de: ['Kaufen', 'Kontakt aufnehmen', 'Eine Seite besuchen', 'Sich bewerben', 'Umdenken'],
          es: ['Comprar', 'Contactarnos', 'Visitar una página', 'Postularse', 'Cambiar de opinión'] },
    multi: true,
    libre: { en: 'Where exactly should they land?', de: 'Wo genau sollen sie landen?', es: '¿Dónde exactamente tienen que llegar?' } },

  { k: 'mito', sec: 'mensaje',
    q: { en: 'What is a common misconception about your field?',
         de: 'Welches Missverständnis begegnet Ihnen in Ihrem Feld immer wieder?',
         es: '¿Qué creencia equivocada te encontrás seguido sobre lo tuyo?' },
    h: { en: 'Engaging with what people already believe gets you closer to them — and lets us take it apart.',
         de: 'Wer beim Bekannten ansetzt, kommt näher ans Publikum — und kann es zerlegen.',
         es: 'Enganchar con lo que ya creen acerca al público, y nos deja desarmarlo.' },
    libre: { en: 'e.g. "we are seen as very expensive…"', de: 'z. B. „wir gelten als sehr teuer…“', es: 'p. ej. "nos ven como muy caros…"' } },

  { k: 'joya', sec: 'mensaje',
    q: { en: 'Is there something unique or little-known worth sharing?',
         de: 'Gibt es etwas Einzigartiges oder wenig Bekanntes, das erzählt gehört?',
         es: '¿Hay algo único o poco conocido que valga la pena contar?' },
    h: { en: 'Your hidden gems.', de: 'Ihre versteckten Perlen.', es: 'Las joyas escondidas.' },
    libre: { en: '', de: '', es: '' } },

  { k: 'desafio', sec: 'historia',
    q: { en: 'What part of your work do you find particularly challenging?',
         de: 'Was an Ihrer Arbeit ist besonders herausfordernd?',
         es: '¿Qué parte de lo que hacen es especialmente difícil?' },
    h: { en: 'Challenges are what make a story. Let us share some.',
         de: 'Herausforderungen machen die Geschichte. Teilen Sie ein paar davon.',
         es: 'Los desafíos son lo que hace una historia. Contanos alguno.' },
    libre: { en: '', de: '', es: '' } },

  /* ── Producción ── */
  { k: 'locaciones', sec: 'produccion', esencial: true,
    q: { en: 'Which locations are crucial to show?',
         de: 'Welche Orte müssen unbedingt zu sehen sein?',
         es: '¿Qué locaciones no pueden faltar?' },
    h: { en: 'For promotion, representation, accuracy — or simply because they are too good to hide.',
         de: 'Aus Werbe-, Repräsentations- oder fachlichen Gründen — oder weil sie zu schön sind, um sie zu verstecken.',
         es: 'Por promoción, por representación, por precisión — o porque son demasiado buenas para esconderlas.' },
    libre: { en: 'And anything that should NOT appear.', de: 'Und alles, was NICHT zu sehen sein soll.', es: 'Y lo que NO tiene que aparecer.' } },

  { k: 'otros_espacios', sec: 'produccion',
    q: { en: 'Are there other spaces we could use?',
         de: 'Gibt es weitere Räume, die wir nutzen könnten?',
         es: '¿Hay otros espacios que podamos usar?' },
    h: { en: 'Places we can get access to, worth keeping in mind while we develop the story. A link or a reference helps.',
         de: 'Orte, zu denen wir Zugang bekommen könnten. Ein Link oder eine Referenz hilft.',
         es: 'Lugares a los que podamos acceder. Un link o una referencia ayuda.' },
    libre: { en: '', de: '', es: '' } },

  { k: 'gente', sec: 'produccion',
    q: { en: 'Who would you like to see in the video?',
         de: 'Wen möchten Sie im Video sehen?',
         es: '¿A quién querés ver en el video?' },
    h: { en: 'Specialists only, or also users? Any names already decided?',
         de: 'Nur Fachleute oder auch Anwender? Stehen schon Namen fest?',
         es: '¿Solo especialistas, o también usuarios? ¿Ya hay nombres decididos?' },
    op: { en: ['Specialists', 'Users / customers', 'Management', 'No requirements'],
          de: ['Fachleute', 'Anwender / Kunden', 'Geschäftsleitung', 'Keine Vorgaben'],
          es: ['Especialistas', 'Usuarios / clientes', 'Dirección', 'Sin requisitos'] },
    multi: true,
    libre: { en: 'Names, if you have them.', de: 'Namen, falls vorhanden.', es: 'Nombres, si los tenés.' } },

  { k: 'restricciones', sec: 'produccion', esencial: true,
    q: { en: 'Any restrictions or regulations we should know about?',
         de: 'Gibt es Einschränkungen oder Vorgaben, die wir kennen müssen?',
         es: '¿Hay restricciones o normas que tengamos que saber?' },
    h: { en: 'Patents, pending publications, privacy, machinery or places we cannot show. Better to know now than on the shooting day.',
         de: 'Patente, laufende Publikationen, Datenschutz, Maschinen oder Orte, die nicht gezeigt werden dürfen. Besser jetzt als am Drehtag.',
         es: 'Patentes, publicaciones en revisión, privacidad, máquinas o lugares que no se pueden mostrar. Mejor saberlo ahora que el día del rodaje.' },
    op: { en: ['No restrictions', 'Patents / confidentiality', 'Privacy / consent', 'Certain areas off-limits', 'Diversity requirements'],
          de: ['Keine Einschränkungen', 'Patente / Vertraulichkeit', 'Datenschutz', 'Bestimmte Bereiche gesperrt', 'Diversity-Vorgaben'],
          es: ['Sin restricciones', 'Patentes / confidencialidad', 'Privacidad', 'Zonas prohibidas', 'Requisitos de diversidad'] },
    multi: true,
    libre: { en: '', de: '', es: '' } },
];

export const BRIEF_T = {
  en: { titulo: 'Project brief', sub: 'The answers that decide what we film. Saved as you type — you can leave and come back.',
        guardado: 'saved automatically', de: 'of', contestadas: 'answered',
        invitar: '✉️ Invite a colleague', invTit: 'Invite a colleague',
        invSub: 'They get their own 6-digit code for this project. Same brief, not a copy — and they can leave feedback on the cut too.',
        invPh: 'name@company.com', invBtn: 'Send invitation', invHecho: 'Invitation sent to',
        yaInv: 'Already invited', listo: 'Brief complete — thank you. We take it from here.',
        falta: 'Still missing', enviar: 'Done — send it to VIVEN', siguiente: 'Next', anterior: 'Back',
        sug: 'From your previous project', sugUsar: 'use this', secciones: {
          historia: 'The story', publico: 'The audience', mensaje: 'The message', produccion: 'Production' } },
  de: { titulo: 'Projekt-Briefing', sub: 'Die Antworten, die bestimmen, was wir drehen. Wird laufend gespeichert — Sie können jederzeit weitermachen.',
        guardado: 'automatisch gespeichert', de: 'von', contestadas: 'beantwortet',
        invitar: '✉️ Kollegin oder Kollegen einladen', invTit: 'Jemanden einladen',
        invSub: 'Sie erhalten einen eigenen 6-stelligen Code für dieses Projekt. Dasselbe Briefing, keine Kopie — und sie können auch den Schnitt kommentieren.',
        invPh: 'name@firma.ch', invBtn: 'Einladung senden', invHecho: 'Einladung gesendet an',
        yaInv: 'Bereits eingeladen', listo: 'Briefing vollständig — danke. Wir übernehmen ab hier.',
        falta: 'Es fehlt noch', enviar: 'Fertig — an VIVEN senden', siguiente: 'Weiter', anterior: 'Zurück',
        sug: 'Aus Ihrem letzten Projekt', sugUsar: 'übernehmen', secciones: {
          historia: 'Die Geschichte', publico: 'Die Zielgruppe', mensaje: 'Die Botschaft', produccion: 'Produktion' } },
  es: { titulo: 'Brief del proyecto', sub: 'Las respuestas que deciden qué filmamos. Se guarda solo — podés dejarlo y volver.',
        guardado: 'se guarda solo', de: 'de', contestadas: 'contestadas',
        invitar: '✉️ Invitar a un colega', invTit: 'Invitar a un colega',
        invSub: 'Recibe su propio código de 6 dígitos para este proyecto. El mismo brief, no una copia — y también puede comentar el corte.',
        invPh: 'nombre@empresa.com', invBtn: 'Enviar invitación', invHecho: 'Invitación enviada a',
        yaInv: 'Ya invitados', listo: 'Brief completo — gracias. Seguimos nosotros.',
        falta: 'Todavía falta', enviar: 'Listo — enviárselo a VIVEN', siguiente: 'Siguiente', anterior: 'Atrás',
        sug: 'De tu proyecto anterior', sugUsar: 'usar esta', secciones: {
          historia: 'La historia', publico: 'El público', mensaje: 'El mensaje', produccion: 'Producción' } },
};
