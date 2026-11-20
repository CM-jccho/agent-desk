#!/bin/bash

cd -- "$(/usr/bin/dirname -- "$0")" || exit 1
export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin"

if ! command -v node >/dev/null 2>&1 ||
  ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)'; then
  printf '\nAgent Desk를 시작하려면 Node.js 24 이상이 필요합니다.\n'
  printf 'https://nodejs.org/en/download 에서 macOS용 설치 파일을 받은 후 다시 실행하세요.\n\n'
  if [[ -t 0 ]]; then
    read -r -p 'Enter를 누르면 종료합니다. '
  fi
  exit 1
fi

exec node server.mjs --open
