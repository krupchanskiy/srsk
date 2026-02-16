---
title: "feat: Улучшения гостевого портала — Telegram, фото со мной, отмена отметки"
type: feat
date: 2026-02-15
---

# feat: Улучшения гостевого портала — Telegram, фото со мной, отмена отметки

## Обзор

Три независимых улучшения гостевого портала, каждое из которых реализуется отдельно.

---

## Задача 1 — Плашка Telegram: перенести рядом с ником в profile-card

### Что сделать

`#telegram-card` сейчас отдельный блок `md:col-span-3` вне `#profile-card`.
Нужно убрать его оттуда и встроить **внутрь карточки профиля**, под строкой с `#profile-telegram` (ником).

### Текущий DOM

```
grid (верхняя сетка)
  ├─ #profile-card (md:col-span-1)  ← зелёная карточка
  │     ├─ #profile-telegram        ← строка с ником @username
  │     └─ (кнопки редактирования)
  └─ #telegram-card (md:col-span-3) ← БОЛЬШАЯ синяя плашка, отдельно
```

### Целевой DOM

```
#profile-card (md:col-span-1)
  ├─ #profile-telegram   ← ник
  └─ #telegram-mini      ← компактная встроенная плашка (статус + кнопка)
      (убрать #telegram-card из сетки или оставить скрытым)
```

### Детали реализации

**HTML (`guest-portal/index.html`):**
- Добавить компактный блок после `#profile-telegram` (строки 246–251):
  - Статус: "Уведомления подключены" / "Подключить уведомления"
  - Кнопка "Подключить" / "Отключить" — небольшая, в стиле карточки профиля
- Скрыть или удалить `#telegram-card` (строки 385–418)

**JS (`portal-index.js`):**
- `checkTelegramStatus()` — обновить, чтобы управлял новыми элементами
- `connectTelegram()`, `disconnectTelegram()` — переключить рефы на новые ID
- Визуальный стиль: белый текст / `bg-white/20` как остальные контакты в карточке

### Оценка сложности

**Простая задача.** Только перенос HTML + адаптация JS-рефов. Никаких запросов к БД, Edge Functions, новых таблиц.

| Что | Файлов | Строк изменений |
|-----|--------|----------------|
| HTML перенос | 1 | ~30–40 строк (убрать плашку, добавить мини-блок) |
| JS адаптация | 1 | ~10–20 строк (новые getElementById) |

**Время на реализацию (Claude Code): ~15–25 мин**

---

## Задача 2 — Секция "Фото со мной" на главной гостя

### Что сделать

На главной странице (`index.html`) существует блок галереи (`#galleryPreview`) — показывает последние фото ретрита с горизонтальной прокруткой.

Нужно **добавить вторую секцию** аналогичного вида, но отображающую **только фото, где есть текущий гость** (из `face_tags`).

### Логика данных

Данные уже загружаются в `loadPhotoGalleryPreview()` (`portal-index.js`, строки 1160–1298):
- `myPhotoIds` уже вычислен (строки 1218–1226) через запрос к `face_tags`
- `myPhotos` уже отфильтрован (строки 1232–1248) и передаётся в `renderPhotoPreview()`

Т.е. **данные уже есть**, нужно только:
1. Выделить их в отдельный рендер-вызов
2. Добавить соответствующий HTML-контейнер

### HTML-структура новой секции (после существующего блока галереи, строки 712–743)

```html
<!-- Фото со мной -->
<div id="my-photos-section" class="card mb-4 hidden border-2 border-transparent hover:border-orange-300 transition-all cursor-pointer" style="background: #FFF7ED;" onclick="window.location.href='photos.html?filter=me'">
    <div class="flex items-center justify-between mb-4">
        <div>
            <div class="card-label mb-1" style="color: #EA7B2E;">Фото ретрита</div>
            <div class="text-xl font-semibold text-gray-800">Фото со мной</div>
        </div>
        <a href="photos.html?filter=me" ...>Все мои фото</a>
    </div>
    <div id="myPhotosPreview" class="relative">
        <div id="myPhotosContainer" class="flex gap-3 overflow-x-auto hide-scrollbar pb-2 snap-x snap-mandatory"></div>
    </div>
</div>
```

### JS-изменения (`portal-index.js`)

- Обновить `renderPhotoPreview()` или добавить `renderMyPhotosPreview()`:
  - Взять из `myPhotoIds` первые 10 фото
  - Рендерить миниатюры в `#myPhotosContainer`
  - Показать `#my-photos-section` если `myPhotoIds.length > 0`
- Ссылка ведёт на `photos.html?filter=me` — можно сразу включить фильтр "Фото со мной"

