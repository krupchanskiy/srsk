# Чеклист выката в Production (по PLAN-dev-and-photos.md)

Цель: безопасно выкатить фотогалерею с AI и Telegram уведомлениями в prod (Supabase: llttmftapmwebidgevmg, сайт: in.rupaseva.com).

**Окружение:** Production

---

## 0. Предрелизная проверка

- [x] Dev чеклист полностью пройден (см. `docs/photos-local-testing-checklist.md`)
- [x] Все изменения слиты в `dev`, затем PR `dev -> main` готов
- [x] Авто-конфиг по домену работает в `js/config.js` и `guest-portal/js/portal-config.js`
- [x] Изменения протестированы на `dev.rupaseva.com` (если включен Vercel)
- [] Подготовлен rollback план (откат на предыдущий commit в `main`)

---

## 1. База данных (Prod)

### 1.1 Миграции

Применять через MCP (`mcp__supabase__apply_migration`) или Supabase Dashboard → SQL Editor. Флага `--file` в Supabase CLI нет.

- [x] Применить миграции 108–128 на `llttmftapmwebidgevmg`:

| № | Файл | Что делает |
|---|------|------------|
| 108 | `108_face_recognition_tables.sql` | Таблицы retreat_photos, photo_faces, face_tags, face_search_log |
| 109 | `109_retreat_photos_storage_policies.sql` | RLS для Storage bucket retreat-photos |
| 110 | `110_photos_translations.sql` | Переводы UI |
| 111 | `111_retreat_photos_add_fields_and_fix_policies.sql` | Поля uploaded_by, day_number, caption; обновление RLS |
| 112 | `112_fix_retreat_photos_trigger.sql` | Исправление триггера updated_at |
| 113 | `113_add_updated_at_to_retreat_photos.sql` | Поле updated_at |
| 114 | `114_add_faces_count_to_retreat_photos.sql` | Поле faces_count |
| 115 | `115_photos_indexing_translations.sql` | Переводы прогресса индексации |
| 116 | `116_retreat_photos_update_policy.sql` | UPDATE policy для retreat_photos |
| 117 | `117_enable_realtime_retreat_photos.sql` | Realtime для retreat_photos |
| 118 | `118_add_thumb_path_to_retreat_photos.sql` | Поле thumb_path (превью) |
| 119 | `119_add_telegram_chat_id_to_vaishnavas.sql` | Поле telegram_chat_id в vaishnavas |
| 120 | `120_telegram_link_tokens.sql` | Таблица одноразовых токенов привязки Telegram |
| 121 | `121_fix_photo_cascade_delete.sql` | Каскадное удаление photo_faces и face_tags |
| 122 | `122_fix_retreat_photos_rls_for_superusers.sql` | RLS для суперпользователей |
| 123 | `123_allow_users_update_telegram_chat_id.sql` | Разрешить пользователям обновлять telegram_chat_id |
| 124 | `124_add_missing_photo_translations.sql` | Дополнительные переводы управления фото |
| 127 | `127_fix_retreat_photos_deletion.sql` | Исправление удаления фото (каскад через Edge Function) |
| 128 | `128_face_tags_rejected.sql` | Поле rejected в face_tags (мягкое удаление отметки "Вы") |

- [x] Проверить наличие таблиц:
  ```sql
  SELECT table_name FROM information_schema.tables
  WHERE table_name IN ('retreat_photos','photo_faces','face_tags','face_search_log','telegram_link_tokens');
  ```
- [x] Проверить RLS политики для `retreat_photos`, `photo_faces`, `face_tags`
- [x] Проверить поле `rejected` в `face_tags`:
  ```sql
  SELECT column_name, data_type, column_default
  FROM information_schema.columns
  WHERE table_name = 'face_tags' AND column_name = 'rejected';
  ```

### 1.2 Данные и роли
- [x] Permission `upload_photos` существует
- [x] Роль "Фотограф" связана с `upload_photos`
- [x] Пользователь(и) фотографов назначены
  ```sql
  INSERT INTO public.permissions (code, name_ru, name_en, name_hi, category)
  VALUES ('upload_photos', 'Загрузка фотографий', 'Upload photos', 'फ़ोटो अपलोड करें', 'photos')
  ON CONFLICT (code) DO NOTHING;

  INSERT INTO public.role_permissions (role_id, permission_id)
  SELECT r.id, p.id
  FROM public.roles r
  CROSS JOIN public.permissions p
  WHERE r.name = 'Фотограф' AND p.code = 'upload_photos'
  ON CONFLICT DO NOTHING;

  INSERT INTO public.user_roles (user_id, role_id, is_active)
  SELECT '<user_id>', id, true
  FROM public.roles
  WHERE name_ru = 'Фотограф'
  ON CONFLICT DO NOTHING;
  ```

---

## 2. Storage (Prod)

- [ ] Bucket `retreat-photos` создан
- [ ] Bucket public (для Image Transform)
- [ ] Max file size >= 50MB
- [ ] MIME types: `image/jpeg`, `image/png`, `image/jpg`
- [ ] Storage политики используют `current_user_has_upload_permission()`
  ```bash
  supabase storage create retreat-photos --project-ref llttmftapmwebidgevmg --public
  ```

