-- Детализация строки отчёта по ретриту (ВГ, сен 2026): клик по статье на
-- «Аналитике» показывает список операций, из которых она состоит.
--
-- Разбивка на юниты (ретрит / прасад / кафе) и на группы внутри «Оплаты от
-- участника» (оргвзнос/проживание/питание/…) повторяет fin_private_build_snapshot
-- буквально — иначе сумма списка разошлась бы с суммой строки. Если меняются
-- правила там (435/437/440), менять надо и здесь.
--
-- Суммы со знаком (сторно вычитается), как в отчёте.
CREATE OR REPLACE FUNCTION fin_get_report_drilldown(
  p_object uuid, p_unit text, p_direction text, p_group text
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_rows jsonb;
  v_total numeric;
BEGIN
  IF NOT fin_can_read_all() THEN
    RAISE EXCEPTION 'forbidden' USING DETAIL = 'Недостаточно прав';
  END IF;
  IF p_unit NOT IN ('retreat', 'prasad', 'cafe') OR p_direction NOT IN ('in', 'out') THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'unit: retreat|prasad|cafe, direction: in|out';
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'operation_id', y.operation_id,
           'occurred_on', y.occurred_on,
           'type', y.type,
           'description', y.comment,
           'reason', y.reason,
           'account', y.account_name,
           'currency', y.currency_code,
           'amount', y.amt_signed,
           'amount_base', y.base_signed,
           'participant', y.participant_name,
           'entered_by', y.entered_by
         ) ORDER BY y.occurred_on DESC, y.created_at DESC), '[]'::jsonb),
         COALESCE(SUM(y.base_signed), 0)
    INTO v_rows, v_total
  FROM (
    SELECT x.*,
           CASE WHEN x.participant_id IS NOT NULL THEN fin_private_person_name(x.participant_id) END AS participant_name,
           COALESCE(
             fin_private_person_name((SELECT v.id FROM vaishnavas v WHERE v.user_id = x.created_by LIMIT 1)),
             (SELECT pr.name FROM profiles pr WHERE pr.id = x.created_by)) AS entered_by
    FROM (
      SELECT p.operation_id, o.occurred_on, o.type, o.comment, o.reason, o.created_at, o.created_by,
             a.name AS account_name, p.currency_code, p.participant_id,
             CASE WHEN p.direction::text = p_direction THEN p.amount ELSE -p.amount END AS amt_signed,
             CASE WHEN p.direction::text = p_direction THEN p.amount_base ELSE -p.amount_base END AS base_signed,
             CASE
               WHEN c.direction::text = 'in' AND c.name = 'Касса кафе' THEN 'cafe'
               WHEN c.direction::text = 'in' AND (c.name = 'Прасад - пожертвование' OR p.participant_balance_kind = 'meals') THEN 'prasad'
               WHEN c.direction::text = 'out' AND c.name IN ('Прасад', 'Закупка готового Прасада') THEN 'prasad'
               WHEN c.direction::text = 'out' AND a.name ILIKE '%кафе%' THEN 'cafe'
               ELSE 'retreat'
             END AS unit,
             CASE
               WHEN c.direction::text = 'in' AND c.name = 'Оплата от участника'
                    AND p.participant_balance_kind IN ('org_fee', 'accommodation', 'meals', 'extra', 'general')
                 THEN p.participant_balance_kind::text
               ELSE p.category_id::text
             END AS grp_id
      FROM fin_postings p
      JOIN fin_operations o ON o.id = p.operation_id
      JOIN fin_categories c ON c.id = p.category_id
      JOIN fin_accounts a ON a.id = p.account_id
      WHERE p.object_id = p_object AND c.direction::text = p_direction
    ) x
    WHERE x.unit = p_unit AND x.grp_id = p_group
  ) y;

  RETURN jsonb_build_object('ok', true, 'result', jsonb_build_object(
    'rows', v_rows, 'total_base', v_total));
END;
$$;

REVOKE ALL ON FUNCTION fin_get_report_drilldown(uuid, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fin_get_report_drilldown(uuid, text, text, text) TO authenticated;
