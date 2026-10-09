#!/usr/bin/env bash
set -euo pipefail

imgbed_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
imgbed_build="$(mktemp -d)"
trap 'rm -rf "$imgbed_build"' EXIT

# This repository ships built assets; pin the upstream source so the patch stays reproducible.
git clone --filter=blob:none --no-checkout https://github.com/MarSeventh/Sanyue-ImgHub.git "$imgbed_build/source"
git -C "$imgbed_build/source" checkout --detach f07229e54b1e3e1de80e1d6902d38b5e0c3d4462
git -C "$imgbed_build/source" apply "$imgbed_root/deploy/frontend/retention.patch"
cp "$imgbed_root/docs/api.html" "$imgbed_build/source/public/api-docs.html"
cd "$imgbed_build/source"
npm ci --no-audit --no-fund
npm run build -- --dest "$imgbed_build/dist"
rm -rf "$imgbed_root/frontend-dist"
cp -R "$imgbed_build/dist" "$imgbed_root/frontend-dist"
