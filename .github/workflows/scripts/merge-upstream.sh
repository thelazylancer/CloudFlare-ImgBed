#!/usr/bin/env bash
# Merge upstream main while keeping this fork's built frontend.
# frontend-dist is generated from a pinned Sanyue-ImgHub commit plus
# deploy/frontend/retention.patch. Upstream rebuilds of those hashed assets
# conflict on every UI release and must not replace fork customizations.

set -euo pipefail

upstream_ref="${1:-refs/remotes/cloudflare-imgbed-upstream/main}"

if [[ -n "${GITHUB_ACTIONS:-}" ]]; then
  git config user.name 'github-actions[bot]'
  git config user.email '41898282+github-actions[bot]@users.noreply.github.com'
fi

set +e
git merge --no-edit --no-commit "$upstream_ref"
merge_status=$?
set -e

if [[ "$merge_status" -ne 0 ]]; then
  conflicts="$(git diff --name-only --diff-filter=U || true)"
  if [[ -z "$conflicts" ]]; then
    echo "git merge failed without conflict paths." >&2
    exit "$merge_status"
  fi

  source_conflicts="$(printf '%s\n' "$conflicts" | grep -v '^frontend-dist/' || true)"
  if [[ -n "$source_conflicts" ]]; then
    echo "Source conflicts remain outside frontend-dist:" >&2
    printf '%s\n' "$source_conflicts" >&2
    exit 1
  fi
fi

restore_fork_frontend() {
  while IFS= read -r -d '' file; do
    git update-index --force-remove -- "$file"
  done < <(git ls-files -z -- frontend-dist)
  rm -rf frontend-dist
  git checkout HEAD -- frontend-dist
}

frontend_dirty=false
if [[ -n "$(git diff --name-only --diff-filter=U -- frontend-dist || true)" ]]; then
  frontend_dirty=true
fi
if ! git diff --quiet HEAD -- frontend-dist; then
  frontend_dirty=true
fi
if [[ "$frontend_dirty" == true ]]; then
  restore_fork_frontend
fi

if git diff --cached --quiet && git diff --quiet; then
  echo "Already up to date."
  exit 0
fi

if [[ -f .git/MERGE_HEAD ]] || [[ -f "$(git rev-parse --git-path MERGE_HEAD)" ]]; then
  git commit --no-edit
else
  git commit -m "Merge upstream main into fork"
fi
