-- 809: «оставить на сдачу» прямо при приёме кассы (ВГ 20.11.2026).
-- В калькуляторе купюр казначей отмечает номиналы галочкой — эти купюры остаются
-- в кассе Кафе / Магазина как сдача, их не уносят. Доход считается как раньше;
-- меняется только размен, одной операцией:
--   было выдано F, оставлено L:
--   F > L — в кассу казначея возвращается F − L;
--   F < L — недостающее L − F сразу выдаётся на сдачу (ни на кого);
--   F = L — размен не двигается.
-- После приёма «выдано на сдачу» = ровно L. Утром выдавать заново не нужно;
-- в Магазине кассир всё равно видит «Казначей выдал на сдачу ₹L» и подтверждает «Принял».

-- ── Касса кафе (и «Касса Магазин» из ДДС): payload.float_left ─────────────
CREATE OR REPLACE FUNCTION public.fin_create_cafe_collection(payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_float numeric := COALESCE(NULLIF(payload->>'cafe_float', '')::numeric, 0);
  v_left numeric := COALESCE(NULLIF(payload->>'float_left', '')::numeric, 0);
  v_net numeric;
  v_target uuid := NULLIF(payload->>'float_account_id', '')::uuid;
  v_dept uuid := COALESCE(NULLIF(payload->>'float_department_id', '')::uuid, fin_private_cafe_department());
  v_income jsonb := payload - 'cafe_float' - 'float_left' - 'float_account_id' - 'float_department_id';
  v_dept_name text;
  v_cur text; v_src uuid; v_have numeric;
  v_res jsonb; v_tr jsonb; v_msg text;
BEGIN
  IF v_float < 0 OR v_left < 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'invalid_payload',
      'message', 'Сдача не может быть отрицательной'));
  END IF;
  SELECT name INTO v_dept_name FROM fin_departments WHERE id = v_dept AND change_float;
  IF (v_float > 0 OR v_left > 0) AND v_dept_name IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'invalid_payload',
      'message', 'У этого департамента нет выдачи на сдачу'));
  END IF;
  v_net := round(v_float - v_left, 2);

  BEGIN
    IF jsonb_array_length(COALESCE(v_income->'rows', '[]'::jsonb)) > 0 THEN
      v_res := fin_create_income(v_income);
      IF NOT COALESCE((v_res->>'ok')::boolean, false) THEN RETURN v_res; END IF;
    END IF;

    IF v_float > 0 OR v_left > 0 THEN
      SELECT currency_code INTO v_cur FROM fin_accounts WHERE id = v_target AND is_active;
      IF v_cur IS NULL THEN
        RAISE EXCEPTION 'cafe_float' USING DETAIL = 'Не указан счёт, куда сдана сдача';
      END IF;
      v_src := fin_private_float_account(v_dept, v_cur);
      IF v_src IS NULL THEN
        RAISE EXCEPTION 'cafe_float' USING DETAIL = format('У департамента «%s» нет подотчётного счёта в %s', v_dept_name, v_cur);
      END IF;
      SELECT COALESCE(SUM(CASE direction WHEN 'in' THEN amount ELSE -amount END), 0) INTO v_have
        FROM fin_postings WHERE account_id = v_src AND holder_person_id IS NULL;
      IF round(v_float, 2) > round(v_have, 2) THEN
        RAISE EXCEPTION 'cafe_float' USING DETAIL =
          format('У «%s» выдано на сдачу %s, а указано %s', v_dept_name, fin_fmt_money(v_have, v_cur), fin_fmt_money(v_float, v_cur));
      END IF;

      PERFORM set_config('tg.suppress_chat_notify', '1', true);
      IF v_net > 0 THEN
        -- сдача вернулась в кассу казначея; оставленная часть так и лежит на сдаче
        v_tr := fin_create_transfer(jsonb_build_object(
          'request_id', fin_private_child_uuid((payload->>'request_id')::uuid, 'cafe-float-return'),
          'occurred_on', payload->>'occurred_on',
          'source_account_id', v_src, 'target_account_id', v_target,
          'source_amount', v_net, 'target_amount', v_net,
          'comment', format('Возврат сдачи — сдана вместе с кассой «%s»', v_dept_name)
                     || CASE WHEN v_left > 0 THEN format(' · %s оставлено на сдачу', fin_fmt_money(v_left, v_cur)) ELSE '' END
                     || COALESCE(' · ' || NULLIF(btrim(payload->>'comment'), ''), '')));
      ELSIF v_net < 0 THEN
        -- оставили больше, чем было выдано: разница — новая выдача на сдачу (ни на кого)
        v_tr := fin_create_transfer(jsonb_build_object(
          'request_id', fin_private_child_uuid((payload->>'request_id')::uuid, 'cafe-float-leave'),
          'occurred_on', payload->>'occurred_on',
          'source_account_id', v_target, 'target_account_id', v_src,
          'source_amount', -v_net, 'target_amount', -v_net,
          'comment', format('Оставлено на сдачу при приёме кассы «%s» — всего на сдаче %s', v_dept_name, fin_fmt_money(v_left, v_cur))
                     || COALESCE(' · ' || NULLIF(btrim(payload->>'comment'), ''), '')));
      END IF;
      PERFORM set_config('tg.suppress_chat_notify', '', true);
      IF v_tr IS NOT NULL AND NOT COALESCE((v_tr->>'ok')::boolean, false) THEN
        RAISE EXCEPTION 'cafe_float' USING DETAIL = COALESCE(v_tr#>>'{error,message}', 'не удалось провести сдачу');
      END IF;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = PG_EXCEPTION_DETAIL;
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'cafe_float',
      'message', COALESCE(NULLIF(v_msg, ''), SQLERRM)));
  END;

  RETURN COALESCE(v_res, v_tr, jsonb_build_object('ok', true));
