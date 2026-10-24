-- 750: у ретрита один курс на валюту (ВГ 24.10)
-- Курс ретрита фиксированный: весь расчёт события опирается на него
-- (fin_private_retreat_rate берёт свой курс при любой дате). Второй курс той же
-- валюты у ретрита превратил бы его «по дате» — молча. Поэтому в базе запрет,
-- а в форме — правка существующего. Общий курс (object_id is null) — как был,
-- история по датам.

create unique index if not exists fin_exchange_rates_object_currency_uniq
  on fin_exchange_rates (object_id, from_currency)
  where object_id is not null;

CREATE OR REPLACE FUNCTION public.fin_save_exchange_rate(payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_id uuid;
  v_rate numeric;
  v_detail text;
  v_object uuid;
  v_date date;
  v_old date;
BEGIN
  IF NOT fin_is_admin() THEN
    RAISE EXCEPTION 'forbidden' USING DETAIL = 'Только администратор финансов';
  END IF;
  PERFORM fin_private_assert_keys(payload, ARRAY['object_id','effective_date','from_currency','rate']);
  v_rate := (payload->>'rate')::numeric;
  IF v_rate IS NULL OR v_rate <= 0 THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Курс должен быть > 0';
  END IF;
  IF payload->>'from_currency' = 'INR' THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Курс INR всегда 1 — не задаётся';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM fin_currencies WHERE code = payload->>'from_currency' AND is_active) THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Неизвестная валюта';
  END IF;

  v_object := fin_private_get_uuid(payload, 'object_id');
  v_date := fin_private_get_date(payload, 'effective_date', true);

  -- курс ретрита один на валюту: с другой датой — это уже второй курс
  IF v_object IS NOT NULL THEN
    SELECT effective_date INTO v_old FROM fin_exchange_rates
     WHERE object_id = v_object AND from_currency = payload->>'from_currency'
       AND effective_date <> v_date;
    IF FOUND THEN
      RAISE EXCEPTION 'retreat_rate_exists' USING DETAIL = format(
        'У ретрита уже есть курс %s (с %s) — он зафиксирован на весь ретрит. Поправьте его карандашом, второй курс не заводится.',
        payload->>'from_currency', to_char(v_old, 'DD.MM.YYYY'));
    END IF;
  END IF;

  INSERT INTO fin_exchange_rates (object_id, effective_date, from_currency, rate, created_by)
  VALUES (v_object, v_date, payload->>'from_currency', round(v_rate, 6), fin_actor())
  ON CONFLICT (object_id, effective_date, from_currency)
  DO UPDATE SET rate = EXCLUDED.rate, created_by = EXCLUDED.created_by, created_at = now()
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('ok', true, 'result', jsonb_build_object('id', v_id));
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_detail = PG_EXCEPTION_DETAIL;
  IF SQLERRM ~ '^[a-z_]{3,60}$' THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', SQLERRM, 'message', COALESCE(NULLIF(v_detail, ''), SQLERRM)));
  END IF;
  RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'internal_error', 'message', SQLERRM));
END;
$function$;

insert into translations (key, ru, en, hi, page) values
  ('fin_rate_fixed', 'зафиксирован', 'fixed', 'निश्चित', 'Справочники'),
  ('fin_rate_fixed_hint', 'Курс зафиксирован на весь ретрит: расчёт ретрита опирается на него при любой дате.',
   'The rate is fixed for the whole retreat: all retreat calculations use it regardless of date.',
   'दर पूरे रिट्रीट के लिए निश्चित है।', 'Справочники'),
  ('fin_rate_upcoming', 'с этой даты', 'from this date', 'इस तारीख से', 'Справочники'),
  ('fin_rate_prev', 'было', 'was', 'पहले', 'Справочники'),
  ('fin_rates_current', 'Текущие', 'Current', 'वर्तमान', 'Справочники'),
  ('fin_rates_chart', 'График', 'Chart', 'चार्ट', 'Справочники'),
  ('fin_rates_archive', 'Архив', 'Archive', 'संग्रह', 'Справочники'),
  ('fin_rates_retreats', 'Курсы ретритов', 'Retreat rates', 'रिट्रीट दरें', 'Справочники'),
  ('fin_rates_both', 'Оба', 'Both', 'दोनों', 'Справочники'),
  ('fin_rates_no_own', 'нет своего курса — считается по общему на дату операции',
   'no own rate — the general rate on the operation date is used', 'अपनी दर नहीं — सामान्य दर लागू', 'Справочники'),
  ('fin_rates_no_retreats', 'Нет предстоящих и идущих ретритов со своим курсом',
   'No upcoming or ongoing retreats with their own rate', 'अपनी दर वाले कोई आगामी रिट्रीट नहीं', 'Справочники'),
  ('fin_rates_archive_empty', 'В архиве пока пусто', 'The archive is empty', 'संग्रह खाली है', 'Справочники'),
  ('fin_rates_p3', '3 мес', '3 mo', '3 माह', 'Справочники'),
  ('fin_rates_p6', '6 мес', '6 mo', '6 माह', 'Справочники'),
  ('fin_rates_p12', 'Год', 'Year', 'वर्ष', 'Справочники'),
  ('fin_rates_all', 'Всё', 'All', 'सभी', 'Справочники'),
  ('fin_rates_chart_empty', 'За этот период курсов нет', 'No rates for this period', 'इस अवधि में कोई दर नहीं', 'Справочники')
on conflict (key) do update set ru = excluded.ru, en = excluded.en, hi = excluded.hi;
