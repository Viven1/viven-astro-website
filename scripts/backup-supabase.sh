#!/bin/bash
# Respaldo completo de la base de Viven a R2.
#
# POR QUÉ EXISTE (2026-08-14): el proyecto está en el plan free, que NO hace
# backups. Medido ese día contra la Management API: 0 backups disponibles y PITR
# apagado. O sea que un `delete` mal apuntado, o el proyecto pausado por
# inactividad, se llevaba puestos leads, propuestas, facturas y el histórico de
# emails sin ninguna forma de volver atrás.
#
# Baja TODAS las tablas de `public` (más auth.users, que es quién puede entrar) a
# JSON, las comprime y las sube a R2. Es un volcado lógico, no un backup binario
# de Postgres: sirve para reconstruir datos, no para restaurar el proyecto entero
# de un botón. Para eso hace falta PITR, que es pago.
#
# NO va nunca a git: son datos personales de clientes. R2 es privado.
#
# Uso:  ./scripts/backup-supabase.sh
# Necesita: ~/.supabase-token (PAT sbp_) y wrangler logueado.

set -euo pipefail

REF="lumoevaotokgqnpybkyf"
BUCKET="viven-backups"
TOKEN=$(cat ~/.supabase-token)
FECHA=$(date +%Y-%m-%d_%H%M)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

sql() {
  curl -s -m 120 -X POST "https://api.supabase.com/v1/projects/$REF/database/query" \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    --data-binary @<(python3 -c "import json,sys; print(json.dumps({'query': sys.argv[1]}))" "$1")
}

echo "→ listando tablas…"
TABLAS=$(sql "select tablename from pg_tables where schemaname='public' order by 1;" \
  | python3 -c "import sys,json; print('\n'.join(r['tablename'] for r in json.load(sys.stdin)))")

mkdir -p "$TMP/$FECHA"
TOTAL=0
for t in $TABLAS; do
  # coalesce(...,'[]') — una tabla vacía devuelve null y rompería el JSON
  sql "select coalesce(json_agg(x),'[]'::json) as filas from public.$t x;" \
    | python3 -c "
import sys,json
d=json.load(sys.stdin)
filas=d[0]['filas'] if isinstance(d,list) and d else []
json.dump(filas, open('$TMP/$FECHA/$t.json','w'), ensure_ascii=False, default=str)
print(len(filas))
" | { read -r n; printf "  %-34s %s filas\n" "$t" "$n"; TOTAL=$((TOTAL+n)); }
done

# quién tiene acceso: sin esto, un restore deja la base sin saber a quién dejar entrar
sql "select id,email,created_at,last_sign_in_at,email_confirmed_at from auth.users order by created_at;" \
  > "$TMP/$FECHA/_auth_users.json"

cd "$TMP"
tar -czf "$FECHA.tar.gz" "$FECHA"
PESO=$(du -h "$FECHA.tar.gz" | cut -f1)
echo "→ subiendo a R2 ($PESO)…"
npx wrangler r2 object put "$BUCKET/$FECHA.tar.gz" --file "$FECHA.tar.gz" --remote >/dev/null
echo "✅ $BUCKET/$FECHA.tar.gz  ($PESO)"
