-- Этап 4 интеграции: total_charged/total_paid считаются из финмодуля (решение 2.3/R2.4).
--
-- Единая формула (одна функция, вызывается и CRM-триггерами, и фин-триггерами):
--   total_paid   = legacy-платежи CRM (подтверждённые, БЕЗ фин-операции — история до
--                  автопроводки) + фин-сумма пары (signed-постинги участника по ретриту
--                  + opening-кредиты). Сторно самогасится зеркальной проводкой.
--   total_charged = фин-начисления пары (amount − discount, не отменённые, + opening-долги),
--                  если они есть; иначе — legacy-услуги CRM (crm_deal_services).
--
-- Переходный период: до переноса истории фин-часть старых сделок пуста → работает
-- legacy-слагаемое. При cutover истории (opening balances) legacy-платежи будут
-- помечены фин-операциями или удалены — формула сойдётся к чистому финмодулю.
--
-- Дубли сделок одной пары (участник+ретрит): фин-часть присваивается только основной
-- сделке (не cancelled, самой свежей), остальным — только их legacy, иначе задвоение.

CREATE OR REPLACE FUNCTION public.crm_calc_deal_totals(p_deal uuid, OUT o_charged numeric, OUT o_paid numeric)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_vaishnava uuid;
  v_retreat uuid;
  v_primary uuid;
  v_services numeric := 0;
  v_legacy numeric := 0;
  v_fin_charged numeric := 0;
  v_fin_paid numeric := 0;
  v_has_fin_charged boolean := false;
BEGIN
  SELECT vaishnava_id, retreat_id INTO v_vaishnava, v_retreat FROM crm_deals WHERE id = p_deal;

  SELECT COALESCE(SUM(total_price), 0) INTO v_services FROM crm_deal_services WHERE deal_id = p_deal;

  -- история: подтверждённые CRM-платежи, не имеющие операции в финмодуле
  SELECT COALESCE(SUM(cp.amount_inr), 0) INTO v_legacy
  FROM crm_payments cp
  WHERE cp.deal_id = p_deal AND cp.is_confirmed
    AND NOT EXISTS (SELECT 1 FROM fin_operations fo WHERE fo.id = cp.id);

  IF v_vaishnava IS NOT NULL AND v_retreat IS NOT NULL THEN
    SELECT id INTO v_primary FROM crm_deals
    WHERE vaishnava_id = v_vaishnava AND retreat_id = v_retreat
    ORDER BY (status = 'cancelled'), created_at DESC
    LIMIT 1;

    IF v_primary = p_deal THEN
      SELECT COALESCE(SUM(amount - discount_amount), 0), count(*) > 0
        INTO v_fin_charged, v_has_fin_charged
      FROM fin_charges
      WHERE participant_id = v_vaishnava AND retreat_id = v_retreat AND NOT is_cancelled;

      SELECT v_fin_charged + COALESCE(SUM(CASE WHEN kind = 'debt' THEN amount ELSE 0 END), 0),
             COALESCE(SUM(CASE WHEN kind <> 'debt' THEN amount ELSE 0 END), 0),
             v_has_fin_charged OR COALESCE(SUM(CASE WHEN kind = 'debt' THEN amount ELSE 0 END), 0) > 0
        INTO v_fin_charged, v_fin_paid, v_has_fin_charged
      FROM fin_participant_opening_balances
      WHERE participant_id = v_vaishnava AND retreat_id = v_retreat;

      v_fin_paid := v_fin_paid + COALESCE((
        SELECT SUM(CASE p.direction WHEN 'in' THEN p.amount_base ELSE -p.amount_base END)
        FROM fin_postings p
        JOIN fin_accounting_objects o ON o.id = p.object_id
        WHERE p.participant_id = v_vaishnava AND o.retreat_id = v_retreat
          AND p.participant_balance_kind IS NOT NULL
          AND p.participant_balance_kind <> 'none'), 0);
    END IF;
  END IF;

  o_paid := round(v_legacy + v_fin_paid, 2);
  o_charged := CASE WHEN v_has_fin_charged THEN round(v_fin_charged, 2) ELSE round(v_services, 2) END;
END;
$function$;

