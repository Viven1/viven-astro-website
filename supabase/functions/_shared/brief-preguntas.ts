// GENERADO por scripts/gen-brief-preguntas.mjs — no editar a mano.
// La fuente es src/data/project-brief-i18n.js; el build falla si esto quedó viejo.

export const BRIEF_SECCIONES = ["historia","publico","mensaje","produccion"] as const;

export const BRIEF_Q: Array<{ k: string; sec: string; q: Record<string, string> }> = [
  {
    "k": "tema",
    "sec": "historia",
    "q": {
      "en": "What main topic do you wish to address in the video?",
      "de": "Welches Hauptthema soll das Video behandeln?",
      "es": "¿Cuál es el tema principal del video?"
    }
  },
  {
    "k": "audiencia",
    "sec": "publico",
    "q": {
      "en": "Who is your intended audience?",
      "de": "Wer ist Ihre Zielgruppe?",
      "es": "¿A quién le habla el video?"
    }
  },
  {
    "k": "idioma",
    "sec": "publico",
    "q": {
      "en": "In which language should the video be?",
      "de": "In welcher Sprache soll das Video sein?",
      "es": "¿En qué idioma va el video?"
    }
  },
  {
    "k": "terminos",
    "sec": "mensaje",
    "q": {
      "en": "Are there terms or concepts the audience needs to learn?",
      "de": "Gibt es Begriffe oder Konzepte, die das Publikum verstehen muss?",
      "es": "¿Hay términos o conceptos que el público tiene que entender?"
    }
  },
  {
    "k": "accion",
    "sec": "mensaje",
    "q": {
      "en": "After watching, what should the audience do?",
      "de": "Was soll das Publikum nach dem Video tun?",
      "es": "Después de verlo, ¿qué querés que haga?"
    }
  },
  {
    "k": "mito",
    "sec": "mensaje",
    "q": {
      "en": "What is a common misconception about your field?",
      "de": "Welches Missverständnis begegnet Ihnen in Ihrem Feld immer wieder?",
      "es": "¿Qué creencia equivocada te encontrás seguido sobre lo tuyo?"
    }
  },
  {
    "k": "joya",
    "sec": "mensaje",
    "q": {
      "en": "Is there something unique or little-known worth sharing?",
      "de": "Gibt es etwas Einzigartiges oder wenig Bekanntes, das erzählt gehört?",
      "es": "¿Hay algo único o poco conocido que valga la pena contar?"
    }
  },
  {
    "k": "desafio",
    "sec": "historia",
    "q": {
      "en": "What part of your work do you find particularly challenging?",
      "de": "Was an Ihrer Arbeit ist besonders herausfordernd?",
      "es": "¿Qué parte de lo que hacen es especialmente difícil?"
    }
  },
  {
    "k": "locaciones",
    "sec": "produccion",
    "q": {
      "en": "Which locations are crucial to show?",
      "de": "Welche Orte müssen unbedingt zu sehen sein?",
      "es": "¿Qué locaciones no pueden faltar?"
    }
  },
  {
    "k": "otros_espacios",
    "sec": "produccion",
    "q": {
      "en": "Are there other spaces we could use?",
      "de": "Gibt es weitere Räume, die wir nutzen könnten?",
      "es": "¿Hay otros espacios que podamos usar?"
    }
  },
  {
    "k": "gente",
    "sec": "produccion",
    "q": {
      "en": "Who would you like to see in the video?",
      "de": "Wen möchten Sie im Video sehen?",
      "es": "¿A quién querés ver en el video?"
    }
  },
  {
    "k": "restricciones",
    "sec": "produccion",
    "q": {
      "en": "Any restrictions or regulations we should know about?",
      "de": "Gibt es Einschränkungen oder Vorgaben, die wir kennen müssen?",
      "es": "¿Hay restricciones o normas que tengamos que saber?"
    }
  }
];

/** La pregunta en el idioma pedido, o la clave si no la encuentra. */
export function preguntaDe(k: string, lang = "es"): string {
  const q = BRIEF_Q.find((b) => b.k === k);
  return (q && (q.q[lang] || q.q.en)) || k;
}

/** Las respuestas en el orden del cuestionario, no en el que las devuelve la base. */
export function enOrden<T extends { key: string }>(filas: T[]): T[] {
  const pos = new Map(BRIEF_Q.map((b, i) => [b.k, i]));
  return filas.slice().sort((a, b) => (pos.get(a.key) ?? 99) - (pos.get(b.key) ?? 99));
}
