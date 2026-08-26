// La plantilla de los emails de VIVEN. Una sola.
//
// Sebastián, 26 ago 2026: "el texto está malo, parece spam de vuelta. Siempre con botón y
// abajo el link por si el botón no funciona. Importante la presencia que damos: el branding
// tiene que ser consistente."
//
// ── Por qué vive acá y no adentro de cada función ──
// El email del código del portal quedó bien y el del brief salía como texto pelado con una
// URL de noventa caracteres. Mismo remitente, misma semana, dos marcas distintas — y el
// cliente no ve "dos funciones", ve a VIVEN mandando algo que parece phishing. Cada vez que
// se arregle uno solo, el siguiente vuelve a divergir. Por eso el layout está una vez.
//
// ── Las tres reglas del formato ──
// 1. SIEMPRE botón, y SIEMPRE el link en texto abajo. Muchos clientes de correo empresarial
//    matan los botones o reescriben los href; sin el link plano, ese email no lleva a
//    ningún lado y no hay forma de que el cliente se dé cuenta.
// 2. Se dice QUÉ es antes de pedir nada. Un link suelto con un token de 40 caracteres es
//    exactamente lo que manda el que estafa.
// 3. Se dice POR QUÉ lo recibe. Es lo que separa un email de trabajo de uno frío.
//
// Nada de imágenes salvo el logo: los clientes de correo las bloquean por defecto y un
// email que sin imágenes queda vacío es un email que no se lee.

export type EmailLang = "en" | "de" | "es";

const PIE: Record<EmailLang, { porque: string; link: string }> = {
  en: { porque: "You are receiving this because we are working together on this project.",
        link: "If the button does not work, copy this address:" },
  de: { porque: "Sie erhalten diese E-Mail, weil wir gemeinsam an diesem Projekt arbeiten.",
        link: "Falls der Button nicht funktioniert, kopieren Sie diese Adresse:" },
  es: { porque: "Recibís este email porque estamos trabajando juntos en este proyecto.",
        link: "Si el botón no anda, copiá esta dirección:" },
};

export const escE = (s: unknown) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

export interface EmailViven {
  lang?: EmailLang;
  saludo?: string;          // "Hola Kaan," — ya armado
  titulo?: string;          // el nombre del proyecto, grande
  intro?: string;           // qué es esto, en una o dos frases
  /** Bloques libres de HTML entre la intro y el botón (una ficha, una lista de notas…). */
  cuerpo?: string;
  cta?: { texto: string; url: string };
  /** Debajo del botón, en gris. Para el "por qué pedimos un código". */
  pie?: string;
  /** Sobrescribe la línea de "por qué recibís esto". */
  porque?: string;
}

export function emailViven(o: EmailViven): string {
  const L = PIE[o.lang ?? "es"] ?? PIE.es;
  const cta = o.cta;
  /* El <meta charset> NO es decorativo: sin él, "Quién" llega como "QuiÃ©n" en varios
     clientes de correo. Se vio en el preview del brief antes de mandarlo — un email lleno
     de caracteres rotos parece spam por sí solo, sin importar el diseño.
     El preheader es la línea que se lee en la bandeja al lado del asunto: sin uno, el
     cliente muestra el principio del HTML o "Ver en el navegador". Va oculto. */
  const pre = (o.intro ?? o.titulo ?? "").replace(/<[^>]+>/g, "").slice(0, 140);
  return `<!doctype html><html lang="${o.lang ?? "es"}"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="color-scheme" content="light only" /><meta name="supported-color-schemes" content="light only" />
</head><body style="margin:0;background:#f4f5f7;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0">${escE(pre)}</div>
  <div style="max-width:560px;margin:0 auto;padding:28px 16px">
    <div style="background:#0f1826;border-radius:14px 14px 0 0;padding:20px 28px">
      <img src="https://www.viven.ch/assets/brand/viven-logo-email.png" alt="VIVEN" height="24" style="height:24px;width:auto;display:block" />
    </div>
    <div style="background:#ffffff;border-radius:0 0 14px 14px;padding:30px 28px">
      ${o.saludo ? `<p style="margin:0 0 14px;font-size:15px;color:#1a2230">${o.saludo}</p>` : ""}
      ${o.titulo ? `<p style="margin:0 0 8px;font-size:19px;font-weight:700;color:#1a2230;line-height:1.3">${o.titulo}</p>` : ""}
      ${o.intro ? `<p style="margin:0 0 24px;font-size:15px;line-height:1.65;color:#3d4757">${o.intro}</p>` : ""}
      ${o.cuerpo ?? ""}
      ${cta ? `<p style="margin:22px 0 18px"><a href="${cta.url}" style="background:#0f1826;color:#ddf98f;text-decoration:none;font-weight:700;font-size:15px;padding:13px 26px;border-radius:100px;display:inline-block">${escE(cta.texto)} →</a></p>
      <p style="margin:0;font-size:12px;color:#9aa6bd;line-height:1.6;word-break:break-all">${L.link}<br /><a href="${cta.url}" style="color:#8a94a8">${cta.url}</a></p>` : ""}
      ${o.pie ? `<p style="margin:22px 0 0;padding-top:18px;border-top:1px solid #e9ecf1;font-size:13px;color:#8a94a8;line-height:1.6">${o.pie}</p>` : ""}
    </div>
    <p style="text-align:center;font-size:11.5px;color:#9aa;margin:16px 0 0;line-height:1.6">
      VIVEN AG · Zürich · <a href="https://www.viven.ch" style="color:#9aa">viven.ch</a><br />${o.porque ?? L.porque}
    </p>
  </div></body></html>`;
}

