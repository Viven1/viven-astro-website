/* Viven CRM — contenedor nativo de macOS del dashboard.
 *
 * Por qué existe: el dashboard es una web app (una página Astro contra Supabase).
 * Sebastián quería una app de verdad en el Dock, no una pestaña de Chrome. Esto es
 * un .app real —ícono propio, ventana propia, menú nativo, atajos— que muestra el
 * mismo dashboard de https://www.viven.ch/dashboard/.
 *
 * Lo que gana sobre la PWA instalada:
 *   · vive en Aplicaciones, no se pierde entre las pestañas del navegador
 *   · menú nativo con ⌘R de verdad, y "Forzar recarga" que limpia el caché — el
 *     problema de quedarse con código viejo (12 ago 2026) se arregla de un tirón
 *   · la sesión persiste en el perfil de la app, así que no hay que loguearse cada vez
 *
 * Lo que NO cambia: las pantallas son las mismas, porque el producto es el mismo.
 * Una reescritura nativa significaría mantener dos dashboards y desincronizarlos.
 *
 * Reglas de seguridad de la ventana:
 *   · nodeIntegration apagado y contextIsolation prendido (la web no toca Node)
 *   · solo se navega dentro de viven.ch; cualquier otro link abre en el navegador
 *     del sistema (si no, un click en un link externo secuestraría la app)
 */
const { app, BrowserWindow, Menu, shell, session } = require('electron');
const path = require('node:path');

const INICIO = 'https://www.viven.ch/dashboard/';
const DOMINIO_OK = /(^|\.)viven\.ch$/i;

/** Los flujos de login de Supabase/Google pueden salir del dominio: se permiten en
 *  ventana propia, pero nunca reemplazan la app. */
const ES_LOGIN = (host) => /(^|\.)supabase\.co$|(^|\.)accounts\.google\.com$/i.test(host);

let win = null;
let pendiente = null;   // enlace viven:// que llegó antes de que existiera la ventana

/* ── Enlaces viven:// ────────────────────────────────────────────────────────
 * Sebastián, 13 ago 2026: el email de un lead nuevo tiene "Abrir la ficha en el
 * dashboard" y eso abría el navegador, no la app. Ahora el email lleva también
 * `viven://lead/274` y macOS lo entrega acá.
 *
 * Regla de seguridad: el enlace llega de un email, así que NO se navega a lo que
 * diga el enlace. Solo se saca de él un id numérico y la URL se arma acá con
 * nuestro propio dominio. Un `viven://lead/https://otro-sitio` no lleva a
 * ningún lado que no sea el dashboard. */
function idDeEnlace(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'viven:') return null;
    const crudo = u.searchParams.get('lead') || (u.pathname + u.hostname).match(/\d+/)?.[0];
    const id = String(crudo || '').match(/^\d{1,12}$/)?.[0];
    return id || '';           // '' = abrir el dashboard sin ficha puntual
  } catch { return null; }
}

function abrirEnlace(url) {
  const id = idDeEnlace(url);
  if (id === null) return;     // no es nuestro esquema: no hacemos nada
  const destino = id ? `${INICIO}?lead=${id}` : INICIO;
  console.log('[viven] enlace', url, '→', destino);   // queda: es la única forma de ver por qué un enlace no abrió lo que se esperaba
  if (!win) { pendiente = destino; return; }
  win.loadURL(destino);
  if (win.isMinimized()) win.restore();
  win.show(); win.focus();
  app.focus({ steal: true });
}

