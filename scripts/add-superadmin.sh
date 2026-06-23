#!/usr/bin/env bash
# Add RepMeUp super_admin (admin panel logs in with email + password).
#


set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

EMAIL="${1:-}"
PASS="${2:-}"
FIRST="${3:-Super}"
LAST="${4:-Admin}"

if [[ -z "${EMAIL}" || -z "${PASS}" ]]; then
  echo "Usage: $0 <login-email> <password> [first-name] [last-name]" >&2
  echo "" >&2
  echo "Admin panel uses EMAIL as the login id (same as npm run create-super-admin)." >&2
  exit 1
fi

exec node scripts/createSuperAdmin.js --email "$EMAIL" --password "$PASS" --first-name "$FIRST" --last-name "$LAST"
