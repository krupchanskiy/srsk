# Исправление удаления фотографий с ретритов

**Дата**: 12.02.2026
**Проблема**: Фотограф удалял фото напрямую из Storage, минуя Edge Function → лица оставались в AWS Rekognition
**Решение**: Запретить прямое удаление через Storage RLS, обязать использовать Edge Function

---

## Изменения

### 1. Миграция 127: исправлена Storage политика DELETE

**Файл**: `supabase/127_fix_retreat_photos_deletion.sql`

**Что изменилось**:
- ❌ **ДО**: фотограф мог удалять фото ретрита напрямую через Storage API
- ✅ **ПОСЛЕ**: фото ретрита можно удалить ТОЛЬКО через Edge Function `delete-photos` (с Service Role Key)
- ✅ Селфи (папка `selfies/`) по-прежнему удаляет владелец напрямую

**Политика**:
```sql
CREATE POLICY "retreat photos delete by photographers" ON storage.objects
FOR DELETE
TO authenticated
USING (
  bucket_id = 'retreat-photos'
  AND (
    -- Только селфи владельцем
    (storage.foldername(name))[1] = 'selfies'
    AND EXISTS (...)
  )
  -- Фото ретрита — ЗАПРЕЩЕНО напрямую
);
```

---

### 2. Edge Function: добавлена проверка прав

**Файл**: `supabase/functions/delete-photos/index.ts`

**Что добавлено**:
1. Проверка `authorization` header (обязателен)
2. Получение `user_id` из JWT токена
3. Проверка права `upload_photos` через функцию `has_permission()`
4. Возврат 403 Forbidden, если нет прав

**Безопасность**:
- Только пользователи с правом `upload_photos` могут удалять фото
- Суперпользователи (`is_superuser = true`) автоматически имеют право
- Service Role Key обходит RLS и удаляет файлы из Storage

---

### 3. Клиентский код: вызов Edge Function

**Файл**: `photos/js/manage.js`

**Что изменилось**:
```javascript
// ❌ ДО (прямое удаление)
await Layout.db.storage.from('retreat-photos').remove(storagePaths);
await Layout.db.from('retreat_photos').delete().in('id', photoIds);

// ✅ ПОСЛЕ (через Edge Function)
const { data, error } = await Layout.db.functions.invoke('delete-photos', {
    body: {
        photo_ids: photoIds,
        retreat_id: currentRetreatId
    }
});
```

**Преимущества**:
- ✅ Каскадное удаление: Rekognition → Storage → БД
- ✅ Лица удаляются из AWS Rekognition Collection
- ✅ `photo_faces` и `face_tags` удаляются каскадом (FK)
- ✅ Поиск по селфи не находит несуществующие фото

---

## Порядок удаления фото (теперь правильный)

1. **Клиент** (manage.html) → вызывает `delete-photos` Edge Function
2. **Edge Function**:
   - Проверяет JWT токен
   - Проверяет право `upload_photos`
   - Загружает метаданные фото (`storage_path`, `retreat_id`)
   - **Удаляет лица из AWS Rekognition** (`DeleteFacesCommand`)
   - **Удаляет файлы из Storage** (через Service Role)
   - **Удаляет записи из БД** (`retreat_photos`)
   - Каскадно удаляются `photo_faces` и `face_tags` (FK)
3. **Клиент** → получает результат, обновляет UI

---

## Деплой изменений

### 1. Применить миграцию

**ВАЖНО**: Storage политики нельзя применить через `supabase db push` из-за ограничений прав.
Нужно применить **вручную** через Supabase Dashboard SQL Editor.

#### DEV (vzuiwpeovnzfokekdetq):
1. Открыть https://supabase.com/dashboard/project/vzuiwpeovnzfokekdetq/sql/new
2. Скопировать содержимое файла `supabase/127_fix_retreat_photos_deletion.sql`
3. Вставить в SQL Editor
4. Нажать **Run**
5. Проверить результат (должна вернуться 1 строка с новой политикой)

#### PROD (llttmftapmwebidgevmg):
1. Открыть https://supabase.com/dashboard/project/llttmftapmwebidgevmg/sql/new
2. Скопировать содержимое файла `supabase/127_fix_retreat_photos_deletion.sql`
3. Вставить в SQL Editor
4. Нажать **Run**
5. Проверить результат (должна вернуться 1 строка с новой политикой)

### 2. Задеплоить Edge Function

```bash
supabase functions deploy delete-photos --project-ref llttmftapmwebidgevmg --no-verify-jwt
```

### 3. Задеплоить клиентский код

```bash
git add photos/js/manage.js
git commit -m "Исправлено удаление фото: теперь через Edge Function delete-photos"
git push origin main
# Деплой через GitHub Pages (~1-2 мин)
```

---

## Проверка работоспособности

1. Открыть `/photos/manage.html`
2. Выбрать ретрит
3. Выбрать несколько фото
4. Нажать "Удалить выбранные"
5. **Ожидаемый результат**:
   - Фото исчезли из списка
   - В консоли `Delete result: { deleted: N, faces_deleted: M }`
   - В AWS Rekognition лица удалены (проверить через `ListFaces`)
   - В Storage файлы удалены
   - В БД записи удалены

6. **Если ошибка 403**:
   - Проверить, что у пользователя есть право `upload_photos`
   - Проверить, что Edge Function задеплоена
   - Проверить логи Edge Function в Supabase Dashboard

---

## Связанные файлы

- **Миграция**: `supabase/127_fix_retreat_photos_deletion.sql`
- **Edge Function**: `supabase/functions/delete-photos/index.ts`
- **Клиент**: `photos/js/manage.js` (функция `confirmDelete`)
- **ТЗ**: `docs/modules/photos.md` (Edge Function: delete-photos)

---

## Стоимость AWS Rekognition

После исправления:
- ✅ Лица удаляются при удалении фото → не накапливается мусор
- ✅ Стоимость хранения снижается (~$0.01 за 1000 лиц/месяц)
- ✅ Поиск по селфи работает корректно (не находит удалённые фото)
