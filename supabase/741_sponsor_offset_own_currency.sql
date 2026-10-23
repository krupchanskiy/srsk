-- 741: зачёт спонсору — в валюте траты, без курса (ВГ 23.10.2026).
--
-- Правило новой системы: движение денег — в своей валюте. Трата в $ зачитывается
-- на «спонсор ($)», в ₽ — на «спонсор (₽)», в ₹ — на «спонсор (₹)»; прасад — в ₹.
-- Счёт спонсора в валюте — подотчётный счёт того же департамента, что и выбранный ₹-счёт.
-- Нет такого счёта — зачёта нет, страница показывает ⚠. Остаток в одной валюте против
-- долга в другой закрывается обменом — переводом с двумя суммами по курсу ВГ.
-- Рыночный курс (740) больше не нужен — убран.
-- Заодно открыт счёт «Ачинтья Кришна ($)» (виза $105 ретрита художников).

INSERT INTO fin_accounts (name, kind, reconciliation_mode, currency_code, group_name,
                          responsible_person_id, is_active, created_by, is_restricted, department_id)
SELECT 'Ачинтья Кришна ($)', a.kind, a.reconciliation_mode, 'USD', a.group_name,
       a.responsible_person_id, true, '8b7c3cfb-9ba8-4ea6-9c94-652c6ee33746', a.is_restricted, a.department_id
  FROM fin_accounts a
 WHERE a.id = '38ed1941-623e-41bd-877f-acde1e21a940'
   AND NOT EXISTS (SELECT 1 FROM fin_accounts WHERE department_id = a.department_id AND currency_code = 'USD');

ALTER TABLE fin_sponsor_offsets ADD COLUMN IF NOT EXISTS currency_code text NOT NULL DEFAULT 'INR' REFERENCES fin_currencies(code);

-- ---------- рыночный курс — убрать ----------
DROP TRIGGER IF EXISTS trg_fin_sponsor_rates ON fin_market_rates;
DROP FUNCTION IF EXISTS fin_set_market_rate(text, date, numeric);
DROP FUNCTION IF EXISTS fin_private_sponsor_targets(uuid);
DROP FUNCTION IF EXISTS fin_private_sponsor_offset(uuid, text, uuid, uuid, uuid, numeric, date, text, uuid);
DROP FUNCTION IF EXISTS fin_private_market_rate(text, date);
DROP TABLE IF EXISTS fin_market_rates;

-- ---------- счёт спонсора в валюте ----------
CREATE OR REPLACE FUNCTION fin_private_sponsor_account(p_retreat uuid, p_currency text)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT CASE WHEN s.currency_code = p_currency THEN s.id ELSE (
           SELECT a.id FROM fin_accounts a
            WHERE a.department_id = s.department_id AND a.currency_code = p_currency
              AND a.is_active AND a.kind = 'custodial'
            ORDER BY a.created_at LIMIT 1) END
    FROM fin_retreat_sponsors sp JOIN fin_accounts s ON s.id = sp.account_id
   WHERE sp.retreat_id = p_retreat;
$$;

