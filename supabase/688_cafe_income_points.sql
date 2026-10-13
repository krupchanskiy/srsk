-- 688: «Касса кафе» по двум точкам — Самообслуживание (1 этаж, боксы) и Кафе (2 этаж, касса).
-- ВГ 13.10.2026: разделять «для интереса», финансовая отчётность не меняется — статья
-- остаётся одна («Касса кафе»), точка — пометка на строке прихода. Старые приходы без пометки.
--
-- fin_private_create_flow и fin_v_account_ledger большие — правим точечными заменами
-- текущего определения, каждая замена проверяется (не нашлась — миграция падает).

ALTER TABLE fin_postings
  ADD COLUMN IF NOT EXISTS cafe_point text
  CHECK (cafe_point IN ('self', 'cafe'));

COMMENT ON COLUMN fin_postings.cafe_point IS
  'Точка приёма денег кафе для статьи «Касса кафе»: self — самообслуживание (1 этаж), cafe — кафе (2 этаж). NULL — без разбивки';

DO $mig$
DECLARE
  d text := pg_get_functiondef('fin_private_create_flow'::regproc);
  pairs text[][] := ARRAY[
    -- 1. новый ключ строки
    [E'''object_id'', ''participant_id'', ''contractor_id'', ''payment_channel''\n    ]);',
     E'''object_id'', ''participant_id'', ''contractor_id'', ''payment_channel'', ''cafe_point''\n    ]);\n    IF NULLIF(r->>''cafe_point'', '''') IS NOT NULL THEN\n      IF p_type <> ''income'' OR r->>''cafe_point'' NOT IN (''self'', ''cafe'') THEN\n        RAISE EXCEPTION ''invalid_payload'' USING DETAIL = ''Точка кафе допустима только в приходе: self или cafe'';\n      END IF;\n    END IF;'],
    -- 2. в канонический вид (хэш идемпотентности) — только если указана, старые запросы не меняются
    [E'''payment_channel'', NULLIF(r->>''payment_channel'', '''')\n    ));',
     E'''payment_channel'', NULLIF(r->>''payment_channel'', '''')\n    ) || CASE WHEN NULLIF(r->>''cafe_point'', '''') IS NULL THEN ''{}''::jsonb\n              ELSE jsonb_build_object(''cafe_point'', r->>''cafe_point'') END);'],
    -- 3. точка — только у статьи «Касса кафе»
    [E'Cost center не найден или архивирован'';\n    END IF;',
     E'Cost center не найден или архивирован'';\n    END IF;\n    IF r->>''cafe_point'' IS NOT NULL\n       AND (SELECT code FROM fin_categories WHERE id = v_cat.id) IS DISTINCT FROM ''cafe_cash'' THEN\n      RAISE EXCEPTION ''invalid_payload'' USING DETAIL = ''Точка кафе — только для статьи «Касса кафе»'';\n    END IF;'],
    -- 4. запись
    [E'contractor_id, payment_channel\n    ) VALUES (',
     E'contractor_id, payment_channel, cafe_point\n    ) VALUES ('],
    [E'ELSE (r->>''payment_channel'')::fin_payment_channel END\n    );',
     E'ELSE (r->>''payment_channel'')::fin_payment_channel END,\n      r->>''cafe_point''\n    );']
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

-- Лента ДДС: точка в конце списка колонок (CREATE OR REPLACE VIEW позволяет только добавить в конец)
DO $mig$
DECLARE
  v text := pg_get_viewdef('fin_v_account_ledger'::regclass);
  pat text := E'\n   FROM (((((((fin_postings p';
BEGIN
  IF position(pat in v) = 0 THEN
    RAISE EXCEPTION 'fin_v_account_ledger: не нашлось место для колонки';
  END IF;
  EXECUTE 'CREATE OR REPLACE VIEW public.fin_v_account_ledger AS '
       || replace(v, pat, E',\n    p.cafe_point' || pat);
END
$mig$;

-- Сторно повторяет строки исходной операции (fin_create_reversal), но про новую колонку
-- не знает: точку берём с исходной строки — id сторно-строки = child_uuid(операция сторно, id исходной).
CREATE OR REPLACE FUNCTION fin_trg_postings_cafe_point_reversal()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.cafe_point IS NULL AND NEW.category_id IS NOT NULL THEN
    SELECT p.cafe_point INTO NEW.cafe_point
    FROM fin_operations o
    JOIN fin_postings p ON p.operation_id = o.original_operation_id
    WHERE o.id = NEW.operation_id AND o.type = 'reversal'
      AND p.cafe_point IS NOT NULL
      AND fin_private_child_uuid(NEW.operation_id, p.id::text) = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_fin_postings_cafe_point_reversal ON fin_postings;
CREATE TRIGGER trg_fin_postings_cafe_point_reversal
  BEFORE INSERT ON fin_postings
  FOR EACH ROW EXECUTE FUNCTION fin_trg_postings_cafe_point_reversal();
