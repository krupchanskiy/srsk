-- Магазин: гонки, прямая запись владельцев, контрагенты финмодуля, подарки
-- (аудит 19.10.2026, решение Адриана «правь ошибки»).

-- С1. Карточка владельца открывалась на прямую запись с правом приёмки:
--     update shop_owners set contractor_id = <другой контрагент> — и долг
--     вместе с будущей выплатой уходил другому человеку финмодуля.
--     Вся запись — только через shop_upsert_owner (там проверка shop_manage).
drop policy if exists "shop write" on public.shop_owners;
drop policy if exists "shop edit" on public.shop_owners;
drop policy if exists "shop delete" on public.shop_owners;
revoke insert, update, delete on table public.shop_owners from authenticated;

-- С2. shop_upsert_owner переименовывал контрагентов финмодуля и цеплял
--     к владельцу любого контрагента с тем же именем (сотрудника,
--     поставщика). Теперь магазин трогает только «своих» контрагентов —
--     заведённых им самим; чужих — только администратор финансов.
do $$
declare
    тело text := pg_get_functiondef('public.shop_upsert_owner(jsonb)'::regprocedure);
    а1 text := E'        update fin_contractors\n           set name = v_имя,';
    б1 text := E'        if not fin_is_admin()\n'
            || E'           and (select note from fin_contractors where id = v_contr) is distinct from ''Владелец товара в магазине''\n'
            || E'           and (select name from fin_contractors where id = v_contr) is distinct from v_имя then\n'
            || E'            raise exception ''Этот владелец — общий контрагент финмодуля: имя меняет администратор финансов''\n'
            || E'                using errcode = ''42501'';\n'
            || E'        end if;\n\n'
            || E'        update fin_contractors\n           set name = v_имя,';
    а2 text := E'     where lower(name) = lower(v_имя) and is_active limit 1;';
    б2 text := E'     where lower(name) = lower(v_имя) and is_active\n'
            || E'       and (fin_is_admin() or note = ''Владелец товара в магазине'') limit 1;';
begin
    if position(а1 in тело) = 0 or position(а2 in тело) = 0 then
        raise exception 'shop_upsert_owner изменилась';
    end if;
    execute replace(replace(тело, а1, б1), а2, б2);
end $$;

-- С3. Гонки.
-- а) Два расчёта с владельцем одновременно (две вкладки) оба видели
--    долг D и оба платили D. Владелец блокируется до чтения долга.
do $$
declare
    тело text := pg_get_functiondef('public.shop_settle_owner(jsonb)'::regprocedure);
    а text := E'    select o.contractor_id, c.name, round(coalesce(d.debt, 0), 2)';
begin
    if position(а in тело) = 0 then raise exception 'shop_settle_owner изменилась'; end if;
    execute replace(тело, а,
        E'    -- один расчёт за раз: иначе две вкладки обе платят весь долг\n'
        || E'    perform 1 from shop_owners where id = v_owner for update;\n\n' || а);
end $$;

-- б) Чек из офлайн-очереди мог закоммититься в смену, которую в эту
--    секунду закрывали: пакет учитывал его, пересчёт — нет. Продажа
--    берёт смену «на чтение», закрытие — «на запись»: они ждут друг друга.
--    Заодно повтор чека, пока первый ещё не закоммичен, давал сырую
--    ошибку unique_violation — касса считала её отказом, и продавец
--    пробивал чек заново. Теперь повтор возвращает уже проведённый чек.
do $$
declare
    тело text := pg_get_functiondef('public.shop_post_sale(jsonb)'::regprocedure);
    а text := E'    if not exists (select 1 from shop_shifts where id = v_shift_id and status = ''open'') then';
    н int; к int; вставка text;
begin
    if position(а in тело) = 0 then raise exception 'shop_post_sale изменилась (смена)'; end if;
    тело := replace(тело, а, E'    perform 1 from shop_shifts where id = v_shift_id for share;\n' || а);

    н := position(E'    insert into shop_sales (' in тело);
    к := position(E'returning id into v_sale_id;' in тело);
    if н = 0 or к = 0 or к < н then raise exception 'shop_post_sale изменилась (вставка)'; end if;
    к := к + length('returning id into v_sale_id;');
    вставка := E'    begin\n' || substr(тело, н, к - н) || E'\n'
        || E'    exception when unique_violation then\n'
        || E'        -- тот же чек уже провела параллельная попытка — это не отказ\n'
        || E'        select id into v_sale_id from shop_sales where client_uid = v_client_uid;\n'
        || E'        if v_sale_id is null then raise; end if;\n'
        || E'        return v_sale_id;\n'
        || E'    end;';
    тело := substr(тело, 1, н - 1) || вставка || substr(тело, к);
    execute тело;
end $$;

do $$
declare
    тело text := pg_get_functiondef('public.shop_close_shift(jsonb)'::regprocedure);
    а text := E'    if not exists (select 1 from shop_shifts where id = v_shift and status = ''open'') then';
begin
    if position(а in тело) = 0 then raise exception 'shop_close_shift изменилась'; end if;
    execute replace(тело, а, E'    perform 1 from shop_shifts where id = v_shift for update;\n' || а);
end $$;

-- в) Страховочные индексы на правила, которые держались только кодом:
--    одна партия недостачи на товар (две параллельные продажи «в минус»
--    заводили две, и вторая оставалась в минусе навсегда) и один
--    черновик инвентаризации (двойной щелчок давал два).
create unique index if not exists shop_batches_one_shortfall
    on public.shop_batches (item_id) where origin = 'shortfall';
create unique index if not exists shop_inventories_one_draft
    on public.shop_inventories ((true)) where status = 'draft';

-- С4. Подарок или служебное использование чужого товара при политике
--     «за счёт владельца» записывались как его потеря: магазин раздал
--     чужую книгу, а долг владельцу не вырос. Политика «за счёт владельца»
--     — про порчу и пропажу, а не про то, чем распорядились мы сами.
do $$
declare
    тело text := pg_get_functiondef('public.shop_writeoff(jsonb)'::regprocedure);
    а text := $q$v_чей := coalesce(v_за_чей, case when v_политика = 'compensate' then 'us' else 'owner' end);$q$;
begin
    if position(а in тело) = 0 then raise exception 'shop_writeoff изменилась'; end if;
    execute replace(тело, а,
        $q$v_чей := case when v_reason in ('gift', 'service') then 'us'
                             else coalesce(v_за_чей, case when v_политика = 'compensate' then 'us' else 'owner' end) end;$q$);
end $$;
