#!/bin/bash
# Выкладка функции prasad-dept-recalc (питание по департаментам, мигр. 779).
# Кладёт рядом с функцией ТЕ ЖЕ файлы расчёта, что на сайте, и выкладывает её.
# Запускать после каждой правки js/kitchen-cost.js, js/eating-utils.js, js/date-utils.js,
# иначе на Кухне будет ⚠ «расчёт на сервере устарел».
set -euo pipefail
cd "$(dirname "$0")/.."

FN=supabase/functions/prasad-dept-recalc
LIB=$FN/_lib
rm -rf "$LIB"; mkdir -p "$LIB"

# окружение браузера, которого нет на сервере
echo 'globalThis.window = globalThis;' > "$LIB/env.js"
cp js/date-utils.js "$LIB/date-utils.js"
{ cat js/eating-utils.js; echo; echo 'globalThis.EatingUtils = EatingUtils;'; } > "$LIB/eating-utils.js"
{ cat js/kitchen-cost.js; echo; echo 'globalThis.KitchenCost = KitchenCost;'; } > "$LIB/kitchen-cost.js"

# отпечатки исходников — функция сверяет их с сайтом
{
  echo 'export const SOURCES = {'
  for f in js/date-utils.js js/eating-utils.js js/kitchen-cost.js; do
    echo "  \"$f\": \"$(shasum -a 256 "$f" | cut -d' ' -f1)\","
  done
  echo '};'
} > "$LIB/version.js"

set -a; source .env.local; set +a
supabase functions deploy prasad-dept-recalc --project-ref mymrijdfqeevoaocbzfy --no-verify-jwt