**Опционально:** обработка `?filter=me` в `photos.html` — автоматически включить чекбокс `#myPhotosOnly` при загрузке страницы (1 строка).

### Оценка сложности

**Простая задача.** Данные уже загружаются, нужен только новый рендер + HTML-контейнер.

| Что | Файлов | Строк |
|-----|--------|-------|
| HTML секция | 1 | ~20–30 строк |
| JS рендер | 1 | ~20–30 строк |
| Авто-фильтр в photos.html | 1 | ~5 строк |

**Время на реализацию (Claude Code): ~20–30 мин**

---

## Задача 3 — Отмена отметки на фото в галерее

### Что сделать

Когда система (AWS Rekognition) нашла гостя на фото и проставила `face_tags`, гость должен иметь возможность **убрать свою отметку**, если не согласен.

### Текущее состояние

- Фото с отметкой: оранжевая рамка `ring-4 ring-srsk-orange` + бейдж "Вы" (`guest-portal/photos.html`, строка 580–584)
- Нет кнопки отмены

### Целевое поведение

При просмотре фото в **lightbox** (или на карточке) — кнопка/иконка "Это не я" / "Убрать отметку":
- Удаляет запись из `face_tags` для `(photo_id, vaishnava_id = currentGuest.id)`
- Убирает бейдж "Вы" и оранжевую рамку с карточки
- Обновляет счётчик `myPhotos`

### Требования к БД (RLS)

**Текущее состояние RLS для `face_tags`:**
- SELECT: всем (true) — уже есть
- INSERT/UPDATE/DELETE: только `service_role` (Edge Functions) — **нет DELETE для authenticated пользователя**

**Нужна новая миграция** (128_face_tags_delete_own.sql):
```sql
-- Разрешить пользователю удалять свои отметки
CREATE POLICY "face_tags_delete_own"
ON public.face_tags
FOR DELETE
TO authenticated
USING (
  (select auth.uid()) in (
    select v.auth_user_id
    from public.vaishnavas v
    where v.id = face_tags.vaishnava_id
  )
);
```

> Или через `vaishnavas.auth_user_id`, нужно проверить схему. Если связи нет — через `vaishnavas` с join по `portal_guests`.

### UX в lightbox

Добавить в `#lightbox` кнопку, видимую только когда `isMine === true`:
```html
<button id="removeMeBtn" class="hidden absolute bottom-20 right-5 ...">
    Убрать отметку
</button>
```

В `updateLightbox()`:
- показать/скрыть кнопку по `myPhotos.includes(photo.id)`

Функция `removeMyTag(photoId)`:
```javascript
async function removeMyTag(photoId) {
    const { error } = await supabase
        .from('face_tags')
        .delete()
        .eq('photo_id', photoId)
        .eq('vaishnava_id', window.currentGuest.id);
    if (!error) {
        myPhotos = myPhotos.filter(id => id !== photoId);
        applyFilters(); // перерисовать
        updateLightbox(); // обновить кнопку
    }
}
```

### Оценка сложности

**Средняя задача.** Нужна миграция БД (RLS), изменения в UI lightbox и функция удаления.

| Что | Файлов | Строк |
|-----|--------|-------|
| Миграция RLS | 1 новый | ~15 строк SQL |
| Кнопка в lightbox HTML | 1 | ~10 строк |
| JS функция removeMyTag | 1 | ~20 строк |
| Показ/скрытие кнопки в updateLightbox | 1 | ~5 строк |

**Дополнительно:** нужно проверить, как `currentGuest.id` (UUID вайшнава) соотносится с `auth.uid()` — это определяет точную форму RLS политики.

**Время на реализацию (Claude Code): ~30–40 мин**

---

---

## Задача 4 — Вкладка "Поиск человека" в модуле Фото (для фотографа / суперпользователя)

### Что сделать

Добавить новую вкладку в `photos/manage.html` — "Поиск человека" — где персонал может запустить поиск конкретного вайшнава на фото ретрита, аналогично тому, как это делает сам гость.

### Текущая структура manage.html

Страница без вкладок: Retreat Selector → прогресс индексации → статистика → сетка фото.
Нужно ввести **tab-навигацию** с двумя вкладками:
- "Управление" (текущий контент)
- "Поиск человека" (новый контент)

### UI новой вкладки

```
[Вкладка: Управление] [Вкладка: Поиск человека]

┌──────────────────────────────────────────┐
│  Ретрит: [выпадающий список]             │  ← общий с управлением или отдельный
│                                           │
│  Вайшнав: [поиск/выпадающий список]      │
│  [Фото из профиля или загрузить своё]    │
│                                           │
│  [ Найти этого человека ]                 │
└──────────────────────────────────────────┘

  Найдено: 12 фото
  ┌─────┐ ┌─────┐ ┌─────┐
  │ фото│ │ фото│ │ фото│  ← сетка результатов
  └─────┘ └─────┘ └─────┘
```