-- ---------- цели: живые траты ретрита по валютам ----------
CREATE OR REPLACE FUNCTION fin_private_sponsor_targets(p_object uuid)
RETURNS TABLE (op uuid, currency_code text, on_date date, amount numeric, comment text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT o.id, p.currency_code, o.occurred_on, SUM(p.amount),
         left(COALESCE(NULLIF(btrim(o.comment), ''), string_agg(DISTINCT c.name, ', ')), 300)
    FROM fin_operations o
    JOIN fin_postings p ON p.operation_id = o.id
    LEFT JOIN fin_categories c ON c.id = p.category_id
   WHERE p.object_id = p_object AND o.type = 'expense' AND NOT o.is_reversed AND p.direction = 'out'
   GROUP BY o.id, p.currency_code, o.occurred_on;
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
  v_on date := least(p_on, current_date);
  v_rate numeric;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN RETURN; END IF;
  SELECT * INTO v_acc FROM fin_accounts WHERE id = p_account;
  -- ₹-эквивалент — только для сводных итогов, как у любой проводки (курс ретрита, иначе общий)
  v_rate := fin_private_get_rate(v_acc.currency_code, p_object, v_on);
  v_closed := EXISTS (SELECT 1 FROM fin_object_closures c WHERE c.object_id = p_object AND c.is_initial);
  INSERT INTO fin_operations (id, request_hash, type, occurred_on, approval, comment, created_by)
  VALUES (v_id, fin_private_hash(jsonb_build_object('command', 'sponsor_offset', 'id', v_id)),
          'income', v_on, 'not_required', p_comment, p_actor);
  INSERT INTO fin_postings (id, operation_id, account_id, direction, amount, currency_code,
    amount_base, rate_used, category_id, cost_center_id, object_id, is_post_close)
  VALUES (fin_private_child_uuid(v_id, 'offset'), v_id, p_account, 'in', p_amount, v_acc.currency_code,
    round(p_amount * v_rate, 2), v_rate,
    (SELECT id FROM fin_categories WHERE code = CASE p_kind WHEN 'prasad' THEN 'sponsor_prasad' ELSE 'sponsor_payment' END),
    v_acc.default_cost_center_id, p_object, v_closed);
  IF v_closed THEN
    UPDATE fin_accounting_objects SET report_dirty_at = now() WHERE id = p_object;
  END IF;
  INSERT INTO fin_sponsor_offsets (retreat_id, kind, source_operation_id, offset_operation_id, account_id, amount, currency_code)
  VALUES (p_retreat, p_kind, p_source, v_id, p_account, p_amount, v_acc.currency_code);
END;
$$;

-- ---------- синхронизация ----------
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

  -- спонсор снят или счёт в этой валюте сменился — прежние зачёты сторнируются
  FOR r IN SELECT offset_operation_id FROM fin_sponsor_offsets f
            WHERE f.retreat_id = p_retreat AND f.is_active
              AND (v_sp.retreat_id IS NULL OR v_obj IS NULL
                   OR f.account_id IS DISTINCT FROM fin_private_sponsor_account(p_retreat, f.currency_code)) LOOP
    PERFORM fin_private_sponsor_reverse(r.offset_operation_id, 'Спонсор ретрита снят или сменён');
  END LOOP;

  IF v_sp.retreat_id IS NOT NULL AND v_obj IS NOT NULL AND v_actor IS NOT NULL THEN
    -- траты: у каждой живой траты ретрита — зачёт в её валюте на той же сумме
    FOR r IN SELECT f.offset_operation_id FROM fin_sponsor_offsets f
              LEFT JOIN fin_private_sponsor_targets(v_obj) t
                     ON t.op = f.source_operation_id AND t.currency_code = f.currency_code
             WHERE f.retreat_id = p_retreat AND f.kind = 'expense' AND f.is_active
               AND (t.op IS NULL OR t.amount <> f.amount) LOOP
      PERFORM fin_private_sponsor_reverse(r.offset_operation_id, 'Трата ретрита отменена или изменена');
    END LOOP;

    FOR r IN SELECT t.*, fin_private_sponsor_account(p_retreat, t.currency_code) AS acc
               FROM fin_private_sponsor_targets(v_obj) t
              WHERE NOT EXISTS (SELECT 1 FROM fin_sponsor_offsets f
                                 WHERE f.source_operation_id = t.op AND f.currency_code = t.currency_code AND f.is_active) LOOP
      CONTINUE WHEN r.acc IS NULL;   -- нет счёта спонсора в этой валюте — ⚠ на странице
      PERFORM fin_private_sponsor_offset(p_retreat, 'expense', r.op, r.acc, v_obj, r.amount, r.on_date,
        format('%s — трата за счёт спонсора: %s', v_name, r.comment), v_actor);
    END LOOP;

    -- прасад (в ₹): цель — себестоимость, вошедшая в стоимость ретрита
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
    IF v_target > v_current AND fin_private_sponsor_account(p_retreat, 'INR') IS NOT NULL THEN
      PERFORM fin_private_sponsor_offset(p_retreat, 'prasad', NULL, fin_private_sponsor_account(p_retreat, 'INR'), v_obj,
        v_target - v_current, least(current_date, v_end),
        format('%s — себестоимость прасада за счёт спонсора%s', v_name,
               CASE WHEN v_current > 0 THEN ' (доначисление после пересчёта)' ELSE '' END), v_actor);
    END IF;
  END IF;

  PERFORM set_config('tg.suppress_chat_notify', v_prev_notify, true);
  PERFORM set_config('fin.sponsor_sync', '', true);
END;
$$;

-- триггер больше не ветвится на курсы
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

-- ---------- RPC: вместо «нет рыночного курса» — «нет счёта спонсора в валюте» ----------
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
    -- все счета спонсора (по департаменту счёта) — остаток расчётов в каждой валюте
    'sponsor_balances', COALESCE((SELECT jsonb_agg(jsonb_build_object('name', a.name, 'currency', a.currency_code,
                                     'balance', fin_private_account_balance(a.id)) ORDER BY a.currency_code)
                                    FROM fin_accounts a
                                   WHERE a.is_active AND a.department_id IS NOT NULL
                                     AND a.department_id = (SELECT department_id FROM fin_accounts WHERE id = v_sp.account_id)), '[]'::jsonb),
    -- зачтено по валютам: траты и прасад
    'offsets', COALESCE((SELECT jsonb_agg(jsonb_build_object('kind', kind, 'currency', currency_code, 'n', n, 'amount', s)
                                          ORDER BY kind, currency_code)
                           FROM (SELECT kind, currency_code, count(*) n, SUM(amount) s FROM fin_sponsor_offsets
                                  WHERE retreat_id = p_retreat AND is_active GROUP BY kind, currency_code) z), '[]'::jsonb),
    -- ⚠ траты в валюте, где у спонсора нет счёта — не зачтены
    'missing_accounts', COALESCE((SELECT jsonb_agg(jsonb_build_object('operation_id', t.op, 'date', t.on_date,
                                     'currency', t.currency_code, 'amount', t.amount) ORDER BY t.on_date)
                                    FROM fin_private_sponsor_targets(v_obj) t
                                   WHERE v_sp.account_id IS NOT NULL
                                     AND fin_private_sponsor_account(p_retreat, t.currency_code) IS NULL), '[]'::jsonb),
    -- кого можно выбрать: действующие подотчётные счета в ₹
    'candidates', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name) ORDER BY a.name)
                              FROM fin_accounts a WHERE a.is_active AND a.currency_code = 'INR' AND a.kind = 'custodial'), '[]'::jsonb)
  );
END;
$$;

REVOKE ALL ON FUNCTION fin_private_sponsor_account(uuid, text), fin_private_sponsor_targets(uuid),
  fin_private_sponsor_offset(uuid, text, uuid, uuid, uuid, numeric, date, text, uuid) FROM PUBLIC, anon, authenticated;

-- зачесть то, что раньше висело из-за курса (виза $105 художников)
DO $$
DECLARE v uuid;
BEGIN
  FOR v IN SELECT retreat_id FROM fin_retreat_sponsors LOOP
    PERFORM fin_private_sponsor_sync(v);
  END LOOP;
END
$$;
