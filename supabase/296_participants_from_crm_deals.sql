-- Продолжение находки ВГ от 26.07.2026 («связь CRM с базой вайшнавов»).
--
-- Померено: по Сева-ретриту 99 живых сделок в CRM и 44 регистрации в модуле
-- проживания, пересечение — НОЛЬ человек. Ни по id, ни по телефону, ни по
-- духовному имени. Это два независимых списка гостей одного ретрита, и оба
-- ведутся активно (регистрации до 27.07, сделки до 28.07).
--
-- Из 91 человека, у кого сделка подтверждена или оплачена, в размещении нет
-- никого. Перевод сделки в регистрацию нигде в продукте не реализован.
--
-- Здесь чиню только финансовую часть: список участников ретрита обязан
-- показывать тех, кто ретрит КУПИЛ, иначе казначей не найдёт плательщика.
-- Лиды и отменённые не берём: у лида ещё нет обязательств.
-- Сева-ретрит: было 46 строк, стало 145.
--
-- Общая проблема (размещение, прасад, трансферы не видят покупателей CRM)
-- решается отдельно и не в базе — это продуктовое решение о том, кто владеет
-- списком гостей.

CREATE OR REPLACE FUNCTION public.fin_list_retreat_participants(p_retreat uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_result jsonb;
BEGIN
  IF NOT fin_can_read_all() THEN
    RAISE EXCEPTION 'forbidden' USING DETAIL = 'Недостаточно прав';
  END IF;

  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'participant_id', ids.pid,
      'name', fin_private_person_name(ids.pid),
      'balance', fin_private_participant_balance(ids.pid, p_retreat)
    ) ORDER BY fin_private_person_name(ids.pid)
  ), '[]'::jsonb) INTO v_result
  FROM (
    SELECT DISTINCT participant_id AS pid FROM fin_charges WHERE retreat_id = p_retreat
    UNION
    SELECT DISTINCT participant_id FROM fin_participant_opening_balances WHERE retreat_id = p_retreat
    UNION
    SELECT DISTINCT p.participant_id FROM fin_postings p
    JOIN fin_accounting_objects o ON o.id = p.object_id
    WHERE o.retreat_id = p_retreat AND p.participant_id IS NOT NULL
    UNION
    -- зарегистрированные в модуле проживания
    SELECT DISTINCT rr.vaishnava_id FROM retreat_registrations rr
    WHERE rr.retreat_id = p_retreat AND rr.status <> 'cancelled' AND rr.vaishnava_id IS NOT NULL
    UNION
    -- купившие через CRM: именно они платят, и именно их казначей ищет
    SELECT DISTINCT cd.vaishnava_id FROM crm_deals cd
    WHERE cd.retreat_id = p_retreat
      AND cd.status NOT IN ('lead', 'cancelled')
      AND cd.vaishnava_id IS NOT NULL
  ) ids
  WHERE ids.pid IS NOT NULL;

  RETURN jsonb_build_object('ok', true, 'result', v_result);
END;
$function$;
