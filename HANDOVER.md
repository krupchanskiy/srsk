# Handover: AB Kitchen macOS

## Цель

Продолжать AB Kitchen как отдельное приложение macOS. Публичный BackOffice Шри Рупа Сева Кунджи больше не является точкой входа в AB Kitchen.

## Состояние на 9 сентября 2026

- В приложение перенесены меню, планировщик, шаблоны, рецепты, продукты, склад, заявки, поступления, выдачи и инвентаризации.
- Локация всегда зафиксирована на `ab-kitchen`.
- Авторизация использует production Supabase и требует RPC `has_ab_kitchen_access()`.
- Данные остаются в той же базе, что и BackOffice; RLS ограничивает операционные таблицы локацией AB Kitchen.
- Генератор меню создаёт промпт без вызова платной LLM.
- Карточку рассчитанного приёма пищи можно сохранить/передать как PNG.
- Удаление продукта в AB Kitchen означает локальное скрытие, а не удаление общего продукта и рецептуры.

## Получение проекта на Mac

До переноса в отдельный GitHub-репозиторий проект хранится как самостоятельная
ветка с отдельной историей:

```bash
git clone --single-branch --branch ab-kitchen-macos \
  git@github.com:krupchanskiy/srsk.git AB-Kitchen-macOS
cd AB-Kitchen-macOS
```

Веб-удаление подготовлено отдельно в ветке `codex/remove-ab-kitchen-web` и не
входит в историю desktop-приложения.

## Что проверить первым на Mac

1. `npm install && npm run verify`.
2. `npm start` и вход существующим администратором AB Kitchen.
3. Все вкладки кухни и склада.
4. Сохранение/редактирование рецепта и продукта на тестовой записи.
5. Формирование промпта меню.
6. Создание PNG-карточки и отправку через macOS Share/Telegram/WhatsApp. Сейчас браузерный Web Share имеет fallback на сохранение файла; нативный Share Sheet можно добавить через отдельный Electron bridge.
7. `npm run dist:mac` на Apple Silicon и запуск собранного приложения.

## Не делать

- Не добавлять service-role key или Supabase management token в приложение.
- Не ослаблять RLS ради работы desktop-клиента.
- Не возвращать ссылку AB Kitchen в публичный BackOffice.
- Не делать cascade delete для `products` → `recipe_ingredients`.

## Следующие технические задачи

- Добавить собственную `.icns` и Apple Developer ID signing/notarization.
- Перевести CDN-зависимости Tailwind/DaisyUI/Supabase JS в локальный bundle для полностью автономного запуска интерфейса.
- Добавить нативный macOS Share Sheet для PNG.
- Добавить автоматическую сборку universal DMG (`arm64` + `x64`) в GitHub Actions.
