#!/usr/bin/env bash
# Ticket Manager dokumani: onizleme render + PDF derleme + temizlik
# Kullanim: ./build.sh
set -euo pipefail
cd "$(dirname "$0")"

TEX="main.tex"

render() {
  local src="$1" out="$2" h="$3"
  google-chrome --headless=new --disable-gpu --no-sandbox --hide-scrollbars \
    --force-device-scale-factor=2 --window-size=640,"$h" \
    --screenshot="templates/$out" "file://$PWD/templates/$src"
  echo "render : templates/$out"
}

if command -v google-chrome >/dev/null 2>&1; then
  render "invite.html"             "preview-invite.png" 700
  render "status-under-review.html" "preview-status.png" 620
else
  echo "UYARI: google-chrome yok, mevcut PNG'ler kullaniliyor." >&2
fi

latexmk -pdf -interaction=nonstopmode -halt-on-error "$TEX"
latexmk -c "$TEX"
rm -f *.aux *.log *.out *.toc *.fls *.fdb_latexmk *.synctex.gz

echo "OK -> $TEX -> PDF"