/* ── La variante CARTA ──
   Un email de venta uno a uno NO lleva el header oscuro con el logo grande: eso lo
   convierte en un flyer, y un flyer no se contesta. Lo que sí lleva es una firma con
   nombre, cargo y el logo chico — que es lo que hace que se vea de VIVEN sin gritar.
   Misma tipografía, mismo azul de los links, mismo pie. Consistente no quiere decir
   idéntico: quiere decir que se reconoce.

   `texto` ya viene como HTML (con <br> y links). */
export function cartaViven(o: {
  texto: string;
  firma?: { nombre?: string; cargo?: string; tel?: string };
  lang?: EmailLang;
}): string {
  const f = o.firma ?? {};
  return `<!doctype html><html lang="${o.lang ?? "es"}"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="color-scheme" content="light only" /><meta name="supported-color-schemes" content="light only" />
</head><body style="margin:0;background:#ffffff;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
  <div style="max-width:560px;margin:0 auto;padding:26px 20px 34px;font-size:15px;line-height:1.65;color:#1a2230">
    ${o.texto}
    <table style="border-collapse:collapse;margin:26px 0 0;padding-top:18px;border-top:1px solid #e9ecf1;width:100%"><tr>
      <!-- El logo de correo es blanco (está hecho para el header oscuro) y no hay versión
           oscura en PNG. El SVG navy existe, pero Gmail no muestra SVG. Así que va sobre
           su propio fondo: un asset que ya sabemos que llega, en vez de uno nuevo que
           quizás no se vea. -->
      <td style="vertical-align:middle;padding:0 14px 0 0">
        <table style="border-collapse:collapse"><tr><td style="background:#0f1826;border-radius:6px;padding:7px 10px">
          <img src="https://www.viven.ch/assets/brand/viven-logo-email.png" alt="VIVEN" height="15" style="height:15px;width:auto;display:block" />
        </td></tr></table>
      </td>
      <td style="vertical-align:middle;font-size:12.5px;color:#8a94a8;line-height:1.55">
        ${f.nombre ? `<b style="color:#1a2230">${escE(f.nombre)}</b>${f.cargo ? " · " + escE(f.cargo) : ""}<br />` : ""}
        VIVEN AG · Zürich · <a href="https://www.viven.ch" style="color:#8a94a8">viven.ch</a>${f.tel ? " · " + escE(f.tel) : ""}
      </td>
    </tr></table>
  </div></body></html>`;
}

/** Una ficha de datos (Proyecto, Cliente, Entrega…). Las filas vacías no se dibujan. */
export function fichaEmail(filas: Array<[string, string | null | undefined]>): string {
  const ok = filas.filter(([, v]) => String(v ?? "").trim());
  if (!ok.length) return "";
  return `<table style="border-collapse:collapse;margin:0 0 22px;width:100%">${ok.map(([k, v]) => `
    <tr><td style="padding:4px 14px 4px 0;color:#8a94a8;font-size:12.5px;white-space:nowrap;vertical-align:top">${escE(k)}</td>
        <td style="padding:4px 0;font-size:13.5px;color:#1a2230">${v}</td></tr>`).join("")}</table>`;
}
