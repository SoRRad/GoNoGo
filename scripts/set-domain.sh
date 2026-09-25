#!/usr/bin/env bash
#
# Moves the study to a new web address, keeping every old link working.
#
#   ./scripts/set-domain.sh gonogo.a-starlab.com
#
# Run it on the VM, from the app folder, as the usual user (it uses sudo for
# Caddy). Before running, the new name must point at this VM's static IP: an A
# record wherever the domain's DNS is managed. The script checks that first
# and changes nothing if it does not.
#
# Then, in this order, so the study is never unreachable:
#   1. Caddy serves the study at both the old and the new address, and fetches
#      a certificate for the new one.
#   2. Once the new address answers over HTTPS, BASE_URL in .env becomes the
#      new address and the app restarts, so links copied or emailed from the
#      admin page use it.
#   3. The old address becomes a forward to the new one, path included, so
#      every link already emailed (…/a/<token>) still works.
#
# The Caddy configuration is rebuilt from Caddyfile.example with the email
# already in use; the previous file is kept beside it with a date. Safe to run
# again: a finished move is recognised and left alone.
#
# Environment:
#   CADDYFILE   default /etc/caddy/Caddyfile

set -euo pipefail

cd "$(dirname "$(readlink -f "$0")")/.."

CADDYFILE="${CADDYFILE:-/etc/caddy/Caddyfile}"
TEMPLATE="Caddyfile.example"
STAMP="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
WORK="$(mktemp -d)"
# Caddy validates as its own user, which must be able to read the candidates.
chmod 755 "${WORK}"
trap 'rm -rf "${WORK}"' EXIT

say() { echo "==> $*"; }
fail() {
  echo "" >&2
  echo "STOPPED: $*" >&2
  exit 1
}

# --------------------------------------------------------------------------
# What we are moving from and to
# --------------------------------------------------------------------------
NEW="$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]' | sed -E 's#^https?://##; s#[/:].*$##')"
[[ "${NEW}" =~ ^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$ ]] ||
  fail "Give the new address, for example:  ./scripts/set-domain.sh gonogo.a-starlab.com"
[[ -f "${CADDYFILE}" ]] || fail "No Caddy configuration at ${CADDYFILE}. Is Caddy set up (README step 5)?"
[[ -f .env ]] || fail "No .env in $(pwd). Run this in the app folder: cd /opt/sadi/app"
[[ -f "${TEMPLATE}" ]] || fail "${TEMPLATE} is missing. Run: git pull"

# Every address the Caddyfile serves: lines like "name {" or "one, two {".
site_addresses() {
  grep -E '^[^[:space:]#{][^{]*\{[[:space:]]*$' "${CADDYFILE}" |
    sed -E 's/[[:space:]]*\{[[:space:]]*$//' | tr ',' '\n' |
    sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//' | grep -v '^$' | sort -u || true
}

# The example's placeholder is never a real previous address.
OLD="$(site_addresses | grep -vxF -e "${NEW}" -e study.example.org || true)"
if [[ "$(printf '%s\n' "${OLD}" | grep -c .)" -gt 1 ]]; then
  fail "The Caddy configuration serves more than one other address ($(echo ${OLD})), so it is not clear which to forward. Nothing was changed."
fi

# Keep the email Caddy already uses; it is what lets Caddy fall back to ZeroSSL.
EMAIL="$(sed -nE 's/^[[:space:]]*email[[:space:]]+([^[:space:]#]+).*/\1/p' "${CADDYFILE}" | head -1)"
[[ "${EMAIL}" == "you@example.org" ]] && EMAIL=""

current_base_url() { sed -nE 's/^BASE_URL=(.*)$/\1/p' .env | tail -1; }

if grep -qF "redir https://${NEW}{uri}" "${CADDYFILE}" && [[ "$(current_base_url)" == "https://${NEW}" ]]; then
  say "The study already lives at https://${NEW}${OLD:+, with ${OLD} forwarding to it}. Nothing to do."
  exit 0
fi

# --------------------------------------------------------------------------
# DNS must already point here, or Caddy cannot get a certificate
# --------------------------------------------------------------------------
say "Checking that ${NEW} points at this server"
MY_IP="$(curl -s --max-time 5 -H 'Metadata-Flavor: Google' \
  'http://metadata.google.internal/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip' || true)"
[[ "${MY_IP}" =~ ^[0-9.]+$ ]] || fail "Could not read this server's external IP from Google Cloud. Nothing was changed."
RESOLVED="$(getent ahostsv4 "${NEW}" | awk '{print $1}' | sort -u | paste -sd' ' || true)"
if [[ -z "${RESOLVED}" ]]; then
  fail "${NEW} is not in DNS yet. Add an A record for it with the value ${MY_IP}, wait 10 minutes, and run this again. Nothing was changed."
fi
if [[ "${RESOLVED}" != "${MY_IP}" ]]; then
  fail "${NEW} points at ${RESOLVED}, but this server is ${MY_IP}. Its DNS record should be a single A record with the value ${MY_IP} (no CNAME). Fix it, wait 10 minutes, and run this again. Nothing was changed."
fi
IPV6="$(python3 -c 'import socket, sys
try:
    print(" ".join(sorted({a[4][0] for a in socket.getaddrinfo(sys.argv[1], 443, socket.AF_INET6)})))
except OSError:
    pass' "${NEW}" 2>/dev/null || true)"
if [[ -n "${IPV6}" ]]; then
  fail "${NEW} also has an IPv6 (AAAA) record, ${IPV6}, which is not this server. Certificate checks can use it and fail. Delete that AAAA record, wait 10 minutes, and run this again. Nothing was changed."
