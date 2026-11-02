#!/usr/bin/env bash
# Print the image tag for this source tree: the first 12 hex chars of sha256
# over `git ls-files -s` for the files that go into the API and web images.
# Blob ids plus paths stay the same when the tree is copied into a slot repo.
# deploy/values.yaml and deploy/chart/release-values.yaml are outside the
# hash, so the tag-bump commit does not change the tag.
set -euo pipefail

root=$(git rev-parse --show-toplevel)
cd "$root"

listing=$(git ls-files -s -- \
  apps \
  package.json \
  package-lock.json \
  Dockerfile \
  Dockerfile.web \
  deploy/web)

if [[ -z "$listing" ]]; then
  echo "image-tag.sh: no tracked image inputs" >&2
  exit 1
fi

# Command substitution drops the trailing newline that git ls-files prints.
printf '%s\n' "$listing" | python3 -c 'import hashlib,sys; print(hashlib.sha256(sys.stdin.buffer.read()).hexdigest()[:12])'
