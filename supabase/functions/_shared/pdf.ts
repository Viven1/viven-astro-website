// HTML → PDF con Cloudflare Browser Rendering.
//
// Por qué esto y no dibujarlo a mano: el plan de rodaje ya tiene un diseño hecho para
// papel —@page con márgenes, pie con numeración, la tipografía de VIVEN— y ese HTML es el
// que ve Sebastián al imprimir. Dibujar un segundo PDF con pdf-lib habría dado un papel
// más feo que el que ya existe, y dos diseños que se separan con el tiempo.
// (Sebastián, 26 ago 2026: "pero como el mockup ese es feo", sobre esa idea; y "que el
//  plan tmb vaya como pdf".)
//
// Secrets: CF_ACCOUNT_ID y CF_API_TOKEN (permiso Browser Rendering).
// Sin ellos devuelve null y el email sale igual, sin adjunto: que falte el PDF no puede
// ser motivo para que el equipo no reciba el plan a las seis de la mañana.

const CF_ACCOUNT = Deno.env.get("CF_ACCOUNT_ID") ?? "";
const CF_TOKEN = Deno.env.get("CF_API_TOKEN") ?? "";

export function pdfConfigurado(): boolean {
  return !!(CF_ACCOUNT && CF_TOKEN);
}

export interface PdfOpts {
  /** Márgenes de página. Los del HTML (@page) mandan cuando existen. */
  margen?: { top?: string; bottom?: string; left?: string; right?: string };
  /** Segundos máximos de espera. Un plan largo tarda; más de 30 s no lo espera nadie. */
  timeoutSeg?: number;
}

/** El PDF en base64, listo para adjuntar en Resend. `null` si no se pudo. */
export async function htmlAPdf(html: string, o: PdfOpts = {}): Promise<string | null> {
  if (!pdfConfigurado()) {
    console.log("PDF_SIN_CONFIGURAR: falta CF_ACCOUNT_ID o CF_API_TOKEN");
    return null;
  }
  const ctrl = new AbortController();
  const reloj = setTimeout(() => ctrl.abort(), (o.timeoutSeg ?? 30) * 1000);
  try {
    const r = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/browser-rendering/pdf`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${CF_TOKEN}`, "Content-Type": "application/json" },
        signal: ctrl.signal,
        body: JSON.stringify({
          html,
          /* Sin esto la API devuelve 6002 "Promise timed out" con nuestro propio HTML: se
             queda esperando la fuente de Google Fonts y el logo. Medido, no leído — el
             plan real fallaba entero hasta que se acotó la espera.
             La hoja se ve igual: si la fuente no llegó a tiempo cae al fallback, que es
             Helvetica, y el resto del diseño no depende de recursos externos. */
          gotoOptions: { waitUntil: "domcontentloaded", timeout: 15000 },
          /* En minúscula: la API rechaza "A4" con un 400 y el mensaje solo lista las
             minúsculas. Se descubrió probándolo, no leyéndolo. */
          pdfOptions: {
            format: "a4",
            printBackground: true,
            margin: o.margen ?? { top: "0mm", bottom: "0mm", left: "0mm", right: "0mm" },
          },
        }),
      },
    );
    if (!r.ok) {
      console.error("PDF_ERROR", r.status, (await r.text()).slice(0, 300));
      return null;
    }
    const buf = new Uint8Array(await r.arrayBuffer());
    /* En tandas: btoa(String.fromCharCode(...buf)) revienta la pila con un PDF de varias
       páginas —el plan de prueba pesa 300 KB— y el error sale como "Maximum call stack
       size exceeded", que no se parece en nada a la causa. */
    let bin = "";
    for (let i = 0; i < buf.length; i += 8192) {
      bin += String.fromCharCode(...buf.subarray(i, i + 8192));
    }
    return btoa(bin);
  } catch (e) {
    console.error("PDF_ERROR", String(e));
    return null;
  } finally {
    clearTimeout(reloj);
  }
}