END;
$function$;

-- ── Выручка магазина со страницы смены: payload.float_left (₹) ────────────
alter table public.shop_handovers
    add column if not exists float_left numeric not null default 0;
comment on column public.shop_handovers.float_left is
    'Сколько ₹ казначей оставил в ящике на сдачу при приёме (809): вернулось float_amount − float_left';

CREATE OR REPLACE FUNCTION public.shop_accept_handover(payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
    v_id        uuid := (payload->>'handover_id')::uuid;
    v_on        date := coalesce((payload->>'occurred_on')::date, current_date);
    v_left      numeric := round(coalesce(nullif(payload->>'float_left', '')::numeric, 0), 2);
    v_net       numeric;
    v_пакет     shop_handovers%rowtype;
    v_line      record;
    v_account   uuid;
    v_acc       fin_accounts%rowtype;
    v_rows      jsonb;
    v_res       jsonb;
    v_obj_shop  uuid;
    v_obj_murti uuid;
    v_cat_goods uuid;
    v_cat_murti uuid;
    v_cat_gift  uuid;
    v_cat_short uuid;
    v_cat_surp  uuid;
    v_cat_minus uuid;
    v_src       uuid;
    v_есть      numeric;
    v_итоги     jsonb := '[]'::jsonb;
begin
    if not fin_is_admin() then
        raise exception 'Принять выручку может только администратор финансов' using errcode = '42501';
    end if;
    if v_left < 0 then raise exception 'Оставить на сдачу можно только положительную сумму'; end if;

    perform pg_advisory_xact_lock(hashtext('shop_accept_handover'));

    select * into v_пакет from shop_handovers where id = v_id and status = 'pending' for update;
    if not found then
        raise exception 'Пакет не найден или уже принят';
    end if;

    select id into v_obj_shop  from fin_accounting_objects where display_name = 'Магазин';
    select id into v_obj_murti from fin_accounting_objects where display_name = 'Мурти Госвами';
    select id into v_cat_goods from fin_categories where code = 'shop_cash';
    select id into v_cat_murti from fin_categories where code = 'murti';
    select id into v_cat_gift  from fin_categories where code = 'shop_donation';
    select id into v_cat_short from fin_categories where code = 'shop_cash_shortage';
    select id into v_cat_surp  from fin_categories where code = 'shop_cash_surplus';

    for v_line in select * from shop_handover_lines where handover_id = v_id loop
        v_account := (payload#>>array['accounts', v_line.currency_code])::uuid;
        if v_account is null then
            raise exception 'Не выбран счёт для валюты %', v_line.currency_code;
        end if;
        select * into v_acc from fin_accounts where id = v_account;
        if not found or not v_acc.is_active then raise exception 'Счёт не найден или закрыт'; end if;
        if v_acc.currency_code <> v_line.currency_code then
            raise exception 'Счёт «%» ведётся в %, а сдаются %',
                v_acc.name, v_acc.currency_code, v_line.currency_code;
        end if;
        if coalesce(v_acc.group_name, '') <> 'Касса' then
            raise exception 'Наличная выручка принимается только в кассу, а «%» — это %',
                v_acc.name, coalesce(v_acc.group_name, 'счёт вне групп');
        end if;

        v_rows := '[]'::jsonb;
        if v_line.goods_amount > 0 then
            v_rows := v_rows || jsonb_build_object(
                'id', fin_private_child_uuid(v_line.id, 'shop-goods'),
                'account_id', v_account, 'amount', round(v_line.goods_amount, 2),
                'category_id', v_cat_goods, 'object_id', v_obj_shop, 'payment_channel', 'cash');
        end if;
        if v_line.murti_amount > 0 then
            v_rows := v_rows || jsonb_build_object(
                'id', fin_private_child_uuid(v_line.id, 'shop-murti'),
                'account_id', v_account, 'amount', round(v_line.murti_amount, 2),
                'category_id', v_cat_murti, 'object_id', v_obj_murti, 'payment_channel', 'cash');
        end if;
        if v_line.donation_amount > 0 then
            v_rows := v_rows || jsonb_build_object(
                'id', fin_private_child_uuid(v_line.id, 'shop-donation'),
                'account_id', v_account, 'amount', round(v_line.donation_amount, 2),
                'category_id', v_cat_gift, 'object_id', v_obj_shop, 'payment_channel', 'cash');
        end if;

        if jsonb_array_length(v_rows) > 0 then
            v_res := fin_create_income(jsonb_build_object(
                'request_id', fin_private_child_uuid(v_line.id, 'shop-handover'),
                'occurred_on', v_on,
                'comment', format('Выручка магазина, сдана %s', to_char(v_on, 'DD.MM.YYYY'))
                           || case when v_line.change_amount > 0
                                   then format(' · за вычетом сдачи рупиями за валюту ₹%s', round(v_line.change_amount))
                                   else '' end,
                'rows', v_rows));
            if not coalesce((v_res->>'ok')::boolean, false) then
                raise exception 'Финмодуль отклонил выручку: %',
                    coalesce(v_res#>>'{error,message}', v_res::text);
            end if;
            update shop_handover_lines set operation_id = (v_res#>>'{result,operation_id}')::uuid
             where id = v_line.id;
        end if;

        -- минус в строке: деньги, выданные из ящика, — сдача рупиями за валюту или возвраты
        if v_line.goods_amount < 0 or v_line.murti_amount < 0 then
            v_cat_minus := (select id from fin_categories
                             where code = case when v_line.change_amount > 0 then 'shop_fx_change' else 'shop_refund' end);
            v_rows := '[]'::jsonb;
            if v_line.goods_amount < 0 then
                v_rows := v_rows || jsonb_build_object(
                    'id', fin_private_child_uuid(v_line.id, 'shop-refund-goods'),
                    'account_id', v_account, 'amount', round(abs(v_line.goods_amount), 2),
                    'category_id', v_cat_minus, 'object_id', v_obj_shop, 'payment_channel', 'cash');
            end if;
            if v_line.murti_amount < 0 then
                v_rows := v_rows || jsonb_build_object(
                    'id', fin_private_child_uuid(v_line.id, 'shop-refund-murti'),
                    'account_id', v_account, 'amount', round(abs(v_line.murti_amount), 2),
                    'category_id', v_cat_minus, 'object_id', v_obj_murti, 'payment_channel', 'cash');
            end if;
            v_res := fin_create_expense(jsonb_build_object(
                'request_id', fin_private_child_uuid(v_line.id, 'shop-refund'),
                'occurred_on', v_on,
                'comment', case when v_line.change_amount > 0
                                then format('Сдача рупиями за валютную оплату в магазине за %s', to_char(v_on, 'DD.MM.YYYY'))
                                else format('Возвраты покупателям магазина за %s', to_char(v_on, 'DD.MM.YYYY')) end,
                'rows', v_rows));
            if not coalesce((v_res->>'ok')::boolean, false) then
                raise exception 'Финмодуль отклонил минус по кассе: %',
                    coalesce(v_res#>>'{error,message}', v_res::text);
            end if;
        end if;

        if v_line.discrepancy < 0 then
            v_res := fin_create_expense(jsonb_build_object(
                'request_id', fin_private_child_uuid(v_line.id, 'shop-shortage'),
                'occurred_on', v_on,
                'comment', format('Недостача кассы магазина за %s', to_char(v_on, 'DD.MM.YYYY')),
                'rows', jsonb_build_array(jsonb_build_object(
                    'id', fin_private_child_uuid(v_line.id, 'shop-shortage-row'),
                    'account_id', v_account, 'amount', round(abs(v_line.discrepancy), 2),
                    'category_id', v_cat_short, 'object_id', v_obj_shop, 'payment_channel', 'cash'))));
            if not coalesce((v_res->>'ok')::boolean, false) then
                raise exception 'Финмодуль отклонил недостачу: %',
                    coalesce(v_res#>>'{error,message}', v_res::text);
            end if;
        elsif v_line.discrepancy > 0 then
            v_res := fin_create_income(jsonb_build_object(
                'request_id', fin_private_child_uuid(v_line.id, 'shop-surplus'),
                'occurred_on', v_on,
                'comment', format('Излишек кассы магазина за %s', to_char(v_on, 'DD.MM.YYYY')),
                'rows', jsonb_build_array(jsonb_build_object(
                    'id', fin_private_child_uuid(v_line.id, 'shop-surplus-row'),
                    'account_id', v_account, 'amount', round(v_line.discrepancy, 2),
                    'category_id', v_cat_surp, 'object_id', v_obj_shop, 'payment_channel', 'cash'))));
            if not coalesce((v_res->>'ok')::boolean, false) then
                raise exception 'Финмодуль отклонил излишек: %',
                    coalesce(v_res#>>'{error,message}', v_res::text);
            end if;
        end if;

        v_итоги := v_итоги || jsonb_build_object(
            'валюта', v_line.currency_code,
            'выручка', round(v_line.goods_amount + v_line.murti_amount + v_line.donation_amount, 2),
            'расхождение', v_line.discrepancy);
    end loop;

    -- размен сдан вместе с ящиком: возвращаем его с подотчёта магазина в кассу,
    -- кроме того, что казначей оставил в ящике на сдачу (809)
    v_net := round(v_пакет.float_amount - v_left, 2);
    if v_пакет.float_amount > 0 or v_left > 0 then
        v_account := (payload#>>'{accounts,INR}')::uuid;
        select * into v_acc from fin_accounts where id = v_account;
        if not found or not v_acc.is_active or v_acc.currency_code <> 'INR'
           or coalesce(v_acc.group_name, '') <> 'Касса' then
            raise exception 'Выберите кассу в ₹, куда вернётся размен ₹%', round(v_пакет.float_amount);
        end if;
        v_src := shop_float_account();
        if v_src is null then raise exception 'У Магазина нет подотчётного счёта в ₹'; end if;
        select coalesce(sum(case direction when 'in' then amount else -amount end), 0) into v_есть
          from fin_postings where account_id = v_src and holder_person_id is null;
        if round(v_есть, 2) < round(v_пакет.float_amount, 2) then
            raise exception 'В сменах размен ₹%, а казначей выдавал магазину ₹% — сначала разберите размен',
                round(v_пакет.float_amount), round(v_есть);
        end if;
        v_res := null;
        perform set_config('tg.suppress_chat_notify', '1', true);
        if v_net > 0 then
            v_res := fin_create_transfer(jsonb_build_object(
                'request_id', fin_private_child_uuid(v_id, 'shop-float-return'),
                'occurred_on', v_on,
                'source_account_id', v_src, 'target_account_id', v_account,
                'source_amount', v_net, 'target_amount', v_net,
                'comment', 'Размен магазина вернулся вместе с выручкой'
                           || case when v_left > 0 then format(' · ₹%s оставлено в ящике на сдачу', round(v_left)) else '' end));
        elsif v_net < 0 then
            v_res := fin_create_transfer(jsonb_build_object(
                'request_id', fin_private_child_uuid(v_id, 'shop-float-leave'),
                'occurred_on', v_on,
                'source_account_id', v_account, 'target_account_id', v_src,
                'source_amount', -v_net, 'target_amount', -v_net,
                'comment', format('Оставлено в ящике магазина на сдачу при приёме выручки — всего ₹%s', round(v_left))));
        end if;
        perform set_config('tg.suppress_chat_notify', '', true);
        if v_res is not null then
            if not coalesce((v_res->>'ok')::boolean, false) then
                raise exception 'Финмодуль не провёл размен: %', coalesce(v_res#>>'{error,message}', v_res::text);
            end if;
            update shop_handovers set float_operation_id = (v_res#>>'{result,operation_id}')::uuid where id = v_id;
        end if;
    end if;

    update shop_handovers
       set status = 'accepted', accepted_at = now(), accepted_by = auth.uid(), float_left = v_left
     where id = v_id;

    return jsonb_build_object('ok', true, 'handover_id', v_id, 'итоги', v_итоги,
                              'размен', v_пакет.float_amount, 'оставлено', v_left);
end $function$;
