#!/usr/bin/env python3
"""Respalda los archivos de Supabase Storage (los PDFs de lead magnets, avatares).

POR QUÉ EXISTE (2026-08-23): el respaldo diario bajaba las TABLAS pero no los
ARCHIVOS. Los 6 PDFs de lead magnets viven solo dentro de Supabase; si se
perdieran, los botones de descarga del sitio quedarían rotos y no habría de
dónde reponerlos. Sebastián: "tiene que tener backup de todo".

Cómo saca la lista: de storage.objects, que es el índice real de la base, con la
ruta completa de cada archivo. Listar por la API de Storage devuelve carpetas
mezcladas con archivos (un avatar guardado en una carpeta con nombre de email
figura como objeto de tamaño "?" y descargarlo da 400). La tabla no miente.

La clave de servicio NO es un secret del repo: se pide en el momento con el
token de Supabase que el workflow ya tiene, y nunca se imprime.

Uso:  SUPABASE_ACCESS_TOKEN=... python3 scripts/backup-storage.py <carpeta-destino>
"""
import json, os, subprocess, sys, urllib.parse

REF = "lumoevaotokgqnpybkyf"
API = "https://api.supabase.com/v1/projects/" + REF
DESTINO = sys.argv[1] if len(sys.argv) > 1 else "archivos"
TOKEN = os.environ.get("SUPABASE_ACCESS_TOKEN", "").strip()
if not TOKEN:
    sys.exit("Falta SUPABASE_ACCESS_TOKEN")


def curl(url, headers, data=None, salida=None):
    """curl y no urllib: api.supabase.com está detrás de Cloudflare y responde
    403 (error 1010) a los user-agent de Python."""
    cmd = ["curl", "-s", "-m", "90"]
    for h in headers:
        cmd += ["-H", h]
    if data is not None:
        cmd += ["-X", "POST", "--data-binary", data]
    if salida:
        cmd += ["-o", salida, "-w", "%{http_code}"]
    cmd.append(url)
    r = subprocess.run(cmd, capture_output=True, text=True)
    return r.stdout


auth = ["Authorization: Bearer " + TOKEN]

# 1. clave de servicio (para poder leer buckets privados)
claves = json.loads(curl(API + "/api-keys", auth))
srv = next((k["api_key"] for k in claves if k.get("name") == "service_role"), None)
if not srv:
    sys.exit("No se pudo obtener la clave de servicio")

# 2. índice real de archivos
sql = json.dumps({"query": "select bucket_id, name, (metadata->>'size')::bigint as bytes from storage.objects order by 1,2;"})
objetos = json.loads(curl(API + "/database/query", auth + ["Content-Type: application/json"], data=sql))
if isinstance(objetos, dict):
    sys.exit("Error consultando storage.objects: " + str(objetos)[:200])
print(f"  archivos a respaldar: {len(objetos)}")

# 3. bajarlos
os.makedirs(DESTINO, exist_ok=True)
bajados = bytes_ok = 0
fallos = []
for o in objetos:
    ruta = os.path.join(DESTINO, o["bucket_id"], o["name"])
    os.makedirs(os.path.dirname(ruta), exist_ok=True)
    url = (f"https://{REF}.supabase.co/storage/v1/object/{o['bucket_id']}/"
           + urllib.parse.quote(o["name"]))
    code = curl(url, ["Authorization: Bearer " + srv], salida=ruta)
    peso = os.path.getsize(ruta) if os.path.exists(ruta) else 0
    esperado = o["bytes"] or 0
    if code != "200" or (esperado and peso != esperado):
        fallos.append(f"{o['bucket_id']}/{o['name']} (http {code}, {peso} de {esperado} bytes)")
    else:
        bajados += 1
        bytes_ok += peso
    print(f"    {o['bucket_id']}/{o['name'][:48]:50} {peso} bytes")

print(f"  bajados {bajados}/{len(objetos)} · {bytes_ok/1024:.0f} KB")

# Un archivo faltante o cortado no puede pasar como respaldo bueno: es
# exactamente el modo de falla silenciosa que ya nos mordió con el dump vacío.
if fallos:
    for f in fallos:
        print("  ::error::no se pudo respaldar " + f)
    sys.exit(1)
if not objetos:
    print("  (no hay archivos en Storage — nada que respaldar)")
