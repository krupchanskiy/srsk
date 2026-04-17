#!/bin/bash
# Унифицировать версию JS-скрипта во всех HTML проекта.
#
# Usage: scripts/bump-script-version.sh <filename> <version>
# Пример: scripts/bump-script-version.sh layout.js 10
#
# Заменяет во всех *.html файлах проекта все варианты:
#   <script src="...layout.js">
#   <script src="...layout.js?v=X">
# на <script src="...layout.js?v=<version>">
#
# Пересечение работает с путями ../js/, js/, ./js/ и т.п.
# Требует GNU sed совместимый (macOS: brew install gnu-sed → gsed).

set -euo pipefail

if [ $# -ne 2 ]; then
    echo "Usage: $0 <filename.js> <version>" >&2
    exit 1
fi

SCRIPT="$1"
VERSION="$2"

# выбор sed: GNU если есть, иначе macOS
SED_CMD="sed"
if [[ "$(uname)" == "Darwin" ]]; then
    if command -v gsed >/dev/null 2>&1; then
        SED_CMD="gsed"
    else
        # macOS sed — отличается по синтаксису -i
        SED_CMD="sed -i ''"
    fi
fi

# Экранируем точку в имени
SCRIPT_ESC="${SCRIPT//./\\.}"

CHANGED=0
# Находим все HTML в проекте (кроме node_modules, .git, vendor)
while IFS= read -r -d '' file; do
    # Заменяем '...SCRIPT' (без ?v=) → '...SCRIPT?v=VERSION'
    # и '...SCRIPT?v=ЧИСЛО' → '...SCRIPT?v=VERSION'
    BEFORE=$(md5 -q "$file" 2>/dev/null || md5sum "$file" | awk '{print $1}')

    # Якорь `/` перед именем файла чтобы `utils.js` не матчил `date-utils.js`
    if [[ "$SED_CMD" == "sed -i ''" ]]; then
        sed -i '' -E "s|(src=\"[^\"]*/${SCRIPT_ESC})(\?v=[0-9]+)?(\")|\1?v=${VERSION}\3|g" "$file"
    else
        $SED_CMD -i -E "s|(src=\"[^\"]*/${SCRIPT_ESC})(\?v=[0-9]+)?(\")|\1?v=${VERSION}\3|g" "$file"
    fi

    AFTER=$(md5 -q "$file" 2>/dev/null || md5sum "$file" | awk '{print $1}')
    if [[ "$BEFORE" != "$AFTER" ]]; then
        CHANGED=$((CHANGED + 1))
        echo "  ✓ $file"
    fi
done < <(find . -name "*.html" -not -path "./node_modules/*" -not -path "./.git/*" -print0)

echo
echo "Done. ${SCRIPT} → ?v=${VERSION}  (${CHANGED} файлов изменено)"
