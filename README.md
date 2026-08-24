# Rama `cola-de-trabajo` — no es código

Esta rama **no publica nada**: el deploy del sitio solo corre con pushes a `main`.

Existe para un problema concreto: Sebastián aprueba cosas desde el teléfono y caen
en `work_queue` (Supabase). El agente diario que las trabaja corre en la nube de
Anthropic y **no tiene —ni debe tener— credenciales de la base**. Así que la
function `cola-a-repo` escribe acá lo que está aprobado y esperando, y el agente
lee un archivo en vez de una base.

Nada de esta rama se mergea a `main`.
