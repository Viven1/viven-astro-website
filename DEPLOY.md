# Cómo se publica viven.ch — y la trampa que ya costó una noche

**Lo que está en `main` es lo que tiene que estar publicado.** Se pushea a `main`, el
Action `Publicar viven.ch` compila y despliega el Worker `viven-astro-website`.

## Hay UNA sola vía válida: el GitHub Action

El 26 de agosto de 2026 producción amaneció sirviendo un build de la rama **`dev`**
—service worker `viven-crm-v29`, del 25 de agosto a las 14:22— pisando ocho deploys de
`main` de esa madrugada que habían salido bien y verificado 200. Toda una noche de
trabajo dejó de estar en vivo sin que nada fallara ni avisara.

Cómo se reconoce en treinta segundos:

```bash
# lo que debería estar
git show origin/main:public/dashboard-sw.js | grep -o "viven-crm-v[0-9]*"
# lo que hay
curl -s "https://www.viven.ch/dashboard-sw.js?x=$RANDOM" | grep -o "viven-crm-v[0-9]*"
```

Si no coinciden, producción NO es `main`. Para saber de qué rama es:

```bash
for b in $(git ls-remote --heads origin | sed 's|.*refs/heads/||'); do
  echo "$b $(git show origin/$b:public/dashboard-sw.js 2>/dev/null | grep -o 'viven-crm-v[0-9]*')"
done
```

## Qué revisar en Cloudflare

El repo no tiene ninguna config que despliegue `dev`: los tres workflows de
`.github/workflows/` solo miran `main`. Así que la otra vía está configurada **del lado
de Cloudflare**, en el Worker `viven-astro-website` → *Builds* (Workers Builds conectado
al repo). Si está observando `dev` —o cualquier rama que no sea `main`— va a volver a
pisar el deploy bueno cada vez que corra.

**Dejar una sola:** o se desconecta Workers Builds y publica solo el Action, o se lo
apunta a `main` y se saca el Action. Dos vías que publican ramas distintas es una
carrera que se pierde en silencio.

## Por qué `dev` está tan atrás

`publish-blog` commiteaba ahí hasta el 25 de agosto (ver el comentario en esa función).
Hoy `dev` está 3 commits adelante y ~43 atrás de `main`: no es una rama de trabajo, es
un resto. Conviene borrarla o resetearla a `main` para que no pueda volver a ganar.