### Логика данных

**Полная переиспользуемость** — Edge Function `search-face` принимает `{retreat_id, vaishnava_id, photo_url?}`.
Это тот же вызов, что делает гость. Разница только в том, кто инициирует:

| | Гость (guest-portal/photos.html) | Фотограф (photos/manage.html) |
|--|--|--|
| `vaishnava_id` | `currentUser.id` (себя) | выбранный из списка |
| `photo_url` | загружает селфи / из профиля | берётся из профиля автоматически |
| `retreat_id` | итерирует по своим ретритам | выбирает из списка |
| Результат | `myPhotos` + фильтр | показывается в сетке результатов |

### Детали реализации

**HTML (photos/manage.html):**
1. Добавить tab-навигацию (DaisyUI `tabs` компонент)
2. Новая секция вкладки:
   - `#retreatSelectSearch` — выбор ретрита (или переиспользовать `#retreatSelect`)
   - `#vaishnavasSearchInput` — поиск вайшнава с автодополнением (как в других модулях)
   - Блок превью фото: `#searchPersonPhoto` — если есть `photo_url`, показать миниатюру; иначе — кнопка загрузки файла (аналог `#selfieInput` из guest-portal)
   - `#findPersonBtn` — кнопка запуска поиска
   - `#searchResults` — сетка найденных фото

**JS (photos/js/manage.js):**

```javascript
// Загрузка вайшнавов для autocomplete
async function loadVaishnavasForSearch() {
    const { data } = await Layout.db
        .from('vaishnavas')
        .select('id, spiritual_name, first_name, last_name, photo_url')
        .order('spiritual_name');
    // заполнить datalist или кастомный dropdown
}

// Запуск поиска
async function findPersonInRetreat() {
    const retreatId = retreatSelectSearch.value;
    const vaishnavasId = selectedVaishnava.id;
    const photoUrl = selectedVaishnava.photo_url || uploadedSelfieUrl;

    const result = await Layout.db.functions.invoke('search-face', {
        body: { retreat_id: retreatId, vaishnava_id: vaishnavasId, photo_url: photoUrl }
    });
    renderSearchResults(result.data.matched_photo_ids);
}
```

**Особенности:**
- Если у вайшнава нет `photo_url` — показать поле загрузки фото (как `#selfieInput`)
- Загрузка временного фото в storage, удаление после поиска — **та же логика**, что в guest-portal
- После успешного поиска — показать сетку найденных фото (можно переиспользовать рендер из текущей страницы)
- Права: только `upload_photos` — уже проверяется при входе на страницу

### Оценка сложности

**Средняя задача.** Edge Function уже готова, основная работа — UI и JS для новой вкладки в admin-модуле. Нужно загрузить список вайшнавов и сделать поиск/автодополнение.

| Что | Файлов | Строк |
|-----|--------|-------|
| Tab-навигация в HTML | 1 | ~15 строк |
| HTML форма поиска | 1 | ~40 строк |
| JS: загрузка вайшнавов | 1 | ~20 строк |
| JS: findPersonInRetreat() | 1 | ~40 строк |
| JS: renderSearchResults() | 1 | ~30 строк |
| JS: загрузка временного фото (если нет в профиле) | 1 | ~25 строк (копия логики из guest-portal) |

**Итого изменений:** ~170 строк в 1–2 файлах.

**Время на реализацию (Claude Code): ~40–55 мин**

**Риски:** Низкий — всё опирается на готовую Edge Function, новых таблиц/миграций не нужно.

---

---

## Задача 5 — Watermark логотипа ШРСК на все фото при загрузке

### Что сделать

При загрузке новых фото (через `photos/upload.html`) накладывать логотип ШРСК в правый нижний угол фото — полупрозрачно (opacity ~35%).

### Выбранный подход

**Клиентская обработка через Canvas API** — оптимально для этого проекта, потому что:
- Canvas уже используется в `photos/js/upload.js` для сжатия (`compressImageIfNeeded`) и thumbnail
- Логотип накладывается в тот же pipeline, до отправки в Storage
- Не нужна новая Edge Function и серверная зависимость (Sharp/Deno Canvas)
- Файл уже в памяти браузера в виде `<img>` на этапе обработки

> Примечание: ответ "серверная Edge Function" учтён, но после анализа кода клиентский Canvas — более простое решение при той же надёжности, т.к. upload и без того клиентский.

### Где встроить в pipeline

