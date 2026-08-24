# Viven CRM — app de macOS

Contenedor nativo del dashboard. Es un `.app` real (ícono, ventana y menú propios)
que muestra `https://www.viven.ch/dashboard/`.

## Por qué un contenedor y no una app nativa de cero

El dashboard es una web app: una página Astro contra Supabase. Reescribir cada
pantalla en Swift serían meses y dejaría **dos** productos que se desincronizan —
cada cambio habría que hacerlo dos veces. El contenedor da lo que se quería (app de
verdad en el Dock, fuera del navegador, actualizaciones controladas) sin partir el
producto en dos.

## Lo que resuelve sobre la PWA instalada desde Chrome

- Vive en `~/Applications`, no se pierde entre las pestañas.
- Menú nativo con **⌘R** y **⌘⇧R = "Forzar recarga"**, que limpia caché y service
  worker. El 12 ago 2026 Sebastián estuvo con código viejo sin síntoma visible
  (tocaba un botón y no pasaba nada); esto lo arregla de un tirón.
- Sesión propia y persistente: se loguea una vez.
- Links externos abren en el navegador del sistema, nunca dentro de la app.

## Compilar

```bash
cd desktop
npm install
npx electron-builder --mac --dir      # → out/mac-arm64/Viven CRM.app
cp -R "out/mac-arm64/Viven CRM.app" ~/Applications/
```

`npm start` la corre sin empaquetar, para probar cambios del contenedor.

## Estado y límites (honestos)

- **Sin firmar** (`identity: null`). Compilada en la misma Mac no queda en
  cuarentena, así que abre con doble click. Si algún día se copia desde otra
  máquina o se baja de internet, macOS va a pedir click derecho → Abrir la primera
  vez. Firmarla y notarizarla requiere la cuenta de Apple Developer.
- **233 MB**: Electron trae su propio Chromium. Tauri pesaría ~5 MB pero necesita
  toolchain de Rust, que no está instalada en esta Mac.
- **No auto-actualiza el contenedor.** No hace falta seguido: el contenido viene de
  la web, así que los cambios del dashboard aparecen solos. Solo hay que recompilar
  si se toca `main.js`.
- El ícono sale de `public/assets/crm-512.png` (el mismo de la PWA), convertido a
  `.icns` con `sips` + `iconutil`.
