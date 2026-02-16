# Чеклист локального тестирования (по PLAN-dev-and-photos.md)

Цель: проверить реализованный функционал Фаз 1-3 в Dev окружении (Supabase dev: vzuiwpeovnzfokekdetq) и локальном UI.

**Окружение:** Dev + localhost

---

## 0. Предусловия

- [x] Dev Supabase проект доступен: `vzuiwpeovnzfokekdetq`
- [x] Ветка/сборка содержит актуальный код
- [x] Локальный сервер запущен: `npm run serve` (http://localhost:3000)
- [x] Применены миграции 108-122 в Dev
- [x] Storage bucket `retreat-photos` существует и public
- [x] Edge Functions задеплоены в Dev:
  - `index-faces`
  - `search-face`
  - `delete-photos`
  - `telegram-webhook`
  - `send-notification`
- [x] Secrets заданы в Dev Supabase:
  - `AWS_ACCESS_KEY_ID`
  - `AWS_SECRET_ACCESS_KEY`
  - `AWS_REGION` = `ap-south-1`
  - `TELEGRAM_BOT_TOKEN`
  - `TELEGRAM_WEBHOOK_SECRET`
- [] Telegram Webhook зарегистрирован на Dev URL
- [x] Роль/permission `upload_photos` существует и назначена фотографу
- [x] В `js/config.js` и `guest-portal/js/portal-config.js` включен auto-env (dev по `localhost`, `dev.*`, `vercel.app`)

---

## 1. Подготовка тестовых данных

- [x] Создать тестовый ретрит
- [x] Создать 3-5 гостей и регистрации на ретрит
- [x] Создать тестового фотографа с permission `upload_photos`

---

## 2. Фаза 1: Фотогалерея без AI

### 2.1 Доступы
- [x] Фотограф: доступ к `photos/upload.html` и `photos/manage.html`
- [x] Суперпользователь: доступ есть (через `has_permission`)
- [x] Обычный гость: нет доступа к `photos/*`

### 2.2 Загрузка фото (upload.html)
- [x] Загрузка 1 фото < 5MB
- [x] Загрузка фото > 5MB (клиентская компрессия)
- [x] Batch загрузка 10+ фото
- [x] Неверный формат (txt/pdf) дает ошибку
- [x] В БД создаются записи `retreat_photos` со статусом `pending`
- [x] В Storage появляются файлы `retreat-photos/<retreat_id>/<photo_id>.jpg`

### 2.3 Галерея гостя (guest-portal/photos.html)
- [x] Гость видит только фото своих ретритов (RLS)
- [x] Работает lightbox, навигация и скачивание
- [x] Прямая ссылка к чужому ретриту недоступна

### 2.4 Управление (manage.html)
- [x] Список фото загружается
- [x] Удаление одного фото удаляет Storage + БД + `photo_faces`/`face_tags` (CASCADE)
- [x] Массовое удаление работает
- [x] Realtime обновления в двух вкладках

---

## 3. Фаза 2: AI распознавание лиц

### 3.1 Индексация лиц (index-faces)
- [x] После загрузки фото запускается индексация автоматически
- [x] `index_status` переходит `pending -> processing -> indexed`
- [x] `faces_count` заполняется для фото с лицами
- [x] Фото без лиц: `faces_count = 0`, статус `indexed`
- [x] Ошибки: `index_status = failed`, `index_error` заполнен
- [x] Повторная индексация работает (кнопка "Переиндексировать")
- [x] При повторе старые `photo_faces` удаляются (нет duplicate key)
- [x] Детект зависших фото > 20 сек возвращает в `pending`
- [x] Остановка после 10 подряд ошибок (защита от бесконечного polling)

### 3.2 Поиск лица (search-face)
- [x] Гость с `vaishnavas.photo_url` может искать без загрузки селфи
- [x] Если фото нет, открывается file picker
- [x] Поиск завершает за 1-2 сек и фильтрует галерею
- [x] Срабатывает порог similarity 80%
- [x] `face_tags` создаются при первом поиске
- [x] Повторный поиск использует кэш (`face_tags`), AWS не вызывается
- [x] Сообщение "не найдено" при отсутствии совпадений

---

## 4. Фаза 3: Telegram бот + уведомления

### 4.1 Подключение бота
- [x] В Guest Portal доступна кнопка "Подключить Telegram"
- [x] Создается `telegram_link_tokens` (used=false, expires_at ~15 мин)
- [x] Deep link открывает бота `/start TOKEN`
- [x] `vaishnavas.telegram_chat_id` заполняется
- [x] Polling обновляет UI до "Подключен"

### 4.2 Команды
- [x] `/help` отвечает корректно
- [x] `/stop` очищает `telegram_chat_id`
- [x] Неверный/использованный/просроченный токен дает ошибку

### 4.3 Уведомления
- [x] После загрузки фото фотографом приходит broadcast всем подключенным
- [x] После "Найти себя" приходит уведомление (если включено в ТЗ)
- [ ] Rate limit 25 msg/sec соблюдается
- [ ] Retry при 429/timeout работает, 403 очищает chat_id

---

## 5. Интеграционный прогон (минимум)

- [x] Фотограф загрузил 20+ фото
- [x] Индексация завершилась без ошибок
- [x] Гость нашел себя, фильтр применился
- [x] Telegram уведомления пришли
- [x] Удаление 2-3 фото удаляет всё корректно

---

## 6. Логи и контроль

- [x] Edge Functions logs без критических ошибок
- [x] В БД нет зависших `processing` > 20 сек
- [x] Нет бесконечных вызовов Edge Functions

---

## Итог

Если все пункты пройдены, функционал готов к выкату в Production.