fi
echo "    ${NEW} -> ${MY_IP}, this server."

# --------------------------------------------------------------------------
# Building and installing Caddy configurations
# --------------------------------------------------------------------------
# $1: the addresses that serve the study; $2: an address to forward, or empty.
render() {
  echo "# Written by scripts/set-domain.sh on ${STAMP}, from ${TEMPLATE}."
  echo "# The configuration before it is kept beside this file."
  if [[ -n "${EMAIL}" ]]; then
    sed -E "s|^([[:space:]]*email[[:space:]]+).*|\\1${EMAIL}|" "${TEMPLATE}"
  else
    grep -vE '^[[:space:]]*email[[:space:]]+' "${TEMPLATE}"
  fi | sed -E "s|^study\\.example\\.org \\{|$1 {|"
  if [[ -n "$2" ]]; then
    cat <<EOF

# The study's previous address. Every request, emailed access links included,
# goes on to the same path at the new one. 308 keeps a form post a post.
# Nothing here is logged: an access link is a password.
$2 {
	redir https://${NEW}{uri} 308
}
EOF
  fi
}

BACKED_UP=0
install_caddyfile() {
  local candidate="$1"
  chmod 644 "${candidate}"
  if ! sudo -u caddy caddy validate --adapter caddyfile --config "${candidate}" >"${WORK}/validate.log" 2>&1; then
    cat "${WORK}/validate.log" >&2
    fail "Caddy did not accept the new configuration. The running one was not touched."
  fi
  if [[ "${BACKED_UP}" == "0" ]]; then
    sudo cp -p "${CADDYFILE}" "${CADDYFILE}.before-${STAMP}"
    echo "    previous configuration kept as ${CADDYFILE}.before-${STAMP}"
    BACKED_UP=1
  fi
  sudo install -m 644 "${candidate}" "${CADDYFILE}"
  if ! sudo systemctl reload caddy; then
    sudo cp -p "${CADDYFILE}.before-${STAMP}" "${CADDYFILE}"
    sudo systemctl reload caddy || true
    fail "Caddy would not reload, so the previous configuration was put back."
  fi
}

# HTTP status of a request to this server under a given name, checking the
# certificate as a browser would. 000 means no valid HTTPS for that name yet.
status_of() {
  curl -s -o /dev/null -w '%{http_code}' --max-time 10 --resolve "$1:443:127.0.0.1" "https://$1$2" || true
}

# --------------------------------------------------------------------------
# 1. Serve the study at both addresses
# --------------------------------------------------------------------------
say "Step 1 of 3: serving the study at ${NEW}${OLD:+ as well as ${OLD}}"
render "${NEW}${OLD:+, ${OLD}}" "" >"${WORK}/both"
install_caddyfile "${WORK}/both"

echo "    waiting for the certificate for ${NEW} (usually under a minute)"
for attempt in $(seq 1 36); do
  [[ "$(status_of "${NEW}" /api/health)" != "000" ]] && break
  if [[ "${attempt}" == "36" ]]; then
    fail "${NEW} has no working HTTPS after 3 minutes. The study still works at ${OLD:-its old address}, unchanged for surgeons. To see why: sudo journalctl -u caddy --since '15 min ago' | tail -40"
  fi
  sleep 5
done
echo "    https://${NEW} is answering."

# --------------------------------------------------------------------------
# 2. The app hands out links on the new address
# --------------------------------------------------------------------------
say "Step 2 of 3: links from the admin page now use https://${NEW}"
if grep -q '^BASE_URL=' .env; then
  sed -i "s|^BASE_URL=.*|BASE_URL=https://${NEW}|" .env
else
  echo "BASE_URL=https://${NEW}" >>.env
fi
docker compose up -d
for attempt in $(seq 1 30); do
  [[ "$(status_of "${NEW}" /api/health)" == "200" ]] && break
  if [[ "${attempt}" == "30" ]]; then
    echo "    WARNING: the app has not reported healthy yet. Check it with: docker compose ps" >&2
  fi
  sleep 3
done
IN_APP="$(docker compose exec -T app printenv BASE_URL 2>/dev/null || true)"
[[ "${IN_APP}" == "https://${NEW}" ]] || fail "The app still reports BASE_URL=${IN_APP}. Run: docker compose up -d   then run this script again."
echo "    the app is using https://${NEW}"

# --------------------------------------------------------------------------
# 3. The old address forwards to the new one
# --------------------------------------------------------------------------
if [[ -z "${OLD}" ]]; then
  say "Step 3 of 3: there was no previous address to forward."
else
  say "Step 3 of 3: ${OLD} now forwards to ${NEW}"
  render "${NEW}" "${OLD}" >"${WORK}/moved"
  install_caddyfile "${WORK}/moved"
  forwarded=""
  for attempt in $(seq 1 10); do
    forwarded="$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' --max-time 10 \
      --resolve "${OLD}:443:127.0.0.1" "https://${OLD}/admin" || true)"
    [[ "${forwarded}" == "308 https://${NEW}/admin" ]] && break
    sleep 2
  done
  [[ "${forwarded}" == "308 https://${NEW}/admin" ]] ||
    fail "The old address answered '${forwarded}' instead of forwarding. Previous configuration: ${CADDYFILE}.before-${STAMP}"
  echo "    https://${OLD}/admin -> https://${NEW}/admin"
fi

echo ""
echo "DONE. The study is at https://${NEW}"
echo "  - Admin page: https://${NEW}/admin (sign in again: sign-ins do not carry across addresses)."
echo "  - Links already emailed still work: they forward to the new address."
echo "  - Copy link and Send invite now give links on the new address."
