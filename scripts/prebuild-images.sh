#!/usr/bin/env bash
# Prebuild GHCR tags for the clean canonical tree, then each changesApps
# scenario that has overlays. Overlay bytes come from backlot-platform's
# pack (checked out outside the hash inputs). The image tag is image-tag.sh,
# which hashes git ls-files -s, so overlays are copied and git-added before
# the hash. vendor-regression has changesApps but no overlays and is skipped
# so the canonical tag is not built twice.
set -euo pipefail

root=$(git rev-parse --show-toplevel)
cd "$root"

PACK_DIR=${PACK_DIR:-.backlot-platform/internal/packs/packs/poster-meteor}
PACK_YAML=${PACK_YAML:-$PACK_DIR/pack.yaml}
IMAGE_API=${IMAGE_API:-ghcr.io/pluralsh-demos/poster-meteor}
IMAGE_WEB=${IMAGE_WEB:-ghcr.io/pluralsh-demos/poster-meteor-web}
GIT_SHA=${GIT_SHA:-$(git rev-parse HEAD)}

if [[ ! -f "$PACK_YAML" ]]; then
  echo "prebuild-images.sh: pack.yaml not found at $PACK_YAML" >&2
  exit 1
fi

overlays_tsv() {
  python3 - "$PACK_YAML" <<'PY'
import sys
from pathlib import Path

path = Path(sys.argv[1])
text = path.read_text()
current = None
changes = False
in_overlays = False
source = None

def unquote(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        return value[1:-1]
    return value

for raw in text.splitlines():
    stripped = raw.strip()
    if not stripped or stripped.startswith("#"):
        continue
    indent = len(raw) - len(raw.lstrip(" "))
    if indent == 2 and stripped.endswith(":") and not stripped.startswith("-"):
        current = stripped[:-1]
        changes = False
        in_overlays = False
        source = None
        continue
    if current is None:
        continue
    if indent == 4 and stripped.startswith("changesApps:"):
        changes = unquote(stripped.split(":", 1)[1]).lower() in ("true", "yes")
        continue
    if indent == 4 and stripped.startswith("overlays:"):
        in_overlays = stripped.split(":", 1)[1].strip() not in ("[]",)
        source = None
        continue
    if indent <= 4 and not stripped.startswith("-") and not stripped.startswith("changesApps:") and not stripped.startswith("overlays:"):
        in_overlays = False
        source = None
        continue
    if not in_overlays or not changes:
        continue
    if stripped.startswith("- source:"):
        source = unquote(stripped.split(":", 1)[1])
        continue
    if stripped.startswith("source:"):
        source = unquote(stripped.split(":", 1)[1])
        continue
    if stripped.startswith("destination:") and source:
        dest = unquote(stripped.split(":", 1)[1])
        print(f"{current}\t{source}\t{dest}")
        source = None
PY
}

under_hash_input() {
  local dest=$1
  case "$dest" in
    /*|*..*)
      echo "prebuild-images.sh: destination $dest must be a relative path without .." >&2
      return 1
      ;;
    apps/*|package.json|package-lock.json|Dockerfile|Dockerfile.web|deploy/web|deploy/web/*)
      return 0
      ;;
    *)
      echo "prebuild-images.sh: destination $dest is outside image-tag.sh inputs" >&2
      return 1
      ;;
  esac
}

publish_tree() {
  local label=$1
  local tag
  tag=$(./scripts/image-tag.sh)
  echo "Prebuild ${label}: ${IMAGE_API}:${tag} and ${IMAGE_WEB}:${tag}"
  if [[ "${PREBUILD_SKIP_PUSH:-}" == 1 ]]; then
    return
  fi
  IMAGE_API="$IMAGE_API" IMAGE_WEB="$IMAGE_WEB" TAG="$tag" GIT_SHA="$GIT_SHA" \
    ./scripts/publish-images.sh
}

restore_tree() {
  git checkout HEAD -- \
    apps \
    package.json \
    package-lock.json \
    Dockerfile \
    Dockerfile.web \
    deploy/web
}

if [[ "${1:-}" == --list ]]; then
  overlays_tsv
  exit 0
fi

apply_overlay() {
  local name=$1
  local source=$2
  local dest=$3
  if [[ -z "$source" || -z "$dest" ]]; then
    echo "prebuild-images.sh: bad overlay for $name" >&2
    exit 1
  fi
  case "$source" in
    *..*)
      echo "prebuild-images.sh: source $source must not contain .." >&2
      exit 1
      ;;
  esac
  under_hash_input "$dest"
  local src_path="$PACK_DIR/scenarios/$name/$source"
  if [[ ! -f "$src_path" ]]; then
    echo "prebuild-images.sh: overlay source not found: $src_path" >&2
    exit 1
  fi
  mkdir -p "$(dirname "$dest")"
  cp "$src_path" "$dest"
  git add -- "$dest"
}

publish_tree canonical

scenario=""
while IFS=$'\t' read -r name source dest; do
  [[ -n "$name" ]] || continue
  if [[ "$name" != "$scenario" ]]; then
    if [[ -n "$scenario" ]]; then
      publish_tree "$scenario"
    fi
    restore_tree
    scenario=$name
  fi
  apply_overlay "$name" "$source" "$dest"
done < <(overlays_tsv)

if [[ -n "$scenario" ]]; then
  publish_tree "$scenario"
fi

restore_tree
