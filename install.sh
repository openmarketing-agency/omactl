#!/bin/sh
set -eu
# Bootstrap only; the installed binary needs no host tools except Docker.
os=$(uname -s | tr '[:upper:]' '[:lower:]')
case "$os" in linux|darwin) ;; *) echo 'Use Linux, macOS, or WSL2.' >&2; exit 3;; esac
case "$(uname -m)" in x86_64|amd64) arch=x64;; arm64|aarch64) arch=arm64;; *) echo 'Unsupported architecture' >&2; exit 3;; esac
suffix=
if [ "$os" = linux ] && ldd --version 2>&1 | grep -qi musl; then suffix=-musl; fi
release_url=${OMA_RELEASE_URL:-https://releases.openmarketing.agency}
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT HUP INT TERM
# Channel metadata is parsed without jq/Python; only the exact named platform object is selected.
curl -fsSL "$release_url/channels/stable.json" -o "$tmp/channel.json"
compact=$(tr -d '\n\r ' < "$tmp/channel.json")
platform="$os-$arch$suffix"
asset=$(printf '%s' "$compact" | sed -n "s/.*\"$platform\":{\([^}]*\)}.*/\1/p")
url=$(printf '%s' "$asset" | sed -n 's/.*"url":"\([^"]*\)".*/\1/p')
sha=$(printf '%s' "$asset" | sed -n 's/.*"sha256":"\([a-f0-9]*\)".*/\1/p')
[ -n "$url" ] && [ "${#sha}" -eq 64 ] || { echo 'Invalid channel asset' >&2; exit 3; }
curl -fsSL "$url" -o "$tmp/omactl"
if command -v sha256sum >/dev/null 2>&1; then actual=$(sha256sum "$tmp/omactl" | cut -d ' ' -f 1); else actual=$(shasum -a 256 "$tmp/omactl" | cut -d ' ' -f 1); fi
[ "$actual" = "$sha" ] || { echo 'SHA-256 mismatch' >&2; exit 3; }
if [ "$(id -u)" -eq 0 ]; then dest=/usr/local/bin; else dest="$HOME/.local/bin"; fi
mkdir -p "$dest"
chmod 755 "$tmp/omactl"
mv "$tmp/omactl" "$dest/omactl"
printf 'Installed %s/omactl\nNext: omactl init\n' "$dest"
