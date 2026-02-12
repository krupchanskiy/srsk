# Деплой исправления удаления фотографий

**Краткая инструкция по деплою фикса удаления фото ретритов.**

---

## 1. Применить миграцию Storage политик

### DEV
1. Открыть: https://supabase.com/dashboard/project/vzuiwpeovnzfokekdetq/sql/new
2. Скопировать содержимое: `supabase/127_fix_retreat_photos_deletion.sql`
3. Вставить → Run
4. Проверить: должна вернуться 1 строка с политикой

### PROD
1. Открыть: https://supabase.com/dashboard/project/llttmftapmwebidgevmg/sql/new
2. Скопировать содержимое: `supabase/127_fix_retreat_photos_deletion.sql`
3. Вставить → Run
4. Проверить: должна вернуться 1 строка с политикой

---

## 2. Задеплоить Edge Function

```bash
# PROD
supabase functions deploy delete-photos --project-ref llttmftapmwebidgevmg --no-verify-jwt
```

**Проверка**: должен вернуться URL функции

**Что исправлено в Edge Function**:
- ✅ Добавлена проверка прав `upload_photos`
- ✅ Удаляются оригиналы + превью (`storage_path` + `thumb_path`)
- ✅ Удаляются лица из AWS Rekognition

---

## 3. Закоммитить изменения клиентского кода

```bash
git add photos/js/manage.js
git add supabase/functions/delete-photos/index.ts
git add supabase/127_fix_retreat_photos_deletion_policy_MANUAL.sql
git add docs/photos-deletion-fix.md
git commit -m "Исправлено удаление фото: теперь через Edge Function для каскадного удаления из AWS Rekognition

- Запрещено прямое удаление фото ретрита из Storage (только через Edge Function)
- Добавлена проверка прав upload_photos в Edge Function delete-photos
- Клиентский код теперь вызывает Edge Function вместо прямого удаления
- Каскадное удаление: AWS Rekognition → Storage → БД"

git push origin develop
```

---

## 4. Проверка на PROD

1. Открыть: https://in.rupaseva.com/photos/manage.html
2. Выбрать ретрит
3. Выбрать 1-2 фото
4. Нажать "Удалить выбранные"
5. **Ожидается**:
   - Фото удалены из списка
   - В консоли: `Delete result: { deleted: 2, faces_deleted: 5 }`
   - Нет ошибок

6. **Если ошибка 403**:
   - Проверить, что у пользователя есть право `upload_photos`
   - Проверить логи Edge Function в Dashboard

---

## Что изменилось

### ДО:
```javascript
// Прямое удаление из Storage
await Layout.db.storage.from('retreat-photos').remove(storagePaths);
await Layout.db.from('retreat_photos').delete().in('id', photoIds);
// ❌ Лица остаются в AWS Rekognition
```

### ПОСЛЕ:
```javascript
// Каскадное удаление через Edge Function
const { data, error } = await Layout.db.functions.invoke('delete-photos', {
    body: { photo_ids: photoIds, retreat_id: currentRetreatId }
});
// ✅ Удаляет: Rekognition → Storage → БД
```

---

## Документация

Полная документация: `docs/photos-deletion-fix.md`
