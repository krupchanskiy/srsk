-- 824: касса магазина — доплата рупиями к валютному чеку (ВГ 21.11.2026)
--
-- Покупатель отдаёт, например, 5 € и недостающее — рупиями. Чек остаётся валютным:
-- paid_amount — сколько валюты дали, extra_inr — сколько рупий доплатили,
-- change_inr — сколько рупий выдано сдачей. В ящике: +валюта, +extra_inr, −change_inr.
-- Сдача при доплате рупиями округляется вниз до 10 ₹ (без доплаты — по-прежнему до 50 ₹).
-- Возврат по такому чеку, как и прежде по валютным, считается в валюте чека.

-- ── схема ────────────────────────────────────────────────────────────────
alter table public.shop_sales
    add column if not exists extra_inr numeric not null default 0;
do $$ begin
    alter table public.shop_sales add constraint shop_sales_extra_inr_check check (extra_inr >= 0);
exception when duplicate_object then null; end $$;
comment on column public.shop_sales.extra_inr is
    'Доплата рупиями к валютному чеку: paid_amount — валюта, extra_inr — ₹, change_inr — сдача ₹';

-- ── ожидаемое в ящике смены: + доплата рупиями ──────────────────────────
create or replace function public.shop_shift_expected(p_shift uuid)
returns table(currency_code text, expected numeric)
language sql stable security definer
set search_path to 'public', 'pg_temp'
as $function$
    with дв as (
        select s.currency_code as вал, s.paid_amount as сумма from shop_sales s
         where s.shift_id = p_shift and s.status = 'posted'
        union all
        select 'INR', -s.change_inr from shop_sales s
         where s.shift_id = p_shift and s.status = 'posted' and s.change_inr > 0
        union all
        select 'INR', s.extra_inr from shop_sales s
         where s.shift_id = p_shift and s.status = 'posted' and s.extra_inr > 0
        union all
        select rs.currency_code, -r.refund_amount from shop_returns r
          join shop_sales rs on rs.id = r.sale_id and rs.status = 'posted'
         where r.shift_id = p_shift
        union all
        select 'INR', coalesce((select float_amount from shop_shifts where id = p_shift), 0)
    )
    select c.code, coalesce(sum(дв.сумма), 0)
    from fin_currencies c
    join дв on дв.вал = c.code
    where c.is_active and shop_can_view()
    group by c.code
    -- валюта нужна в пересчёте, если в ней было хоть какое-то движение, даже если в сумме ноль
    having bool_or(дв.сумма <> 0)
$function$;

-- ── продажа: валюта + доплата рупиями ───────────────────────────────────
do $$
declare
    тело text := pg_get_functiondef('public.shop_post_sale(jsonb)'::regprocedure);
    я1 text := E'    v_в_ящике    numeric;\nbegin';
    в1 text := E'    v_в_ящике    numeric;\n'
            || E'    v_доплата    numeric := coalesce(nullif(payload->>''extra_inr'', '''')::numeric, 0);\nbegin';
    я2 text := E'    if v_donation < 0 then raise exception ''Пожертвование не может быть отрицательным''; end if;';
    в2 text := я2 || E'\n'
            || E'    if v_доплата < 0 then raise exception ''Доплата рупиями не может быть отрицательной''; end if;\n'
            || E'    if v_доплата > 0 and v_currency = ''INR'' then\n'
            || E'        raise exception ''Доплата рупиями бывает только к оплате валютой'';\n'
            || E'    end if;';
    я3 text := E'        if v_получено * v_rate < v_нужно_р - 0.005 then\n'
            || E'            raise exception ''Не хватает: получено % % (₹%), а к оплате ₹%'',\n'
            || E'                v_получено, v_currency, round(v_получено * v_rate), round(v_нужно_р);';
    в3 text := E'        if v_получено * v_rate + v_доплата < v_нужно_р - 0.005 then\n'
            || E'            raise exception ''Не хватает: получено % % и ₹% (всего ₹%), а к оплате ₹%'',\n'
            || E'                v_получено, v_currency, v_доплата, round(v_получено * v_rate + v_доплата), round(v_нужно_р);';
    я4 text := E'        v_сдача_р := greatest(floor(round(v_получено * v_rate - v_нужно_р, 2) / 50) * 50, 0);';
    в4 text := E'        -- с доплатой рупиями сдача точнее — до 10 ₹, иначе до 50 ₹\n'
            || E'        v_сдача_р := greatest(floor(round(v_получено * v_rate + v_доплата - v_нужно_р, 2)\n'
            || E'                     / case when v_доплата > 0 then 10 else 50 end)\n'
            || E'                     * case when v_доплата > 0 then 10 else 50 end, 0);';
    я5 text := E'        if v_сдача_р > v_в_ящике then';
    в5 text := E'        if v_сдача_р > v_в_ящике + v_доплата then';
    я6 text := E'paid_amount = v_получено, change_inr = v_сдача_р\n';
    в6 text := E'paid_amount = v_получено, change_inr = v_сдача_р,\n'
            || E'                              extra_inr = v_доплата\n';
begin
    if position(я1 in тело) = 0 or position(я2 in тело) = 0 or position(я3 in тело) = 0
       or position(я4 in тело) = 0 or position(я5 in тело) = 0 or position(я6 in тело) = 0 then
        raise exception 'shop_post_sale изменилась — правку надо переписать';
    end if;
    execute replace(replace(replace(replace(replace(replace(тело,
        я1, в1), я2, в2), я3, в3), я4, в4), я5, в5), я6, в6);
end $$;

-- ── возврат: товарная часть в валюте чека учитывает и доплату рупиями ────
do $$
declare
    тело text := pg_get_functiondef('public.shop_return_sale(jsonb)'::regprocedure);
    я text := E'                  - coalesce(v_sale.change_inr, 0) / nullif(v_sale.rate_used, 0);';
    в text := E'                  + (coalesce(v_sale.extra_inr, 0) - coalesce(v_sale.change_inr, 0))\n'
           || E'                    / nullif(v_sale.rate_used, 0);';
begin
    if position(я in тело) = 0 then raise exception 'shop_return_sale изменилась'; end if;
    execute replace(тело, я, в);
end $$;

-- ── пакет сдачи: доплата рупиями — товарная выручка в строке ₹ ──────────
do $$
declare
    тело text := pg_get_functiondef('public.shop_prepare_handover(text)'::regprocedure);
    я text := E'              from продажи where change_inr > 0\n';
    в text := я
           || E'            union all\n'
           || E'            -- доплата рупиями к валютному чеку (824): рупии ящика, та же доля мурти\n'
           || E'            select ''INR'', extra_inr, extra_inr * доля, 0, 0\n'
           || E'              from продажи where extra_inr > 0\n';
begin
    if position(я in тело) = 0 then raise exception 'shop_prepare_handover изменилась'; end if;
    execute replace(тело, я, в);
end $$;

-- ── переводы новых строк ─────────────────────────────────────────────────
insert into public.translations (key, ru, en, hi, page) values
    ('shop_extra_inr',      'Доплата рупиями',     'Top-up in rupees',      'रुपये में बाकी भुगतान', 'shop'),
    ('shop_extra_inr_add',  'Доплатить рупиями',   'Pay the rest in rupees', 'बाकी रुपये में दें',   'shop')
on conflict (key) do nothing;
