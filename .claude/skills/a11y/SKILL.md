---
name: a11y
description: Проверка доступности страниц ШРСК по WCAG 2.1 AA через axe-core — автоматический прогон Playwright по предпросмотрам и разовая проверка любой открытой страницы во встроенном браузере. Использовать после правок вёрстки, цвета, форм и при жалобах «плохо видно», «не нажимается», «не читается».
---

# Доступность (axe-core)

Два способа: прогон тестами (повторяемый, по всем страницам и ширинам)
и разовая проверка страницы во встроенном браузере.

## 1. Прогон тестами

Нужны локальные `package.json` и `playwright.config.js` (оба в `.gitignore`).
Если их нет — поставить:

```bash
npm i -D @playwright/test @axe-core/playwright serve
npx playwright install chromium
```

Конфиг поднимает свой сервер на **порту 3098**: на 3000 часто висит
другой проект, и тесты молча ходили бы по чужому сайту.

```bash
node tests/make-worship-previews.cjs     # собрать предпросмотры
npm run test:a11y                        # все страницы × компьютер/планшет/телефон
npx playwright test tests/a11y.spec.js --project=телефон   # одна ширина
```

Предпросмотры `tests/preview-*.html` — боевая разметка и скрипты с подменённым
слоем данных (`tests/worship-preview-mock.js`) и словарём
(`tests/worship-preview-i18n.js`). Роль задаётся параметром
`?роль=старший|пуджари|волонтёр`. Вход в систему не нужен.

Отчёт: `test-results/отчёт/index.html`. Тест падает только на нарушениях
`serious` и `critical`; `moderate` и `minor` смотреть в отчёте.

## 2. Разовая проверка во встроенном браузере

На открытой странице (любой, в том числе боевой после входа):

```js
if (!window.axe) await new Promise((ok, fail) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/axe-core@4.10.2/axe.min.js';
    s.onload = ok; s.onerror = fail; document.head.appendChild(s);
});
const r = await axe.run(document, { runOnly: { type: 'tag',
    values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } });
r.violations.map(v => ({ id: v.id, важность: v.impact, узлов: v.nodes.length,
    пример: v.nodes[0]?.target.join(' ') }))
```

## Ловушки этого проекта

- **Контраст.** В `css/common.css` прозрачность `opacity-30…70` внутри `main`
  поднята до читаемой. Серый текст на сером фоне страницы (`bg-base-200`)
  проверять отдельно — норма 4.5:1, для крупного текста 3:1.
- **Цвет модуля** (`--current-color`) задаётся из `color-init.js`: белый текст
  на нём проверять для каждого модуля, цвета разные.
- **`<summary>` — уже интерактивный.** Ссылки и кнопки внутри него —
  нарушение `nested-interactive`. Выносить рядом.
- **`<select>` без подписи** — `aria-label` или `<label>`.
- **Иконка-ссылка** (логотип, «⋮», звёздочка) — нужен `aria-label`.
- Атрибут `hidden` в проекте принудительный (`[hidden]{display:none!important}`),
  скрытое axe не проверяет — это нормально.
- Составные `data-` атрибуты на кириллице читать через `getAttribute`,
  `dataset` их не склеивает.