-- Писатель: применяет формулу к сделке
CREATE OR REPLACE FUNCTION public.crm_apply_deal_totals(p_deal uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v numeric; p numeric;
BEGIN
  SELECT o_charged, o_paid INTO v, p FROM crm_calc_deal_totals(p_deal);
  UPDATE crm_deals SET total_charged = v, total_paid = p
  WHERE id = p_deal AND (total_charged IS DISTINCT FROM v OR total_paid IS DISTINCT FROM p);
END;
$function$;

-- CRM-триггер услуг/платежей переводится на единую формулу
CREATE OR REPLACE FUNCTION public.crm_recalc_deal_finances()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
    PERFORM crm_apply_deal_totals(COALESCE(NEW.deal_id, OLD.deal_id));
    RETURN COALESCE(NEW, OLD);
END;
$function$;

-- Пересинхронизация от фин-событий: все сделки пары (участник, ретрит).
-- Ошибка витрины не должна ронять финансовую операцию — глотаем с WARNING.
CREATE OR REPLACE FUNCTION public.crm_resync_pair_totals(p_participant uuid, p_retreat uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  d record;
BEGIN
  IF p_participant IS NULL OR p_retreat IS NULL THEN RETURN; END IF;
  FOR d IN SELECT id FROM crm_deals WHERE vaishnava_id = p_participant AND retreat_id = p_retreat
  LOOP
    PERFORM crm_apply_deal_totals(d.id);
  END LOOP;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'crm_resync_pair_totals(%, %): %', p_participant, p_retreat, SQLERRM;
END;
$function$;

-- Триггеры финмодуля → витрина CRM
CREATE OR REPLACE FUNCTION public.fin_trg_resync_deal_totals()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_old_retreat uuid;
  v_new_retreat uuid;
BEGIN
  IF TG_TABLE_NAME = 'fin_postings' THEN
    IF TG_OP IN ('UPDATE', 'DELETE') AND OLD.participant_id IS NOT NULL THEN
      SELECT retreat_id INTO v_old_retreat FROM fin_accounting_objects WHERE id = OLD.object_id;
      PERFORM crm_resync_pair_totals(OLD.participant_id, v_old_retreat);
    END IF;
    IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.participant_id IS NOT NULL THEN
      SELECT retreat_id INTO v_new_retreat FROM fin_accounting_objects WHERE id = NEW.object_id;
      IF TG_OP = 'INSERT' OR NEW.participant_id IS DISTINCT FROM OLD.participant_id
         OR NEW.object_id IS DISTINCT FROM OLD.object_id THEN
        PERFORM crm_resync_pair_totals(NEW.participant_id, v_new_retreat);
      END IF;
    END IF;
  ELSE  -- fin_charges / fin_participant_opening_balances: пара прямо в строке
    IF TG_OP IN ('UPDATE', 'DELETE') THEN
      PERFORM crm_resync_pair_totals(OLD.participant_id, OLD.retreat_id);
    END IF;
    IF TG_OP IN ('INSERT', 'UPDATE') AND (TG_OP = 'INSERT'
        OR NEW.participant_id IS DISTINCT FROM OLD.participant_id
        OR NEW.retreat_id IS DISTINCT FROM OLD.retreat_id) THEN
      PERFORM crm_resync_pair_totals(NEW.participant_id, NEW.retreat_id);
    END IF;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$function$;

DROP TRIGGER IF EXISTS trg_resync_deal_totals ON fin_postings;
CREATE TRIGGER trg_resync_deal_totals
AFTER INSERT OR UPDATE OR DELETE ON fin_postings
FOR EACH ROW EXECUTE FUNCTION fin_trg_resync_deal_totals();

DROP TRIGGER IF EXISTS trg_resync_deal_totals ON fin_charges;
CREATE TRIGGER trg_resync_deal_totals
AFTER INSERT OR UPDATE OR DELETE ON fin_charges
FOR EACH ROW EXECUTE FUNCTION fin_trg_resync_deal_totals();

DROP TRIGGER IF EXISTS trg_resync_deal_totals ON fin_participant_opening_balances;
CREATE TRIGGER trg_resync_deal_totals
AFTER INSERT OR UPDATE OR DELETE ON fin_participant_opening_balances
FOR EACH ROW EXECUTE FUNCTION fin_trg_resync_deal_totals();

-- Витрина конверсии по оргвзносу для отдела продаж (R2.4: без новых колонок в crm_deals).
-- SECURITY DEFINER с явной проверкой is_staff: менеджер видит агрегат по оргвзносу,
-- не получая доступа к деталям финмодуля.
CREATE OR REPLACE FUNCTION public.crm_deal_org_fee_status(p_retreat uuid)
RETURNS TABLE (deal_id uuid, org_charged numeric, org_paid numeric, fully_paid boolean)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT is_staff(auth.uid()) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  RETURN QUERY
  SELECT d.id,
         round(COALESCE(ch.s, 0), 2),
         round(COALESCE(lg.s, 0) + COALESCE(pp.s, 0), 2),
         COALESCE(ch.s, 0) > 0 AND COALESCE(lg.s, 0) + COALESCE(pp.s, 0) >= COALESCE(ch.s, 0)
  FROM crm_deals d
  LEFT JOIN LATERAL (
    SELECT SUM(c.amount - c.discount_amount) AS s
    FROM fin_charges c
    WHERE c.participant_id = d.vaishnava_id AND c.retreat_id = d.retreat_id
      AND c.kind = 'org_fee' AND NOT c.is_cancelled
  ) ch ON true
  LEFT JOIN LATERAL (
    SELECT SUM(cp.amount_inr) AS s
    FROM crm_payments cp
    WHERE cp.deal_id = d.id AND cp.is_confirmed
      AND NOT EXISTS (SELECT 1 FROM fin_operations fo WHERE fo.id = cp.id)
  ) lg ON true
  LEFT JOIN LATERAL (
    SELECT SUM(CASE p.direction WHEN 'in' THEN p.amount_base ELSE -p.amount_base END) AS s
    FROM fin_postings p
    JOIN fin_accounting_objects o ON o.id = p.object_id
    WHERE p.participant_id = d.vaishnava_id AND o.retreat_id = d.retreat_id
      AND p.participant_balance_kind = 'org_fee'
  ) pp ON true
  WHERE d.retreat_id = p_retreat;
END;
$function$;
