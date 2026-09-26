#!/bin/sh
set -eu

[ "$(git branch --show-current)" = "main" ] || {
  echo "Run this script from main." >&2
  exit 1
}

[ -z "$(git status --porcelain)" ] || {
  echo "Working tree is not clean." >&2
  exit 1
}

[ "$(git remote get-url upstream 2>/dev/null || true)" = "https://github.com/jkudish/jev-mcp" ] || {
  echo "Expected upstream remote https://github.com/jkudish/jev-mcp." >&2
  exit 1
}

git fetch upstream main --tags
git fetch origin main
git merge --ff-only origin/main
git merge --no-ff --no-edit upstream/main

cat <<'EOF'
Upstream merged locally. Review, then run:
  npm ci
  npm run typecheck
  npm run build
  npm test
  git push origin main
  git push origin --tags
EOF