---

## 3. Secrets и внешние сервисы (Prod)

### 3.1 AWS Rekognition
- [x] IAM user `srsk-rekognition` активен
- [x] Secrets заданы в Supabase prod:
  - `AWS_ACCESS_KEY_ID`
  - `AWS_SECRET_ACCESS_KEY`
  - `AWS_REGION` = `ap-south-1`
- [x] Коллекции создаются автоматически на ретрит (retreat_<id>)
  ```bash
  supabase secrets set --project-ref llttmftapmwebidgevmg AWS_ACCESS_KEY_ID=***
  supabase secrets set --project-ref llttmftapmwebidgevmg AWS_SECRET_ACCESS_KEY=***
  supabase secrets set --project-ref llttmftapmwebidgevmg AWS_REGION=ap-south-1
  ```

### 3.2 Telegram
- [x] `TELEGRAM_BOT_TOKEN` задан в prod
- [x] `TELEGRAM_WEBHOOK_SECRET` задан в prod
- [x] Webhook зарегистрирован на prod URL
- [x] Проверена команда `/help` у бота
  ```bash
  supabase secrets set --project-ref llttmftapmwebidgevmg TELEGRAM_BOT_TOKEN=***
  supabase secrets set --project-ref llttmftapmwebidgevmg TELEGRAM_WEBHOOK_SECRET=***
  ```
  ```bash
  curl -X POST "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
    -d "url=https://llttmftapmwebidgevmg.supabase.co/functions/v1/telegram-webhook?secret=<TELEGRAM_WEBHOOK_SECRET>"
  ```
- [x] Проверить, что уведомление о найденных фото отправляется с корректным кол-вом (без учёта rejected=true)

---

## 4. Edge Functions (Prod)

- [x] Деплой всех функций:
  ```bash
  supabase functions deploy index-faces --project-ref llttmftapmwebidgevmg --no-verify-jwt
  supabase functions deploy search-face --project-ref llttmftapmwebidgevmg --no-verify-jwt
  supabase functions deploy delete-photos --project-ref llttmftapmwebidgevmg --no-verify-jwt
  supabase functions deploy telegram-webhook --project-ref llttmftapmwebidgevmg --no-verify-jwt
  supabase functions deploy send-notification --project-ref llttmftapmwebidgevmg --no-verify-jwt
  ```
- [x] Проверить список функций:
  ```bash
  supabase functions list --project-ref llttmftapmwebidgevmg
  ```
- [x] Проверить логи на старте (нет ошибок):
  ```bash
  supabase functions logs index-faces --project-ref llttmftapmwebidgevmg --level error
  supabase functions logs search-face --project-ref llttmftapmwebidgevmg --level error
  supabase functions logs delete-photos --project-ref llttmftapmwebidgevmg --level error
  supabase functions logs telegram-webhook --project-ref llttmftapmwebidgevmg --level error
  supabase functions logs send-notification --project-ref llttmftapmwebidgevmg --level error
  ```

---

## 5. Frontend (Prod)

- [x] `main` обновлен, GitHub Pages задеплоен
- [x] `in.rupaseva.com` открывается без ошибок
- [x] Проверка конфигурации окружения:
  - prod URL использует prod Supabase keys
  - dev URL не попадает в prod

---

## 6. Smoke тесты в Production

### 6.1 Фотограф
- [x] Войти как фотограф
- [x] Загрузить 3-5 фото
- [x] Проверить `retreat_photos` и `index_status`
- [x] Проверить индексацию (index-faces лог)

### 6.2 Гость
- [x] Войти как гость ретрита
- [x] Открыть `guest-portal/photos.html`
- [x] Нажать "Найти себя" (с проф. фото или селфи)
- [x] Убедиться, что фильтр работает и фото подсвечены бейджем "Вы"
- [x] Навести на бейдж "Вы" — он меняется на "Не я"
- [x] Нажать "Не я" — отметка снимается, фото исчезает из фильтра
- [] Нажать "Найти себя" повторно — снятая отметка не возвращается
- [x] На главной странице гостевого портала виден блок "Фото со мной" (если есть фото)

### 6.3 Telegram
- [x] Подключить бота через Guest Portal
- [x] Получить уведомление о новых фото
- [x] (Опционально) получить уведомление о найденных фото

### 6.4 Удаление
- [x] Удалить 1 фото как фотограф
- [x] Проверить удаление из Storage, `photo_faces`, `face_tags`

---

## 7. Мониторинг после выката

- [ ] Edge Functions logs без ошибок 5xx
- [ ] Нет массовых `index_status = failed`
- [ ] Отсутствуют зависшие `processing` > 20 сек
- [ ] В Telegram нет всплеска 403/429

---

## 8. Что добавить/проверить вручную

- [ ] Проверить переводы UI (RU/EN/HI) после деплоя
- [ ] Проверить CDN Image Transform URL (thumbnail + full)
- [ ] Проверить лимиты Rekognition (1-2 сек поиск)
- [ ] Проверить, что public доступ к фото ограничен RLS (неавторизованные не видят)

---

## Итог

Если smoke-тесты и мониторинг пройдены, выкат в Production завершен.