```
uploadSingleFile(file)
  → compressImageIfNeeded(file)    ← сжатие до 5 МБ через Canvas
  → applyWatermark(processedFile)  ← НОВЫЙ ШАГ: накладываем логотип
  → createThumbnail(...)           ← thumbnail (watermark не нужен)
  → upload в Storage
```

### Детали реализации (photos/js/upload.js)

```javascript
// Новая функция — вставить после compressImageIfNeeded
async function applyWatermark(file) {
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                const ctx = canvas.getContext('2d');
                canvas.width = img.width;
                canvas.height = img.height;

                // Рисуем оригинал
                ctx.drawImage(img, 0, 0);

                // Загружаем логотип
                const logo = new Image();
                logo.onload = () => {
                    // Размер логотипа ~8% от ширины фото
                    const logoW = Math.round(img.width * 0.08);
                    const logoH = Math.round(logo.height * (logoW / logo.width));

                    // Правый нижний угол, отступ 1.5%
                    const margin = Math.round(img.width * 0.015);
                    const x = img.width - logoW - margin;
                    const y = img.height - logoH - margin;

                    ctx.globalAlpha = 0.35; // полупрозрачность
                    ctx.drawImage(logo, x, y, logoW, logoH);
                    ctx.globalAlpha = 1.0;

                    canvas.toBlob((blob) => {
                        resolve(new File([blob], file.name, { type: 'image/jpeg' }));
                    }, 'image/jpeg', 0.92);
                };
                logo.src = '/images/logo-watermark.png'; // путь к логотипу
            };
            img.src = e.target.result;
        };
        reader.readAsDataURL(file);
    });
}
```

Затем в `uploadSingleFile`:
```javascript
const processedFile = await compressImageIfNeeded(file);
const watermarkedFile = await applyWatermark(processedFile);  // ← новая строка
const thumbFile = await createThumbnail(processedFile, 400, 0.8); // thumbnail без watermark
```

### Логотип

- Нужен файл `/images/logo-watermark.png` — PNG с прозрачным фоном, белое/светлое лого ШРСК
- Если логотип уже есть в проекте (favicon.svg, etc.) — сконвертировать или добавить PNG-версию

### Что НЕ затрагивается

- Уже загруженные фото — не перезаписываются (по условию задачи)
- Thumbnails — без watermark (иначе на мелких превью некрасиво)
- Поиск лиц (Rekognition) — работает до watermark, т.к. thumbnail используется для индексации

### Оценка сложности

**Простая задача.** Canvas уже используется, pipeline понятен, встройка минимальная.

| Что | Файлов | Строк |
|-----|--------|-------|
| Функция `applyWatermark()` | 1 | ~35 строк |
| Встройка в `uploadSingleFile()` | 1 | ~2 строки |
| Файл логотипа PNG | 1 новый | — |

**Время на реализацию (Claude Code): ~20–30 мин**

**Риски:** Низкий. Единственный нюанс — нужен готовый PNG логотип с прозрачным фоном. Если его нет, нужно сделать/экспортировать из SVG (отдельная задача).

---

## Итоговая оценка

| Задача | Сложность | Время (Claude Code) | Риски |
|--------|-----------|-------------------|-------|
| 1. Telegram в profile-card | Простая | ~15–25 мин | Низкий |
| 2. Секция "Фото со мной" | Простая | ~20–30 мин | Низкий |
| 3. Отмена отметки на фото | Средняя | ~30–40 мин | Средний (RLS + схема auth) |
| 4. Поиск человека в модуле Фото | Средняя | ~40–55 мин | Низкий |
| 5. Watermark логотипа | Простая | ~20–30 мин | Низкий (нужен PNG логотипа) |
| **Итого** | | **~125–180 мин (~2–3 часа)** | |

### Порядок реализации

Рекомендуемый порядок (по возрастанию риска):
1. Задача 2 (независимая, данные уже есть)
2. Задача 1 (только HTML/JS, нет БД)
3. Задача 3 (требует миграцию, проверку RLS)

### Ключевые файлы

- [guest-portal/index.html](guest-portal/index.html) — задачи 1 и 2
- [guest-portal/js/portal-index.js](guest-portal/js/portal-index.js) — задачи 1 и 2
- [guest-portal/photos.html](guest-portal/photos.html) — задача 3
- `supabase/128_face_tags_delete_own.sql` — новый файл для задачи 3

### Что нужно уточнить перед задачей 3

- Как связан `currentGuest.id` (UUID в `vaishnavas`) с `auth.uid()` (UUID в `auth.users`)? Через поле `vaishnavas.auth_user_id` или `portal_guests`?
- Это определит точную форму RLS политики для DELETE.
