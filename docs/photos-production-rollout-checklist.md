# Чеклист выката в Production (по PLAN-dev-and-photos.md)

Цель: безопасно выкатить фотогалерею с AI и Telegram уведомлениями в prod (Supabase: llttmftapmwebidgevmg, сайт: in.rupaseva.com).

**Окружение:** Production

---

## 0. Предрелизная проверка

- [ ] Dev чеклист полностью пройден (см. `docs/photos-local-testing-checklist.md`)
- [ ] Все изменения слиты в `dev`, затем PR `dev -> main` готов
- [ ] Авто-конфиг по домену работает в `js/config.js` и `guest-portal/js/portal-config.js`
- [ ] Изменения протестированы на `dev.rupaseva.com` (если включен Vercel)
- [ ] Подготовлен rollback план (откат на предыдущий commit в `main`)

---

## 1. База данных (Prod)

### 1.1 Миграции
- [ ] Применить миграции 108-122 на `llttmftapmwebidgevmg`:
  ```bash
  supabase db push --project-ref llttmftapmwebidgevmg --file supabase/108_face_recognition_tables.sql
  supabase db push --project-ref llttmftapmwebidgevmg --file supabase/109_retreat_photos_storage_policies.sql
  supabase db push --project-ref llttmftapmwebidgevmg --file supabase/110_photos_translations.sql
  supabase db push --project-ref llttmftapmwebidgevmg --file supabase/111_retreat_photos_add_fields_and_fix_policies.sql
  supabase db push --project-ref llttmftapmwebidgevmg --file supabase/112_fix_retreat_photos_trigger.sql
  supabase db push --project-ref llttmftapmwebidgevmg --file supabase/113_add_updated_at_to_retreat_photos.sql
  supabase db push --project-ref llttmftapmwebidgevmg --file supabase/114_add_faces_count_to_retreat_photos.sql
  supabase db push --project-ref llttmftapmwebidgevmg --file supabase/115_photos_indexing_translations.sql
  supabase db push --project-ref llttmftapmwebidgevmg --file supabase/116_retreat_photos_update_policy.sql
  supabase db push --project-ref llttmftapmwebidgevmg --file supabase/117_enable_realtime_retreat_photos.sql
  supabase db push --project-ref llttmftapmwebidgevmg --file supabase/118_telegram_notifications.sql
  supabase db push --project-ref llttmftapmwebidgevmg --file supabase/119_add_telegram_chat_id.sql
  supabase db push --project-ref llttmftapmwebidgevmg --file supabase/120_create_telegram_link_tokens.sql
  supabase db push --project-ref llttmftapmwebidgevmg --file supabase/121_fix_photo_cascade_delete.sql
  supabase db push --project-ref llttmftapmwebidgevmg --file supabase/122_fix_retreat_photos_rls_for_superusers.sql
  ```
- [ ] Проверить наличие таблиц:
  - `retreat_photos`, `photo_faces`, `face_tags`, `face_search_log`
- [ ] Проверить RLS политики для `retreat_photos`, `photo_faces`, `face_tags`
- [ ] Проверить миграции 116/117/121/122 (update policy, realtime, cascade, superuser)

### 1.2 Данные и роли
- [ ] Permission `upload_photos` существует
- [ ] Роль "Фотограф" связана с `upload_photos`
- [ ] Пользователь(и) фотографов назначены
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
  WHERE name = 'Фотограф'
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
- [ ] IAM user `srsk-rekognition` активен
- [ ] Secrets заданы в Supabase prod:
  - `AWS_ACCESS_KEY_ID`
  - `AWS_SECRET_ACCESS_KEY`
  - `AWS_REGION` = `ap-south-1`
- [ ] Коллекции создаются автоматически на ретрит (retreat_<id>)
  ```bash
  supabase secrets set --project-ref llttmftapmwebidgevmg AWS_ACCESS_KEY_ID=***
  supabase secrets set --project-ref llttmftapmwebidgevmg AWS_SECRET_ACCESS_KEY=***
  supabase secrets set --project-ref llttmftapmwebidgevmg AWS_REGION=ap-south-1
  ```

### 3.2 Telegram
- [ ] `TELEGRAM_BOT_TOKEN` задан в prod
- [ ] `TELEGRAM_WEBHOOK_SECRET` задан в prod
- [ ] Webhook зарегистрирован на prod URL
- [ ] Проверена команда `/help` у бота
  ```bash
  supabase secrets set --project-ref llttmftapmwebidgevmg TELEGRAM_BOT_TOKEN=***
  supabase secrets set --project-ref llttmftapmwebidgevmg TELEGRAM_WEBHOOK_SECRET=***
  ```
  ```bash
  curl -X POST "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \\
    -d "url=https://llttmftapmwebidgevmg.supabase.co/functions/v1/telegram-webhook?secret=<TELEGRAM_WEBHOOK_SECRET>"
  ```

---

## 4. Edge Functions (Prod)

- [ ] Деплой функций:
  - `index-faces` (`--no-verify-jwt`)
  - `search-face` (`--no-verify-jwt`)
  - `delete-photos` (`--no-verify-jwt`)
  - `telegram-webhook` (`--no-verify-jwt`)
  - `send-notification` (`--no-verify-jwt`)
- [ ] Проверка логов после деплоя (нет ошибок старта)
  ```bash
  supabase functions deploy index-faces --project-ref llttmftapmwebidgevmg --no-verify-jwt
  supabase functions deploy search-face --project-ref llttmftapmwebidgevmg --no-verify-jwt
  supabase functions deploy delete-photos --project-ref llttmftapmwebidgevmg --no-verify-jwt
  supabase functions deploy telegram-webhook --project-ref llttmftapmwebidgevmg --no-verify-jwt
  supabase functions deploy send-notification --project-ref llttmftapmwebidgevmg --no-verify-jwt

  supabase functions list --project-ref llttmftapmwebidgevmg
  supabase functions logs index-faces --project-ref llttmftapmwebidgevmg --level error
  ```

---

## 5. Frontend (Prod)

- [ ] `main` обновлен, GitHub Pages задеплоен
- [ ] `in.rupaseva.com` открывается без ошибок
- [ ] Проверка конфигурации окружения:
  - prod URL использует prod Supabase keys
  - dev URL не попадает в prod

---

## 6. Smoke тесты в Production

### 6.1 Фотограф
- [ ] Войти как фотограф
- [ ] Загрузить 3-5 фото
- [ ] Проверить `retreat_photos` и `index_status`
- [ ] Проверить индексацию (index-faces лог)

### 6.2 Гость
- [ ] Войти как гость ретрита
- [ ] Открыть `guest-portal/photos.html`
- [ ] Нажать "Найти себя" (с проф. фото или селфи)
- [ ] Убедиться, что фильтр работает и фото подсвечены

### 6.3 Telegram
- [ ] Подключить бота через Guest Portal
- [ ] Получить уведомление о новых фото
- [ ] (Опционально) получить уведомление о найденных фото

### 6.4 Удаление
- [ ] Удалить 1 фото как фотограф
- [ ] Проверить удаление из Storage, `photo_faces`, `face_tags`

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
