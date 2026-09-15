#!/usr/bin/env bash
# Refresh the Tailscale TLS cert used by the dev server and sync server.
#
# certs/tailscale.{crt,key} are a static snapshot. Let's Encrypt issues them with a
# 90-day lifetime and nothing renews them on its own, so port 3000 starts failing
# while Tailscale Funnel on 443 keeps working from tailscaled's own auto-renewed
# cache. The sync server warns when expiry is close; run this (via `pnpm certs:refresh`)
# and restart it. Refetches only inside the renewal window, so it is cheap to re-run.
#
# Never fails the build: a machine without Tailscale, or an offline one, still gets
# to start the server (use tls: false there).

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CERT_DIR="$ROOT/certs"
CRT="$CERT_DIR/tailscale.crt"
KEY="$CERT_DIR/tailscale.key"
RENEW_WINDOW_DAYS=14

warn() { echo "refresh-certs: $*" >&2; }

# Bail out rather than touching an unrelated directory if the path above resolved wrong.
if [ ! -f "$ROOT/package.json" ]; then
  warn "cannot locate the repo root, leaving certs alone"
  exit 0
fi

if ! command -v tailscale >/dev/null 2>&1; then
  warn "tailscale not on PATH, leaving certs alone"
  exit 0
fi

# CertDomains is the set of names tailscaled will actually issue a cert for.
DOMAIN="$(timeout 15 tailscale status --json 2>/dev/null \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const d=JSON.parse(s).CertDomains;if(d&&d.length)process.stdout.write(d[0])}catch{}})' 2>/dev/null)"

if [ -z "$DOMAIN" ]; then
  warn "no cert domain available (tailscaled down, or HTTPS disabled for this tailnet)"
  exit 0
fi

# Skip the call when the snapshot is current and matches this machine's name.
if [ -f "$CRT" ] && [ -f "$KEY" ]; then
  SECONDS_LEFT=$(( RENEW_WINDOW_DAYS * 86400 ))
  CURRENT_CN="$(openssl x509 -in "$CRT" -noout -subject 2>/dev/null | sed -n 's/.*CN *= *//p')"
  if [ "$CURRENT_CN" = "$DOMAIN" ] && openssl x509 -in "$CRT" -noout -checkend "$SECONDS_LEFT" >/dev/null 2>&1; then
    exit 0
  fi
fi

mkdir -p "$CERT_DIR"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

if ! timeout 120 tailscale cert --cert-file "$TMP/c" --key-file "$TMP/k" "$DOMAIN" >/dev/null 2>&1; then
  warn "could not fetch a cert for $DOMAIN, keeping the existing one"
  exit 0
fi

# Only install a cert whose key actually matches, so a partial fetch cannot
# replace a working pair with a broken one.
if ! diff -q <(openssl x509 -in "$TMP/c" -noout -pubkey 2>/dev/null) \
             <(openssl pkey -in "$TMP/k" -pubout 2>/dev/null) >/dev/null 2>&1; then
  warn "fetched cert and key do not match, keeping the existing one"
  exit 0
fi

mv "$TMP/c" "$CRT"
mv "$TMP/k" "$KEY"
chmod 600 "$KEY"
echo "refresh-certs: renewed $DOMAIN through $(openssl x509 -in "$CRT" -noout -enddate | sed 's/notAfter=//')"
