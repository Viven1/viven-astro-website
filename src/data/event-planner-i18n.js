/* Textos del planificador de video de evento, en los tres idiomas.
 *
 * Vive acá y no dentro de cada página porque el planner es UNA herramienta: si las
 * preguntas viven copiadas en tres archivos, la próxima pregunta que se agregue va a
 * entrar en uno y faltar en dos, y nadie lo va a notar hasta que un cliente alemán
 * conteste ocho preguntas donde el inglés tiene nueve.
 *
 * Las CLAVES de las respuestas (data-v) son las mismas en los tres idiomas: es lo que
 * hace que el brief que llega al dashboard se pueda leer sin importar en qué idioma lo
 * contestaron.
 */

export const PLANNER_URLS = {
  en: '/en/event-video-planner/',
  de: '/de/eventvideo-planer/',
  es: '/es/planificador-video-evento/',
};

export const PLANNER = {
  en: {
    slug: 'event-video-planner',
    title: 'Event Video Planner — plan your event film | Viven',
    description: 'Nine questions that decide whether your event film works: how many pieces, video booth, live stream, audio and light. We email you the brief, ready to forward.',
    eyebrow: 'Free tool',
    h1: 'Planning the video for your event?',
    lead: 'The film is decided before the day, not on it. Nine questions, two minutes — and we email you the brief, ready to forward to your team or another agency.',
    multi: 'pick as many as apply',
    q: [
      { n: '1. How many pieces do you need?', g: 'pieces', o: [
        ['one', '🎬 One recap film'], ['cuts', '✂️ Recap + short cuts'],
        ['series', '📚 A series'], ['unsure', '🤔 Not sure yet'] ] },
      { n: '2. How long do you want to keep posting from this event?', g: 'window', o: [
        ['days', 'A few days'], ['weeks', 'A few weeks'], ['months', 'Months — I want a content bank'] ] },
      { n: '3. The talks — whole or split?', g: 'talks', o: [
        ['full', 'One full recording'], ['speaker', 'Split by speaker'],
        ['both', 'Both'], ['none', 'No talks to record'] ] },
      { n: '4. Should the audience take part?', g: 'audience', multi: true, o: [
        ['qa', '🙋 Q&A from the floor'], ['poll', '📊 Live polls on screen'], ['watch', 'Audience just watches'] ] },
      { n: '5. A video booth?', g: 'booth', tip: 'tip-booth', o: [
        ['yes', '🎤 Yes — collect testimonials'], ['maybe', 'Tell me more'], ['no', 'Not this time'] ],
        tipHtml: '<b>The people who were there give the best testimonials</b> — and they give them on the day, while it is still fresh. A booth captures in one afternoon what takes weeks to chase afterwards.<br><br>It only works if it is planned: it needs its own corner, its own light, its own microphone and the questions written in advance. Thirty to sixty seconds per answer, three or four prompts to choose from.' },
      { n: "6. Live stream for those who can't come?", g: 'stream', tip: 'tip-stream', o: [
        ['yes', '📡 Yes'], ['record', 'No — recording is enough'], ['unsure', 'Not decided'] ],
        tipHtml: "A live stream changes the crew, the connectivity and the budget. It is not a decision you can add the week before — the venue's internet has to be tested in advance." },
      { n: '7. Audio — the one that decides everything', g: 'audio', tip: 'tip-audio', o: [
        ['desk', "Take the venue's sound desk"], ['own', 'Bring your own microphones'], ['unsure', "I don't know what the venue has"] ],
        tipHtml: "A weak shot can be saved in the edit. Bad audio cannot. If nobody has confirmed what the venue's desk actually outputs, we plan for our own microphones and treat the desk feed as a backup." },
      { n: '8. Light', g: 'light', o: [
        ['venue', 'The venue lights the stage'], ['own', 'We need to bring light'], ['unsure', 'Not sure'] ] },
      { n: '9. Do you want an offer for this?', g: 'offer', o: [
        ['yes', '✅ Yes — send me an offer'], ['budget', '💰 I need a number for internal budget'], ['later', 'Not yet — still planning'] ] },
    ],
    always: "<b>One thing we will say before you ask for a price: use two cameras.</b> One person cannot cover the stage and the room's reaction at the same time, and what gets missed is gone — the event does not happen twice. The second camera costs little next to what it saves.",
    formH2: 'Get your brief',
    phName: 'Name', phEmail: 'Work email', phDate: 'Event date, if you have one',
    submit: 'Email me my brief →',
    formNote: 'We send the brief to your inbox so you can forward it to your team or another agency. We reply within one business day. No spam, ever.',
    resultH2: 'Your event brief',
    sending: '📨 Sending it to your inbox…',
    sent: '📨 Sent to {email} — forward it to whoever else needs it.',
    sendFail: 'We could not email it, but your brief is above — copy it from here.',
    labels: { pieces: 'Pieces needed', window: 'Publishing window', talks: 'Talks', audience: 'Audience',
              booth: 'Video booth', stream: 'Live stream', audio: 'Audio', light: 'Light', offer: 'Offer', date: 'Event date' },
    ctaBookGo: '📅 Book 15 min and we go through it',
    ctaBook: '📅 Book a 15-min call',
    ctaAsk: 'Actually, send me an offer →',
    asking: 'Sending…',
    asked: '✅ Sent to our team — they will come back with an offer or questions.',
    askFail: 'That did not go through. Write to info@viven.ch and we pick it up from there.',
    onIt: 'We are on it — you get the offer within one business day.',
    none: 'No answers selected.',
  },

  de: {
    slug: 'eventvideo-planer',
    title: 'Eventvideo-Planer — planen Sie Ihren Eventfilm | Viven',
    description: 'Neun Fragen, die entscheiden, ob Ihr Eventfilm funktioniert: Anzahl Formate, Video-Booth, Livestream, Ton und Licht. Das Briefing kommt per Mail, bereit zum Weiterleiten.',
    eyebrow: 'Kostenloses Tool',
    h1: 'Planen Sie das Video für Ihren Event?',
    lead: 'Der Film wird vor dem Tag entschieden, nicht an ihm. Neun Fragen, zwei Minuten — und das Briefing kommt per Mail, bereit zum Weiterleiten an Ihr Team oder eine andere Agentur.',
    multi: 'Mehrfachauswahl möglich',
    q: [
      { n: '1. Wie viele Formate brauchen Sie?', g: 'pieces', o: [
        ['one', '🎬 Ein Recap-Film'], ['cuts', '✂️ Recap + kurze Cuts'],
        ['series', '📚 Eine Serie'], ['unsure', '🤔 Noch unklar'] ] },
      { n: '2. Wie lange wollen Sie aus diesem Event posten?', g: 'window', o: [
        ['days', 'Ein paar Tage'], ['weeks', 'Ein paar Wochen'], ['months', 'Monate — ich will einen Content-Vorrat'] ] },
      { n: '3. Die Referate — ganz oder aufgeteilt?', g: 'talks', o: [
        ['full', 'Eine vollständige Aufzeichnung'], ['speaker', 'Nach Referent aufgeteilt'],
        ['both', 'Beides'], ['none', 'Keine Referate aufzuzeichnen'] ] },
      { n: '4. Soll das Publikum mitmachen?', g: 'audience', multi: true, o: [
        ['qa', '🙋 Q&A aus dem Saal'], ['poll', '📊 Live-Umfragen auf der Leinwand'], ['watch', 'Publikum schaut nur zu'] ] },
      { n: '5. Ein Video-Booth?', g: 'booth', tip: 'tip-booth', o: [
        ['yes', '🎤 Ja — Testimonials sammeln'], ['maybe', 'Erzählen Sie mir mehr'], ['no', 'Diesmal nicht'] ],
        tipHtml: '<b>Die besten Testimonials geben die, die dabei waren</b> — und sie geben sie am selben Tag, solange es frisch ist. Ein Booth sammelt an einem Nachmittag, was man sonst wochenlang hinterherjagt.<br><br>Es funktioniert nur geplant: eigene Ecke, eigenes Licht, eigenes Mikrofon und die Fragen im Voraus geschrieben. Dreissig bis sechzig Sekunden pro Antwort, drei oder vier Fragen zur Auswahl.' },
      { n: '6. Livestream für alle, die nicht kommen können?', g: 'stream', tip: 'tip-stream', o: [
        ['yes', '📡 Ja'], ['record', 'Nein — die Aufzeichnung reicht'], ['unsure', 'Noch nicht entschieden'] ],
        tipHtml: 'Ein Livestream verändert Crew, Konnektivität und Budget. Das lässt sich nicht eine Woche vorher dazunehmen — das Internet der Location muss vorher getestet werden.' },
      { n: '7. Ton — der entscheidet alles', g: 'audio', tip: 'tip-audio', o: [
        ['desk', 'Das Mischpult der Location nehmen'], ['own', 'Eigene Mikrofone mitbringen'], ['unsure', 'Ich weiss nicht, was die Location hat'] ],
        tipHtml: 'Eine schwache Einstellung rettet der Schnitt. Schlechten Ton nicht. Solange niemand bestätigt hat, was das Pult der Location tatsächlich ausgibt, planen wir eigene Mikrofone und nehmen den Pult-Feed als Backup.' },
      { n: '8. Licht', g: 'light', o: [
        ['venue', 'Die Location leuchtet die Bühne aus'], ['own', 'Wir müssen Licht mitbringen'], ['unsure', 'Nicht sicher'] ] },
      { n: '9. Möchten Sie eine Offerte dafür?', g: 'offer', o: [
        ['yes', '✅ Ja — schicken Sie mir eine Offerte'], ['budget', '💰 Ich brauche eine Zahl fürs interne Budget'], ['later', 'Noch nicht — ich plane erst'] ] },
    ],
    always: '<b>Eines sagen wir, bevor Sie nach dem Preis fragen: nehmen Sie zwei Kameras.</b> Eine Person kann nicht gleichzeitig die Bühne und die Reaktion im Saal abdecken, und was verpasst wird, ist weg — der Event findet kein zweites Mal statt. Die zweite Kamera kostet wenig gegenüber dem, was sie rettet.',
    formH2: 'Ihr Briefing erhalten',
    phName: 'Name', phEmail: 'Geschäftliche E-Mail', phDate: 'Eventdatum, falls schon bekannt',
    submit: 'Briefing per Mail schicken →',
    formNote: 'Wir schicken das Briefing in Ihr Postfach, damit Sie es an Ihr Team oder eine andere Agentur weiterleiten können. Wir antworten innerhalb eines Arbeitstags. Kein Spam, nie.',
    resultH2: 'Ihr Event-Briefing',
    sending: '📨 Wird an Ihr Postfach geschickt…',
    sent: '📨 An {email} geschickt — leiten Sie es an alle weiter, die es brauchen.',
    sendFail: 'Der Versand hat nicht geklappt, aber Ihr Briefing steht oben — kopieren Sie es von hier.',
    labels: { pieces: 'Formate', window: 'Publikationszeitraum', talks: 'Referate', audience: 'Publikum',
              booth: 'Video-Booth', stream: 'Livestream', audio: 'Ton', light: 'Licht', offer: 'Offerte', date: 'Eventdatum' },
    ctaBookGo: '📅 15 Minuten buchen und wir gehen es durch',
    ctaBook: '📅 15-Minuten-Call buchen',
    ctaAsk: 'Doch — schicken Sie mir eine Offerte →',
    asking: 'Wird gesendet…',
    asked: '✅ An unser Team geschickt — wir melden uns mit einer Offerte oder Rückfragen.',
    askFail: 'Das hat nicht geklappt. Schreiben Sie an info@viven.ch, wir nehmen es von dort auf.',
    onIt: 'Wir sind dran — die Offerte kommt innerhalb eines Arbeitstags.',
    none: 'Keine Antworten ausgewählt.',
  },

  es: {
    slug: 'planificador-video-evento',
    title: 'Planificador de video de evento — planeá tu film | Viven',
    description: 'Nueve preguntas que deciden si el video de tu evento funciona: cuántas piezas, video booth, streaming, audio y luz. El brief te llega por email, listo para reenviar.',
    eyebrow: 'Herramienta gratis',
    h1: '¿Estás planeando el video de tu evento?',
    lead: 'El film se decide antes del día, no en el día. Nueve preguntas, dos minutos — y el brief te llega por email, listo para reenviar a tu equipo o a otra agencia.',
    multi: 'podés elegir varias',
    q: [
      { n: '1. ¿Cuántas piezas necesitás?', g: 'pieces', o: [
        ['one', '🎬 Un recap'], ['cuts', '✂️ Recap + cortes cortos'],
        ['series', '📚 Una serie'], ['unsure', '🤔 Todavía no sé'] ] },
      { n: '2. ¿Cuánto tiempo querés seguir publicando de este evento?', g: 'window', o: [
        ['days', 'Unos días'], ['weeks', 'Unas semanas'], ['months', 'Meses — quiero un banco de contenido'] ] },
      { n: '3. Las charlas, ¿enteras o partidas?', g: 'talks', o: [
        ['full', 'Una grabación completa'], ['speaker', 'Partidas por orador'],
        ['both', 'Las dos'], ['none', 'No hay charlas para grabar'] ] },
      { n: '4. ¿El público participa?', g: 'audience', multi: true, o: [
        ['qa', '🙋 Preguntas desde la sala'], ['poll', '📊 Encuestas en vivo en pantalla'], ['watch', 'El público solo mira'] ] },
      { n: '5. ¿Video booth?', g: 'booth', tip: 'tip-booth', o: [
        ['yes', '🎤 Sí — juntar testimonios'], ['maybe', 'Contame más'], ['no', 'Esta vez no'] ],
        tipHtml: '<b>Los mejores testimonios los da el que estuvo ahí</b> — y los da ese mismo día, mientras está fresco. Un booth junta en una tarde lo que después se persigue durante semanas.<br><br>Solo funciona si está planeado: su rincón, su luz, su micrófono y las preguntas escritas de antemano. Treinta a sesenta segundos por respuesta, tres o cuatro preguntas para elegir.' },
      { n: '6. ¿Streaming para los que no pueden ir?', g: 'stream', tip: 'tip-stream', o: [
        ['yes', '📡 Sí'], ['record', 'No — con la grabación alcanza'], ['unsure', 'Sin decidir'] ],
        tipHtml: 'Un streaming cambia el equipo, la conectividad y el presupuesto. No es una decisión que se agregue la semana anterior: el internet del lugar hay que probarlo antes.' },
      { n: '7. Audio — el que decide todo', g: 'audio', tip: 'tip-audio', o: [
        ['desk', 'Tomar la consola del lugar'], ['own', 'Llevar nuestros micrófonos'], ['unsure', 'No sé qué tiene el lugar'] ],
        tipHtml: 'Un plano flojo se salva en el montaje. El audio malo no. Si nadie confirmó qué saca de verdad la consola del lugar, planeamos con micrófonos propios y la consola queda de respaldo.' },
      { n: '8. Luz', g: 'light', o: [
        ['venue', 'El lugar ilumina el escenario'], ['own', 'Hay que llevar luz'], ['unsure', 'No sé'] ] },
      { n: '9. ¿Querés una oferta para esto?', g: 'offer', o: [
        ['yes', '✅ Sí — mandenmé una oferta'], ['budget', '💰 Necesito un número para presupuesto interno'], ['later', 'Todavía no — estoy planeando'] ] },
    ],
    always: '<b>Una cosa te la decimos antes de que preguntes el precio: usá dos cámaras.</b> Una sola persona no puede cubrir el escenario y la reacción de la sala al mismo tiempo, y lo que se pierde se perdió — el evento no pasa dos veces. La segunda cámara cuesta poco al lado de lo que salva.',
    formH2: 'Recibí tu brief',
    phName: 'Nombre', phEmail: 'Email de trabajo', phDate: 'Fecha del evento, si ya la tenés',
    submit: 'Mandame el brief por email →',
    formNote: 'Te mandamos el brief a tu bandeja para que se lo reenvíes a tu equipo o a otra agencia. Contestamos dentro de un día hábil. Nunca spam.',
    resultH2: 'Tu brief del evento',
    sending: '📨 Yendo a tu bandeja…',
    sent: '📨 Enviado a {email} — reenviaselo a quien más lo necesite.',
    sendFail: 'No pudimos mandarlo por email, pero tu brief está acá arriba — copialo de acá.',
    labels: { pieces: 'Piezas', window: 'Ventana de publicación', talks: 'Charlas', audience: 'Público',
              booth: 'Video booth', stream: 'Streaming', audio: 'Audio', light: 'Luz', offer: 'Oferta', date: 'Fecha del evento' },
    ctaBookGo: '📅 Reservá 15 min y lo repasamos',
    ctaBook: '📅 Reservar una llamada de 15 min',
    ctaAsk: 'Mejor mandenmé una oferta →',
    asking: 'Enviando…',
    asked: '✅ Enviado a nuestro equipo — te van a volver con una oferta o con preguntas.',
    askFail: 'No salió. Escribinos a info@viven.ch y lo tomamos desde ahí.',
    onIt: 'Estamos en eso — la oferta te llega dentro de un día hábil.',
    none: 'No elegiste ninguna respuesta.',
  },
};
