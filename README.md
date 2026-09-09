# AB Kitchen for macOS

Отдельное настольное приложение кухни Ашрама Бхактиведанты. Оно содержит только процессы кухни и склада, использует production Supabase BackOffice и не загружает публичный сайт.

## Первый запуск на macOS

Требования: macOS 12+, Node.js 22 LTS, npm, Xcode Command Line Tools.

```bash
npm install
npm run verify
npm start
```

## Сборка

```bash
npm run dist:mac
```

Результат появится в `dist/`: DMG и ZIP для архитектуры текущего Mac. Пока приложение не подписано Apple Developer ID, macOS может показать предупреждение Gatekeeper.

## Архитектура

- `electron/main.cjs` — безопасное окно macOS и локальный протокол `abkitchen://`.
- `app/` — изолированный снимок кухонного интерфейса.
- `app/login.html` — отдельный вход с серверной проверкой `has_ab_kitchen_access()`.
- `supabase/` — миграции роли, RLS и скрытых продуктов, уже применённые в production.
- `HANDOVER.md` — контекст продолжения разработки.

Никакие service-role ключи, пароли или management-токены в проект не включены. Публичный Supabase anon key находится в `app/js/config.js`, как и в браузерном клиенте.
