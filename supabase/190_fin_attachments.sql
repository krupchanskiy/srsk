-- =============================================================
-- Финансовый модуль, Этап 5: вложения (чеки, документы)
-- Bucket finance-files (private), политики Storage, fin_create_attachment
-- (command-idempotent, Guide 11.19/13.2), fin_v_attachments,
-- has_attachments в fin_v_operations.
-- Upload-flow: клиент грузит в finance-files/<uid>/<request_id>/<имя>,
-- затем создаёт операцию, затем fin_create_attachment привязывает файл.
-- Непривязанные файлы старше суток чистит фоновая задача (этап 7).
-- =============================================================

-- -------------------------------------------------------------
-- Bucket (идемпотентно): private, лимит 25 МБ, только изображения и PDF
-- -------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('finance-files', 'finance-files', false, 26214400,
        ARRAY['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])
ON CONFLICT (id) DO NOTHING;

-- Политики: писать может админ финансов только в свой префикс <uid>/...;
-- читать (и подписывать URL) — админ и наблюдатель; правка/удаление —
-- никому (файлы неизменны; чистка temp — service role фоновой задачей)
DROP POLICY IF EXISTS "fin_files_upload" ON storage.objects;
CREATE POLICY "fin_files_upload" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'finance-files'
    AND fin_is_admin()
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

DROP POLICY IF EXISTS "fin_files_read" ON storage.objects;
CREATE POLICY "fin_files_read" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'finance-files' AND fin_can_read_all());

-- -------------------------------------------------------------
-- fin_create_attachment — привязка загруженного файла к операции/
-- проводке. Command-idempotent: id строки = request_id клиента.
-- mime/size берутся из storage.objects (правда сервера, не клиента);
-- sha256 декларируется клиентом (полная проверка — Edge-worker, TODO).
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION fin_create_attachment(payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_actor uuid;
  v_request_id uuid;
  v_path text;
  v_parent_type fin_attachment_parent_type;
  v_parent uuid;
  v_posting uuid;
  v_file_name text;
  v_sha text;
  v_hash text;
  v_existing fin_attachments%ROWTYPE;
  v_obj storage.objects%ROWTYPE;
  v_mime text;
  v_size bigint;
  v_detail text;
BEGIN
  v_actor := fin_actor();
  IF NOT fin_is_admin(v_actor) THEN
    RAISE EXCEPTION 'forbidden' USING DETAIL = 'Вложения создаёт только администратор финансов';
  END IF;

  PERFORM fin_private_assert_keys(payload, ARRAY[
    'request_id', 'storage_path', 'parent_type', 'parent_id', 'posting_id', 'file_name', 'sha256'
  ]);
  v_request_id := fin_private_get_uuid(payload, 'request_id', true);
  v_path := NULLIF(trim(COALESCE(payload->>'storage_path', '')), '');
  v_file_name := NULLIF(trim(COALESCE(payload->>'file_name', '')), '');
  v_sha := NULLIF(trim(COALESCE(payload->>'sha256', '')), '');
  v_parent := fin_private_get_uuid(payload, 'parent_id', true);
  v_posting := fin_private_get_uuid(payload, 'posting_id');
  IF v_path IS NULL OR v_file_name IS NULL OR v_sha IS NULL THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'storage_path, file_name и sha256 обязательны';
  END IF;
  BEGIN
    v_parent_type := (payload->>'parent_type')::fin_attachment_parent_type;
  EXCEPTION WHEN invalid_text_representation OR null_value_not_allowed THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'parent_type: operation | accounting_object';
  END;

  v_hash := fin_private_hash(jsonb_build_object(
    'command', 'create_attachment',
    'storage_path', v_path,
    'parent_type', v_parent_type,
    'parent_id', lower(v_parent::text),
    'posting_id', CASE WHEN v_posting IS NULL THEN NULL ELSE lower(v_posting::text) END,
    'file_name', v_file_name,
    'sha256', lower(v_sha)
  ));

  -- идемпотентность: повтор того же request_id + payload → существующая строка
  SELECT * INTO v_existing FROM fin_attachments WHERE id = v_request_id;
  IF FOUND THEN
    IF v_existing.request_hash <> v_hash THEN
      RAISE EXCEPTION 'idempotency_conflict'
        USING DETAIL = 'Тот же request_id уже использован с другим содержимым вложения';
    END IF;
    RETURN jsonb_build_object('ok', true,
      'result', jsonb_build_object('attachment_id', v_existing.id, 'existed', true),
      'warnings', '[]'::jsonb);
  END IF;

  -- тот же путь под другим request_id — конфликт (Guide 8.H)
  IF EXISTS (SELECT 1 FROM fin_attachments WHERE storage_path = v_path) THEN
    RAISE EXCEPTION 'attachment_path_conflict'
      USING DETAIL = 'Этот файл уже привязан другим вложением';
  END IF;

  -- файл действительно загружен в bucket и принадлежит автору
  SELECT * INTO v_obj FROM storage.objects
  WHERE bucket_id = 'finance-files' AND name = v_path;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'attachment_file_missing'
      USING DETAIL = 'Файл не найден в хранилище — загрузите его перед привязкой';
  END IF;
  IF v_obj.owner_id IS DISTINCT FROM v_actor::text THEN
    RAISE EXCEPTION 'forbidden' USING DETAIL = 'Файл загружен другим пользователем';
  END IF;

  v_mime := v_obj.metadata->>'mimetype';
  v_size := COALESCE((v_obj.metadata->>'size')::bigint, 0);
  IF v_mime NOT IN ('image/jpeg', 'image/png', 'image/webp', 'application/pdf') THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Допустимы только jpg/png/webp и PDF';
  END IF;
  IF v_mime = 'application/pdf' AND v_size > 25 * 1024 * 1024 THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'PDF больше 25 МБ';
  END IF;
  IF v_mime <> 'application/pdf' AND v_size > 10 * 1024 * 1024 THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Изображение больше 10 МБ';
  END IF;
  IF v_size <= 0 THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Пустой файл';
  END IF;

  -- родитель
  IF v_parent_type = 'operation' THEN
    IF NOT EXISTS (SELECT 1 FROM fin_operations WHERE id = v_parent) THEN
      RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Операция не найдена';
    END IF;
    IF v_posting IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM fin_postings WHERE id = v_posting AND operation_id = v_parent
    ) THEN
      RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Проводка не принадлежит этой операции';
    END IF;
  ELSE
    IF NOT EXISTS (SELECT 1 FROM fin_accounting_objects WHERE id = v_parent) THEN
      RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Учётный объект не найден';
    END IF;
    IF v_posting IS NOT NULL THEN
      RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Вложение объекта не привязывается к проводке';
    END IF;
  END IF;

  INSERT INTO fin_attachments (
    id, request_hash, parent_type, parent_id, posting_id,
    storage_path, sha256, mime_type, size_bytes, file_name, uploaded_by
  ) VALUES (
    v_request_id, v_hash, v_parent_type, v_parent, v_posting,
    v_path, lower(v_sha), v_mime, v_size, v_file_name, v_actor
  );

  RETURN jsonb_build_object('ok', true,
    'result', jsonb_build_object('attachment_id', v_request_id),
    'warnings', '[]'::jsonb);
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
  IF SQLERRM ~ '^[a-z_]{3,60}$' THEN
    RETURN jsonb_build_object('ok', false, 'error',
      jsonb_build_object('code', SQLERRM, 'message', COALESCE(NULLIF(v_detail, ''), SQLERRM)));
  END IF;
  RETURN jsonb_build_object('ok', false, 'error',
    jsonb_build_object('code', 'internal_error', 'message', SQLERRM));
END;
$$;

-- -------------------------------------------------------------
-- Вложения для экранов (админ/наблюдатель)
-- -------------------------------------------------------------
CREATE OR REPLACE VIEW fin_v_attachments AS
SELECT a.id, a.parent_type, a.parent_id, a.posting_id,
       a.storage_path, a.file_name, a.mime_type, a.size_bytes,
       a.uploaded_at, fin_private_person_name(
         (SELECT v.id FROM vaishnavas v WHERE v.user_id = a.uploaded_by LIMIT 1)
       ) AS uploaded_by_name
FROM fin_attachments a
WHERE fin_can_read_all();

GRANT SELECT ON fin_v_attachments TO authenticated;

-- has_attachments в сводной ленте (новые колонки строго в конец)
CREATE OR REPLACE VIEW fin_v_operations AS
SELECT
  o.id AS operation_id,
  o.type,
  o.occurred_on,
  o.approval,
  o.is_reversed,
  o.original_operation_id,
  o.payer_contact_id,
  fin_private_person_name(o.payer_contact_id) AS payer_name,
  o.reason,
  o.comment,
  o.created_by,
  o.created_at,
  (o.created_at::date > o.occurred_on) AS is_late,
  agg.has_post_close,
  agg.accounts_count,
  agg.max_ledger_seq,
  agg.amounts_by_currency,
  EXISTS (SELECT 1 FROM fin_attachments att
          WHERE att.parent_type = 'operation' AND att.parent_id = o.id) AS has_attachments
FROM fin_operations o
JOIN LATERAL (
  SELECT bool_or(p.is_post_close) AS has_post_close,
         count(DISTINCT p.account_id) AS accounts_count,
         max(p.ledger_seq) AS max_ledger_seq,
         (SELECT jsonb_object_agg(x.currency_code, x.total)
          FROM (SELECT pp.currency_code,
                       -- для transfer нетто по валюте = 0, показываем сумму входящей ноги
                       CASE WHEN o.type = 'transfer'
                            THEN SUM(pp.amount) FILTER (WHERE pp.direction = 'in')
                            ELSE SUM(CASE pp.direction WHEN 'in' THEN pp.amount ELSE -pp.amount END)
                       END AS total
                FROM fin_postings pp WHERE pp.operation_id = o.id
                GROUP BY pp.currency_code) x
          WHERE x.total IS NOT NULL) AS amounts_by_currency
  FROM fin_postings p WHERE p.operation_id = o.id
) agg ON true
WHERE fin_can_read_all();

REVOKE ALL ON FUNCTION fin_create_attachment(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fin_create_attachment(jsonb) TO authenticated;
