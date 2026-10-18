-- 701: комментарий к строке операции (ВГ, 18.10.2026). Приход магазина приносят одной
-- суммой, часть — за мурти: к строке «Мурти» нужен свой комментарий (какой сет, сколько),
-- к строке «Касса Магазин» — свой. Общий комментарий операции остаётся как был.
-- Правка по образцу 688: точечные замены, каждая проверяется.

ALTER TABLE fin_postings ADD COLUMN IF NOT EXISTS note text;

COMMENT ON COLUMN fin_postings.note IS
  'Комментарий к строке операции (у операции — свой общий comment). NULL — нет';

DO $mig$
DECLARE
  d text := pg_get_functiondef('fin_private_create_flow'::regproc);
  pairs text[][] := ARRAY[
    -- 1. новый ключ строки
    [E'''contractor_id'', ''payment_channel'', ''cafe_point''\n    ]);',
     E'''contractor_id'', ''payment_channel'', ''cafe_point'', ''note''\n    ]);'],
    -- 2. в хэш идемпотентности — только если указан, старые запросы не меняются
    [E'ELSE jsonb_build_object(''cafe_point'', r->>''cafe_point'') END);',
     E'ELSE jsonb_build_object(''cafe_point'', r->>''cafe_point'') END\n       || CASE WHEN NULLIF(trim(COALESCE(r->>''note'', '''')), '''') IS NULL THEN ''{}''::jsonb\n              ELSE jsonb_build_object(''note'', trim(r->>''note'')) END);'],
    -- 3. запись
    [E'contractor_id, payment_channel, cafe_point\n    ) VALUES (',
     E'contractor_id, payment_channel, cafe_point, note\n    ) VALUES ('],
    [E'      r->>''cafe_point''\n    );',
     E'      r->>''cafe_point'',\n      r->>''note''\n    );']
  ];
  i int;
BEGIN
  FOR i IN 1 .. array_length(pairs, 1) LOOP
    IF (length(d) - length(replace(d, pairs[i][1], ''))) / length(pairs[i][1]) <> 1 THEN
      RAISE EXCEPTION 'fin_private_create_flow: замена % не нашлась ровно один раз', i;
    END IF;
    d := replace(d, pairs[i][1], pairs[i][2]);
  END LOOP;
  EXECUTE d;
END
$mig$;

-- Лента ДДС: комментарий строки в конце списка колонок
DO $mig$
DECLARE
  v text := pg_get_viewdef('fin_v_account_ledger'::regclass);
  pat text := E',\n    p.cafe_point\n';
BEGIN
  IF (length(v) - length(replace(v, pat, ''))) / length(pat) <> 1 THEN
    RAISE EXCEPTION 'fin_v_account_ledger: не нашлось место для колонки';
  END IF;
  EXECUTE 'CREATE OR REPLACE VIEW public.fin_v_account_ledger AS '
       || replace(v, pat, E',\n    p.cafe_point,\n    p.note\n');
END
$mig$;

-- Сторно повторяет строки исходной операции — точку кафе (688) и комментарий строки
-- берём с исходной строки
CREATE OR REPLACE FUNCTION fin_trg_postings_cafe_point_reversal()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  v_point text;
  v_note text;
BEGIN
  IF (NEW.cafe_point IS NULL OR NEW.note IS NULL) AND NEW.category_id IS NOT NULL THEN
    SELECT p.cafe_point, p.note INTO v_point, v_note
    FROM fin_operations o
    JOIN fin_postings p ON p.operation_id = o.original_operation_id
    WHERE o.id = NEW.operation_id AND o.type = 'reversal'
      AND fin_private_child_uuid(NEW.operation_id, p.id::text) = NEW.id;
    NEW.cafe_point := COALESCE(NEW.cafe_point, v_point);
    NEW.note := COALESCE(NEW.note, v_note);
  END IF;
  RETURN NEW;
END;
$$;
