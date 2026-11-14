#!/usr/bin/env bash
# Publish the API and web images for TAG if they are not already in the registry.
# Used by release.yml (main) and prebuild.yml (canonical tags and scenario overlays).
set -euo pipefail

: "${IMAGE_API:?IMAGE_API is required}"
: "${IMAGE_WEB:?IMAGE_WEB is required}"
: "${TAG:?TAG is required}"
: "${GIT_SHA:?GIT_SHA is required}"

root=$(git rev-parse --show-toplevel)
cd "$root"

publish() {
  local image=$1
  local file=$2
  shift 2
  if docker buildx imagetools inspect "${image}:${TAG}" >/dev/null 2>&1; then
    echo "Reusing ${image}:${TAG}"
    return
  fi
  docker buildx build \
    --file "$file" \
    "$@" \
    --tag "${image}:${TAG}" \
    --provenance=false \
    --sbom=false \
    --push \
    .
}

publish "$IMAGE_API" Dockerfile --build-arg "GIT_SHA=${GIT_SHA}"
publish "$IMAGE_WEB" Dockerfile.web
