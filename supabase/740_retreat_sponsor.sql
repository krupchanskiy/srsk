-- 740: «Траты ретрита оплачивает» — спонсор ретрита (ВГ 23.10.2026).
--
-- Закрытый ретрит может оплачивать человек (Ачинтья Кришна — ретрит художников).
-- У спонсора счёт взаиморасчётов в ₹: минус — мы ему должны, плюс — он нам.
-- Каждая трата ретрита (с любого счёта) и себестоимость прасада ретрита
-- зачитываются на этот счёт ПАРНОЙ операцией прихода «Оплата спонсора»:
--   • трата внесена — зачёт появился; сторно / смена ретрита / правка — зачёт следует сам;
--   • прасад: себестоимость пересчиталась — зачёт догоняет (рост — доначисление разницы,
--     уменьшение — сторно прежних и один новый на всю сумму);
--   • не-₹ траты — в ₹ по РЫНОЧНОМУ курсу (fin_market_rates), не по гостевому;
--     нет рыночного курса на дату — зачёта нет, страница показывает ⚠.
-- Приход несёт объект ретрита: «Оплата спонсора» — в части «Ретрит» отчёта,
-- «Прасад — оплата спонсора» — в части «Прасад» (fin_prasad_income.sponsor).
-- Обмен ₽↔₹ на счетах спонсора — обычный перевод с двумя суммами (по курсу ВГ), здесь не трогаем.
-- Синхронизация — отложенными триггерами (на коммите), чтобы многострочная трата
-- давала один зачёт, а сторно видело уже выставленный is_reversed.

