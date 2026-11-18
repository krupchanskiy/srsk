-- 801. Сдача выручки магазина без шага «Собрать пакет»: закрыл смену — значит сдал.
-- Пакет собирает казначей в момент приёма, поэтому собирать может и администратор финансов.
do $$
declare
    тело text := pg_get_functiondef('public.shop_prepare_handover(text)'::regprocedure);
    я text := E'if not abk_current_user_has_permission(''shop_settle'') then';
    в text := E'if not (abk_current_user_has_permission(''shop_settle'') or fin_is_admin()) then';
begin
    if position(я in тело) = 0 then raise exception 'shop_prepare_handover изменилась'; end if;
    execute replace(тело, я, в);
end $$;

-- новые ключи, а не правка старых: в кэше переводов старые тексты живут сутки
INSERT INTO translations (key, ru, en, hi) VALUES
  ('shop_handover_waiting', 'Закрытые смены ждут казначея', 'Closed shifts are waiting for the treasurer', 'बंद शिफ्ट कोषाध्यक्ष की प्रतीक्षा में'),
  ('shop_handover_accepting', 'Казначей принимает выручку', 'The treasurer is accepting the revenue', 'कोषाध्यक्ष राजस्व स्वीकार कर रहे हैं'),
  ('shop_take_revenue', 'Принять выручку', 'Accept revenue', 'राजस्व स्वीकार करें'),
  ('shop_take_revenue_msg', 'Проверьте суммы и выберите кассу', 'Check the amounts and choose the cash desk', 'राशि जाँचें और कैश डेस्क चुनें'),
  ('shop_handover_seller_note', 'Отдайте деньги казначею — он примет их здесь же. Пока не принял, пересчёт можно поправить.', 'Hand the money to the treasurer — they accept it right here. Until then you can still correct the count.', 'पैसे कोषाध्यक्ष को दें — वे यहीं स्वीकार करेंगे। तब तक गिनती सुधारी जा सकती है।')
ON CONFLICT (key) DO UPDATE SET ru = EXCLUDED.ru, en = EXCLUDED.en, hi = EXCLUDED.hi;

-- Продавец может открыть последнюю закрытую смену снова, пока казначей не принял выручку:
-- поправить чеки, возвраты, пересчёт и закрыть заново. После приёма — нельзя.
create or replace function public.shop_reopen_shift(p_shift uuid)
returns void
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
    v_смена shop_shifts%rowtype;
    v_пакет shop_handovers%rowtype;
begin
    if not abk_current_user_has_permission('shop_sell') then
        raise exception 'Нет права открывать смену' using errcode = '42501';
    end if;
    perform pg_advisory_xact_lock(hashtext('shop_open_shift'));
    perform pg_advisory_xact_lock(hashtext('shop_accept_handover'));
    perform pg_advisory_xact_lock(hashtext('shop_prepare_handover'));

    select * into v_смена from shop_shifts where id = p_shift for update;
    if not found or v_смена.status <> 'closed' then
        raise exception 'Смена не найдена или уже открыта';
    end if;
    if exists (select 1 from shop_shifts where status = 'open') then
        raise exception 'Сейчас открыта другая смена — сначала закройте её';
    end if;
    if exists (select 1 from shop_shifts where opened_at > v_смена.opened_at) then
        raise exception 'Открыть снова можно только последнюю смену';
    end if;

    if v_смена.handover_id is not null then
        select * into v_пакет from shop_handovers where id = v_смена.handover_id for update;
        if v_пакет.status = 'accepted' then
            raise exception 'Казначей уже принял выручку этой смены — открыть её нельзя';
        end if;
        -- казначей начал приём, но не провёл: пакет снимается, смены снова ждут
        update shop_handovers
           set status = 'returned', returned_at = now(), returned_by = auth.uid(),
               return_reason = 'Продавец открыл смену снова'
         where id = v_пакет.id;
        update shop_shifts set handover_id = null where handover_id = v_пакет.id;
    end if;

    update shop_shifts set status = 'open', closed_at = null, closed_by = null where id = p_shift;
end $function$;

grant execute on function public.shop_reopen_shift(uuid) to authenticated;

INSERT INTO translations (key, ru, en, hi) VALUES
  ('shop_reopen_shift', 'Открыть смену снова', 'Reopen shift', 'शिफ्ट फिर से खोलें'),
  ('shop_reopen_confirm', 'Открыть смену снова? Можно будет поправить чеки и пересчёт, потом закрыть заново.', 'Reopen the shift? You can fix receipts and the count, then close it again.', 'शिफ्ट फिर से खोलें? रसीदें और गिनती सुधारकर फिर बंद करें।'),
  ('shop_reopened_msg', 'Смена снова открыта', 'Shift reopened', 'शिफ्ट फिर से खुली')
ON CONFLICT (key) DO UPDATE SET ru = EXCLUDED.ru, en = EXCLUDED.en, hi = EXCLUDED.hi;
