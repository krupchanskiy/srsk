-- Вопрос ВГ от 26.07.2026: «как взаимодействовать с курсами, ни удалить, ни
-- изменить, только добавлять новый?»
--
-- Он прав: в справочнике у курсов не было ни кнопки правки, ни удаления.
-- Изменить курс было можно только вслепую — добавив запись с той же датой и
-- валютой (fin_save_exchange_rate делает upsert), но в интерфейсе это никак
-- не подсказывалось.
--
-- Прошлые операции при этом не меняются: проводка хранит собственный
-- rate_used, снятый в момент проведения. Курс — это справочник на дату, а не
-- источник истины для уже проведённого. Поэтому и правка, и удаление
-- безопасны для истории.

CREATE OR REPLACE FUNCTION public.fin_delete_exchange_rate(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_id uuid;
  v_row fin_exchange_rates%ROWTYPE;
  v_detail text;
BEGIN
  IF NOT fin_is_admin() THEN
    RAISE EXCEPTION 'forbidden' USING DETAIL = 'Только администратор финансов';
  END IF;
  PERFORM fin_private_assert_keys(payload, ARRAY['id']);
  v_id := fin_private_get_uuid(payload, 'id', true);

  SELECT * INTO v_row FROM fin_exchange_rates WHERE id = v_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Курс не найден';
  END IF;

  DELETE FROM fin_exchange_rates WHERE id = v_id;

  RETURN jsonb_build_object('ok', true, 'result', jsonb_build_object(
    'id', v_id, 'from_currency', v_row.from_currency, 'effective_date', v_row.effective_date));
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
  IF SQLERRM ~ '^[a-z_]{3,60}$' THEN
    RETURN jsonb_build_object('ok', false, 'error',
      jsonb_build_object('code', SQLERRM, 'message', COALESCE(NULLIF(v_detail, ''), SQLERRM)));
  END IF;
  RETURN jsonb_build_object('ok', false, 'error',
    jsonb_build_object('code', 'internal_error', 'message', SQLERRM));
END;
$function$;

REVOKE ALL ON FUNCTION public.fin_delete_exchange_rate(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fin_delete_exchange_rate(jsonb) TO authenticated;

COMMENT ON FUNCTION public.fin_delete_exchange_rate(jsonb) IS
  'Удалить курс из справочника. История не затрагивается: проводки хранят собственный rate_used.';