-- ---------- справочники ----------
CREATE TABLE IF NOT EXISTS fin_market_rates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_currency text NOT NULL REFERENCES fin_currencies(code),
  effective_date date NOT NULL,
  rate numeric(14,6) NOT NULL CHECK (rate > 0),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (from_currency, effective_date),
  CHECK (from_currency <> 'INR')
);
COMMENT ON TABLE fin_market_rates IS 'Рыночный курс (₹ за единицу) — для расчётов со своими: зачёты спонсора. Гостевой — fin_exchange_rates';
ALTER TABLE fin_market_rates ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS fin_retreat_sponsors (
  retreat_id uuid PRIMARY KEY REFERENCES retreats(id),
  account_id uuid NOT NULL REFERENCES fin_accounts(id),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE fin_retreat_sponsors IS 'Траты ретрита оплачивает: счёт взаиморасчётов спонсора в ₹';
ALTER TABLE fin_retreat_sponsors ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS fin_sponsor_offsets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  retreat_id uuid NOT NULL REFERENCES retreats(id),
  kind text NOT NULL CHECK (kind IN ('expense', 'prasad')),
  source_operation_id uuid REFERENCES fin_operations(id),
  offset_operation_id uuid NOT NULL UNIQUE REFERENCES fin_operations(id),
  account_id uuid NOT NULL REFERENCES fin_accounts(id),
  amount numeric(14,2) NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'expense') = (source_operation_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS fin_sponsor_offsets_active ON fin_sponsor_offsets (retreat_id) WHERE is_active;
CREATE INDEX IF NOT EXISTS fin_sponsor_offsets_source ON fin_sponsor_offsets (source_operation_id);
ALTER TABLE fin_sponsor_offsets ENABLE ROW LEVEL SECURITY;

INSERT INTO fin_categories (code, name, direction)
SELECT 'sponsor_payment', 'Оплата спонсора', 'in'
WHERE NOT EXISTS (SELECT 1 FROM fin_categories WHERE code = 'sponsor_payment');
INSERT INTO fin_categories (code, name, direction)
SELECT 'sponsor_prasad', 'Прасад — оплата спонсора', 'in'
WHERE NOT EXISTS (SELECT 1 FROM fin_categories WHERE code = 'sponsor_prasad');

-- ---------- рыночный курс на дату ----------
CREATE OR REPLACE FUNCTION fin_private_market_rate(p_currency text, p_on date)
RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT CASE WHEN p_currency = 'INR' THEN 1::numeric ELSE (
    SELECT rate FROM fin_market_rates
     WHERE from_currency = p_currency AND effective_date <= p_on
     ORDER BY effective_date DESC LIMIT 1) END;
$$;

-- ---------- внутреннее сторно (без проверки прав: вызывает только синхронизация) ----------
CREATE OR REPLACE FUNCTION fin_private_sponsor_reverse(p_op uuid, p_reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_src fin_operations%ROWTYPE;
  v_id uuid := gen_random_uuid();
  v_on date;
  p fin_postings%ROWTYPE;
BEGIN
  SELECT * INTO v_src FROM fin_operations WHERE id = p_op FOR UPDATE;
  IF NOT FOUND OR v_src.is_reversed THEN RETURN; END IF;
  -- дата сторно — как у зачёта, но не в будущем
  v_on := least(v_src.occurred_on, current_date);
  INSERT INTO fin_operations (id, request_hash, type, occurred_on, approval, original_operation_id, reason, created_by)
  VALUES (v_id, fin_private_hash(jsonb_build_object('command', 'sponsor_reversal', 'op', p_op, 'id', v_id)),
          'reversal', v_on, 'not_required', p_op, p_reason, v_src.created_by);
  FOR p IN SELECT * FROM fin_postings WHERE operation_id = p_op ORDER BY ledger_seq LOOP
    INSERT INTO fin_postings (id, operation_id, account_id, direction, amount, currency_code,
      amount_base, rate_used, category_id, cost_center_id, object_id, is_post_close, note)
    VALUES (fin_private_child_uuid(v_id, p.id::text), v_id, p.account_id,
      CASE p.direction WHEN 'in' THEN 'out'::fin_direction ELSE 'in'::fin_direction END,
      p.amount, p.currency_code, p.amount_base, p.rate_used, p.category_id, p.cost_center_id,
      p.object_id, p.is_post_close, p.note);
  END LOOP;
  UPDATE fin_operations SET is_reversed = true WHERE id = p_op;
  UPDATE fin_sponsor_offsets SET is_active = false WHERE offset_operation_id = p_op;
END;
$$;

-- ---------- создать зачёт ----------
CREATE OR REPLACE FUNCTION fin_private_sponsor_offset(
  p_retreat uuid, p_kind text, p_source uuid, p_account uuid, p_object uuid,
  p_amount numeric, p_on date, p_comment text, p_actor uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_id uuid := gen_random_uuid();
  v_acc fin_accounts%ROWTYPE;
  v_closed boolean;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN RETURN; END IF;
  SELECT * INTO v_acc FROM fin_accounts WHERE id = p_account;
  v_closed := EXISTS (SELECT 1 FROM fin_object_closures c WHERE c.object_id = p_object AND c.is_initial);
  INSERT INTO fin_operations (id, request_hash, type, occurred_on, approval, comment, created_by)
  VALUES (v_id, fin_private_hash(jsonb_build_object('command', 'sponsor_offset', 'id', v_id)),
          'income', least(p_on, current_date), 'not_required', p_comment, p_actor);
  INSERT INTO fin_postings (id, operation_id, account_id, direction, amount, currency_code,
    amount_base, rate_used, category_id, cost_center_id, object_id, is_post_close)
  VALUES (fin_private_child_uuid(v_id, 'offset'), v_id, p_account, 'in', p_amount, 'INR',
    p_amount, 1, (SELECT id FROM fin_categories WHERE code = CASE p_kind WHEN 'prasad' THEN 'sponsor_prasad' ELSE 'sponsor_payment' END),
    v_acc.default_cost_center_id, p_object, v_closed);
  IF v_closed THEN
    UPDATE fin_accounting_objects SET report_dirty_at = now() WHERE id = p_object;
  END IF;
  INSERT INTO fin_sponsor_offsets (retreat_id, kind, source_operation_id, offset_operation_id, account_id, amount)
  VALUES (p_retreat, p_kind, p_source, v_id, p_account, p_amount);
END;
$$;

-- ---------- цели зачёта: живые траты ретрита в ₹ ----------
CREATE OR REPLACE FUNCTION fin_private_sponsor_targets(p_object uuid)
RETURNS TABLE (op uuid, on_date date, amount numeric, comment text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT o.id, o.occurred_on,
         round(SUM(p.amount * fin_private_market_rate(p.currency_code, o.occurred_on)), 2),
         left(COALESCE(NULLIF(btrim(o.comment), ''), string_agg(DISTINCT c.name, ', ')), 300)
    FROM fin_operations o
    JOIN fin_postings p ON p.operation_id = o.id
    LEFT JOIN fin_categories c ON c.id = p.category_id
   WHERE p.object_id = p_object AND o.type = 'expense' AND NOT o.is_reversed AND p.direction = 'out'
   GROUP BY o.id, o.occurred_on
  HAVING bool_and(fin_private_market_rate(p.currency_code, o.occurred_on) IS NOT NULL);
$$;

-- ---------- синхронизация зачётов ретрита ----------
CREATE OR REPLACE FUNCTION fin_private_sponsor_sync(p_retreat uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_sp fin_retreat_sponsors%ROWTYPE;
  v_obj uuid;
  v_name text;
  v_end date;
  v_actor uuid;
  v_prev_notify text;
  r record;
  v_target numeric;
  v_current numeric;
BEGIN
  IF p_retreat IS NULL OR COALESCE(current_setting('fin.sponsor_sync', true), '') = '1' THEN RETURN; END IF;
  PERFORM set_config('fin.sponsor_sync', '1', true);
  -- зачёты — не события для чатов департаментов
  v_prev_notify := COALESCE(current_setting('tg.suppress_chat_notify', true), '');
  PERFORM set_config('tg.suppress_chat_notify', '1', true);

  SELECT * INTO v_sp FROM fin_retreat_sponsors WHERE retreat_id = p_retreat;
  SELECT id INTO v_obj FROM fin_accounting_objects WHERE retreat_id = p_retreat;
  SELECT name_ru, end_date INTO v_name, v_end FROM retreats WHERE id = p_retreat;
  v_actor := COALESCE(auth.uid(), v_sp.created_by);

  -- спонсор снят или сменён счёт — прежние зачёты сторнируются
  FOR r IN SELECT offset_operation_id FROM fin_sponsor_offsets
            WHERE retreat_id = p_retreat AND is_active
              AND (v_sp.retreat_id IS NULL OR v_obj IS NULL OR account_id <> v_sp.account_id) LOOP
    PERFORM fin_private_sponsor_reverse(r.offset_operation_id, 'Спонсор ретрита снят или сменён');
  END LOOP;

  IF v_sp.retreat_id IS NOT NULL AND v_obj IS NOT NULL AND v_actor IS NOT NULL THEN
    -- траты: цель — сумма каждой живой траты ретрита в ₹ (не-₹ по рыночному курсу)
    FOR r IN SELECT f.offset_operation_id FROM fin_sponsor_offsets f
              LEFT JOIN fin_private_sponsor_targets(v_obj) t ON t.op = f.source_operation_id
             WHERE f.retreat_id = p_retreat AND f.kind = 'expense' AND f.is_active
               AND (t.op IS NULL OR t.amount <> f.amount) LOOP
      PERFORM fin_private_sponsor_reverse(r.offset_operation_id, 'Трата ретрита отменена или изменена');
    END LOOP;

    FOR r IN SELECT t.* FROM fin_private_sponsor_targets(v_obj) t
             WHERE NOT EXISTS (SELECT 1 FROM fin_sponsor_offsets f
                                WHERE f.source_operation_id = t.op AND f.is_active) LOOP
      PERFORM fin_private_sponsor_offset(p_retreat, 'expense', r.op, v_sp.account_id, v_obj, r.amount, r.on_date,
        format('%s — трата за счёт спонсора: %s', v_name, r.comment), v_actor);
    END LOOP;

    -- прасад: цель — себестоимость, вошедшая в стоимость ретрита
    SELECT round(COALESCE((data->>'included')::numeric, 0), 2) INTO v_target
      FROM fin_prasad_cost WHERE retreat_id = p_retreat;
    v_target := COALESCE(v_target, 0);
    SELECT COALESCE(SUM(amount), 0) INTO v_current
      FROM fin_sponsor_offsets WHERE retreat_id = p_retreat AND kind = 'prasad' AND is_active;
    IF v_target < v_current THEN
      FOR r IN SELECT offset_operation_id FROM fin_sponsor_offsets
                WHERE retreat_id = p_retreat AND kind = 'prasad' AND is_active LOOP
        PERFORM fin_private_sponsor_reverse(r.offset_operation_id, 'Себестоимость прасада пересчитана');
      END LOOP;
      v_current := 0;
    END IF;
    IF v_target > v_current THEN
      PERFORM fin_private_sponsor_offset(p_retreat, 'prasad', NULL, v_sp.account_id, v_obj,
        v_target - v_current, least(current_date, v_end),
        format('%s — себестоимость прасада за счёт спонсора%s', v_name,
               CASE WHEN v_current > 0 THEN ' (доначисление после пересчёта)' ELSE '' END), v_actor);
    END IF;
  END IF;

  PERFORM set_config('tg.suppress_chat_notify', v_prev_notify, true);
  PERFORM set_config('fin.sponsor_sync', '', true);
END;
$$;

-- ---------- отложенные триггеры ----------
CREATE OR REPLACE FUNCTION fin_trg_sponsor_sync()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_retreats uuid[];
  v uuid;
BEGIN
  IF COALESCE(current_setting('fin.sponsor_sync', true), '') = '1' THEN RETURN NULL; END IF;
  IF NOT EXISTS (SELECT 1 FROM fin_retreat_sponsors) AND TG_TABLE_NAME <> 'fin_retreat_sponsors' THEN RETURN NULL; END IF;

  IF TG_TABLE_NAME = 'fin_postings' THEN
    -- свои проводки зачёта и их сторно синхронизацию не запускают
    IF NEW.category_id IN (SELECT id FROM fin_categories WHERE code IN ('sponsor_payment', 'sponsor_prasad')) THEN
      RETURN NULL;
    END IF;
    IF NEW.object_id IS NULL AND (TG_OP = 'INSERT' OR OLD.object_id IS NULL) THEN RETURN NULL; END IF;
    SELECT array_agg(o.retreat_id) INTO v_retreats FROM fin_accounting_objects o
     WHERE o.id IN (NEW.object_id, CASE WHEN TG_OP = 'UPDATE' THEN OLD.object_id END);
  ELSIF TG_TABLE_NAME = 'fin_operations' THEN
    SELECT array_agg(DISTINCT o.retreat_id) INTO v_retreats
      FROM fin_postings p JOIN fin_accounting_objects o ON o.id = p.object_id
     WHERE p.operation_id = NEW.id;
  ELSIF TG_TABLE_NAME = 'fin_prasad_cost' THEN
    v_retreats := ARRAY[NEW.retreat_id];
  ELSIF TG_TABLE_NAME = 'fin_retreat_sponsors' THEN
    v_retreats := ARRAY[CASE WHEN TG_OP = 'DELETE' THEN OLD.retreat_id ELSE NEW.retreat_id END];
  ELSIF TG_TABLE_NAME = 'fin_market_rates' THEN
    SELECT array_agg(retreat_id) INTO v_retreats FROM fin_retreat_sponsors;
  END IF;

  FOREACH v IN ARRAY COALESCE(v_retreats, '{}') LOOP
    IF v IS NOT NULL AND (EXISTS (SELECT 1 FROM fin_retreat_sponsors WHERE retreat_id = v)
                          OR EXISTS (SELECT 1 FROM fin_sponsor_offsets WHERE retreat_id = v AND is_active)) THEN
      PERFORM fin_private_sponsor_sync(v);
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_fin_sponsor_postings ON fin_postings;
CREATE CONSTRAINT TRIGGER trg_fin_sponsor_postings AFTER INSERT OR UPDATE OF object_id ON fin_postings
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION fin_trg_sponsor_sync();
DROP TRIGGER IF EXISTS trg_fin_sponsor_operations ON fin_operations;
CREATE CONSTRAINT TRIGGER trg_fin_sponsor_operations AFTER UPDATE OF is_reversed ON fin_operations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION fin_trg_sponsor_sync();
DROP TRIGGER IF EXISTS trg_fin_sponsor_prasad ON fin_prasad_cost;
CREATE CONSTRAINT TRIGGER trg_fin_sponsor_prasad AFTER INSERT OR UPDATE ON fin_prasad_cost
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION fin_trg_sponsor_sync();
DROP TRIGGER IF EXISTS trg_fin_sponsor_setting ON fin_retreat_sponsors;
CREATE CONSTRAINT TRIGGER trg_fin_sponsor_setting AFTER INSERT OR UPDATE OR DELETE ON fin_retreat_sponsors
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION fin_trg_sponsor_sync();
DROP TRIGGER IF EXISTS trg_fin_sponsor_rates ON fin_market_rates;
CREATE CONSTRAINT TRIGGER trg_fin_sponsor_rates AFTER INSERT OR UPDATE OR DELETE ON fin_market_rates
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION fin_trg_sponsor_sync();

-- ---------- RPC для страницы ----------
CREATE OR REPLACE FUNCTION fin_set_retreat_sponsor(p_retreat uuid, p_account uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_actor uuid := fin_actor();
  v_acc fin_accounts%ROWTYPE;
BEGIN
  IF NOT fin_is_admin(v_actor) THEN
    RAISE EXCEPTION 'forbidden' USING DETAIL = 'Спонсора ретрита назначает администратор финансов';
  END IF;
  IF p_account IS NULL THEN
    DELETE FROM fin_retreat_sponsors WHERE retreat_id = p_retreat;
    RETURN jsonb_build_object('ok', true);
  END IF;
  SELECT * INTO v_acc FROM fin_accounts WHERE id = p_account;
  IF NOT FOUND OR NOT v_acc.is_active OR v_acc.currency_code <> 'INR' THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Нужен действующий счёт в рупиях';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM fin_accounting_objects WHERE retreat_id = p_retreat) THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'У ретрита нет учётного объекта';
  END IF;
  INSERT INTO fin_retreat_sponsors (retreat_id, account_id, created_by)
  VALUES (p_retreat, p_account, v_actor)
  ON CONFLICT (retreat_id) DO UPDATE SET account_id = EXCLUDED.account_id, updated_at = now()
  WHERE fin_retreat_sponsors.account_id <> EXCLUDED.account_id;
  RETURN jsonb_build_object('ok', true);
END;
$$;

CREATE OR REPLACE FUNCTION fin_set_market_rate(p_currency text, p_date date, p_rate numeric)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_actor uuid := fin_actor();
BEGIN
  IF NOT fin_is_admin(v_actor) THEN
    RAISE EXCEPTION 'forbidden' USING DETAIL = 'Рыночный курс вводит администратор финансов';
  END IF;
  IF p_rate IS NULL OR p_rate <= 0 OR p_currency IS NULL OR p_currency = 'INR' OR p_date IS NULL THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Валюта, дата и курс больше нуля обязательны';
  END IF;
  INSERT INTO fin_market_rates (from_currency, effective_date, rate, created_by)
  VALUES (p_currency, p_date, p_rate, v_actor)
  ON CONFLICT (from_currency, effective_date) DO UPDATE SET rate = EXCLUDED.rate, created_by = EXCLUDED.created_by, created_at = now();
  RETURN jsonb_build_object('ok', true);
END;
$$;

CREATE OR REPLACE FUNCTION fin_get_retreat_sponsor(p_retreat uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_sp fin_retreat_sponsors%ROWTYPE;
  v_obj uuid;
BEGIN
  IF NOT fin_can_read_all() THEN
    RAISE EXCEPTION 'forbidden' USING DETAIL = 'Недостаточно прав';
  END IF;
  SELECT * INTO v_sp FROM fin_retreat_sponsors WHERE retreat_id = p_retreat;
  SELECT id INTO v_obj FROM fin_accounting_objects WHERE retreat_id = p_retreat;
  RETURN jsonb_build_object(
    'account_id', v_sp.account_id,
    'account_name', (SELECT name FROM fin_accounts WHERE id = v_sp.account_id),
    'balance', CASE WHEN v_sp.account_id IS NULL THEN NULL ELSE fin_private_account_balance(v_sp.account_id) END,
    -- все счета спонсора (по департаменту счёта) — остаток долга в каждой валюте
    'sponsor_balances', COALESCE((SELECT jsonb_agg(jsonb_build_object('name', a.name, 'currency', a.currency_code,
                                     'balance', fin_private_account_balance(a.id)) ORDER BY a.currency_code)
                                    FROM fin_accounts a
                                   WHERE a.is_active AND a.department_id IS NOT NULL
                                     AND a.department_id = (SELECT department_id FROM fin_accounts WHERE id = v_sp.account_id)), '[]'::jsonb),
    'offset_expense', (SELECT COALESCE(SUM(amount), 0) FROM fin_sponsor_offsets WHERE retreat_id = p_retreat AND kind = 'expense' AND is_active),
    'offset_expense_n', (SELECT count(*) FROM fin_sponsor_offsets WHERE retreat_id = p_retreat AND kind = 'expense' AND is_active),
    'offset_prasad', (SELECT COALESCE(SUM(amount), 0) FROM fin_sponsor_offsets WHERE retreat_id = p_retreat AND kind = 'prasad' AND is_active),
    -- ⚠ траты не в ₹ без рыночного курса на дату — не зачтены
    'missing_rates', COALESCE((SELECT jsonb_agg(jsonb_build_object('operation_id', o.id, 'date', o.occurred_on,
                                  'currency', p.currency_code, 'amount', p.amount) ORDER BY o.occurred_on)
                                 FROM fin_operations o JOIN fin_postings p ON p.operation_id = o.id
                                WHERE v_sp.account_id IS NOT NULL AND p.object_id = v_obj AND o.type = 'expense'
                                  AND NOT o.is_reversed AND p.direction = 'out'
                                  AND fin_private_market_rate(p.currency_code, o.occurred_on) IS NULL), '[]'::jsonb),
    -- кого можно выбрать: действующие счета в ₹ (взаиморасчёты — подотчётные)
    'candidates', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name) ORDER BY a.name)
                              FROM fin_accounts a WHERE a.is_active AND a.currency_code = 'INR' AND a.kind = 'custodial'), '[]'::jsonb)
  );
END;
$$;

REVOKE ALL ON FUNCTION fin_private_market_rate(text, date), fin_private_sponsor_reverse(uuid, text),
  fin_private_sponsor_offset(uuid, text, uuid, uuid, uuid, numeric, date, text, uuid),
  fin_private_sponsor_sync(uuid), fin_private_sponsor_targets(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION fin_set_retreat_sponsor(uuid, uuid), fin_set_market_rate(text, date, numeric),
  fin_get_retreat_sponsor(uuid) TO authenticated;

-- ---------- отчёты: «Прасад — оплата спонсора» — приход части «Прасад» ----------
DO $mig$
DECLARE
  v_def text;
  v_new text;
BEGIN
  v_def := pg_get_functiondef('fin_private_build_snapshot(uuid)'::regprocedure);
  v_new := replace(v_def,
    $s$AND (c.name = 'Прасад - пожертвование' OR p.participant_balance_kind = 'meals')$s$,
    $s$AND (c.name = 'Прасад - пожертвование' OR p.participant_balance_kind = 'meals' OR c.code = 'sponsor_prasad')$s$);
  IF v_new = v_def THEN RAISE EXCEPTION 'snapshot: шаблон не найден'; END IF;
  EXECUTE v_new;

  v_def := pg_get_functiondef('fin_prasad_income(uuid)'::regprocedure);
  v_new := replace(v_def,
    $s$  ), kp as ($s$,
    $s$  ), sp as (
    select coalesce(sum(case p.direction::text when 'in' then p.amount_base else -p.amount_base end), 0) as s
      from fin_postings p
      join fin_categories cat on cat.id = p.category_id
     where p.object_id = v_obj and cat.code = 'sponsor_prasad'
  ), kp as ($s$);
  v_new := replace(v_new,
    $s$    'donations', (select s from don),$s$,
    $s$    'donations', (select s from don),
    'sponsor', (select s from sp),$s$);
  IF v_new = v_def OR position('''sponsor''' in v_new) = 0 THEN RAISE EXCEPTION 'prasad_income: шаблон не найден'; END IF;
  EXECUTE v_new;
END
$mig$;