function crearVentana() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 380,          // el dashboard es responsive: se puede usar angosto
    minHeight: 520,
    titleBarStyle: 'default',
    backgroundColor: '#0f1826',   // el navy del dashboard, para que no parpadee en blanco
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      spellcheck: true,
    },
  });

  win.loadURL(pendiente || INICIO);
  pendiente = null;

  // links externos → navegador del sistema, nunca dentro de la app
  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const host = new URL(url).hostname;
      if (ES_LOGIN(host)) return { action: 'allow' };
      shell.openExternal(url);
    } catch { /* url rara: no abrimos nada */ }
    return { action: 'deny' };
  });

  // navegación dentro de la ventana: solo viven.ch (y los pasos de login)
  win.webContents.on('will-navigate', (e, url) => {
    try {
      const host = new URL(url).hostname;
      if (DOMINIO_OK.test(host) || ES_LOGIN(host)) return;
      e.preventDefault();
      shell.openExternal(url);
    } catch { e.preventDefault(); }
  });

  win.on('closed', () => { win = null; });
}

/** Recarga limpiando el caché HTTP y desregistrando el service worker: es el botón
 *  "no me está mostrando la versión nueva" hecho de una vez, sin tener que explicar
 *  ⌘⇧R ni DevTools. */
async function forzarRecarga() {
  if (!win) return;
  try {
    await session.defaultSession.clearCache();
    await session.defaultSession.clearStorageData({ storages: ['serviceworkers', 'cachestorage'] });
  } catch { /* si falla, igual recargamos */ }
  win.webContents.reloadIgnoringCache();
}

function menu() {
  const plantilla = [
    {
      label: 'Viven CRM',
      submenu: [
        { role: 'about', label: 'Acerca de Viven CRM' },
        { type: 'separator' },
        { role: 'hide', label: 'Ocultar' },
        { role: 'hideOthers', label: 'Ocultar los demás' },
        { role: 'unhide', label: 'Mostrar todo' },
        { type: 'separator' },
        { role: 'quit', label: 'Salir de Viven CRM' },
      ],
    },
    {
      label: 'Archivo',
      submenu: [
        { label: 'Recargar', accelerator: 'CmdOrCtrl+R', click: () => win && win.webContents.reload() },
        { label: 'Forzar recarga (traer la versión nueva)', accelerator: 'CmdOrCtrl+Shift+R', click: forzarRecarga },
        { type: 'separator' },
        { label: 'Ir al inicio del dashboard', click: () => win && win.loadURL(INICIO) },
        { label: 'Abrir en el navegador', click: () => shell.openExternal(INICIO) },
        { type: 'separator' },
        { role: 'close', label: 'Cerrar ventana' },
      ],
    },
    {
      label: 'Edición',
      submenu: [
        { role: 'undo', label: 'Deshacer' }, { role: 'redo', label: 'Rehacer' },
        { type: 'separator' },
        { role: 'cut', label: 'Cortar' }, { role: 'copy', label: 'Copiar' },
        { role: 'paste', label: 'Pegar' }, { role: 'selectAll', label: 'Seleccionar todo' },
      ],
    },
    {
      label: 'Ver',
      submenu: [
        { role: 'resetZoom', label: 'Tamaño real' },
        { role: 'zoomIn', label: 'Agrandar' }, { role: 'zoomOut', label: 'Achicar' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Pantalla completa' },
        { type: 'separator' },
        { role: 'toggleDevTools', label: 'Consola (diagnóstico)' },
      ],
    },
    { role: 'windowMenu', label: 'Ventana' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(plantilla));
}

// macOS entrega los viven:// por acá; puede llegar ANTES del ready (app cerrada),
// por eso el handler se registra arriba de todo y guarda el destino en `pendiente`.
app.on('open-url', (e, url) => { e.preventDefault(); abrirEnlace(url); });
app.setAsDefaultProtocolClient('viven');

// una sola instancia: un segundo click en el email enfoca la ventana que ya está
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const url = argv.find((a) => typeof a === 'string' && a.startsWith('viven://'));
    if (url) abrirEnlace(url);
    else if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });
}

app.whenReady().then(() => {
  menu();
  crearVentana();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) crearVentana(); });
});

// en macOS la app queda viva sin ventanas; se cierra con ⌘Q
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
