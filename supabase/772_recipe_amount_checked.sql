-- 772: «Проверено, так и должно быть» у строки рецепта + пересчёт прошедших дней по исправленному рецепту
--
-- 1) Ингредиент тяжелее выхода блюда — подсказка, пока повар не подтвердит строку.
--    Подтверждение действует, пока количество и единица те же: поменяли — снова на проверку.
-- 2) При правке рецепта прошедшие дни меню получают снимок СТАРОГО состава (мигр. 562):
--    намеренная смена рецепта прошлое не меняет. Но исправление ошибки (масло 1200 кг вместо 1,2)
--    тогда навсегда остаётся в прошлом — kitchen_resnapshot_recipe переписывает снимки
--    прошедших дней этого рецепта по текущему составу; вызывается только по ответу «да» при сохранении.

alter table recipe_ingredients
    add column if not exists checked_amount numeric,
    add column if not exists checked_unit text;

comment on column recipe_ingredients.checked_amount is
    'Количество, подтверждённое поваром как верное при подсказке «больше выхода блюда»; действует, пока amount и unit не изменились';
comment on column recipe_ingredients.checked_unit is 'Единица к checked_amount';

-- состав как множество: порядок строк и запись числа (1200 / 1200.000) не важны
create or replace function kitchen_private_ingredients_key(p jsonb)
returns jsonb
language sql
immutable
as $$
    select coalesce(jsonb_agg(jsonb_build_object('product_id', x->>'product_id', 'amount', (x->>'amount')::numeric, 'unit', x->>'unit')
                              order by x->>'product_id', (x->>'amount')::numeric, x->>'unit'), '[]'::jsonb)
      from jsonb_array_elements(coalesce(p, '[]'::jsonb)) x
$$;

create or replace function kitchen_resnapshot_recipe(p_recipe uuid, p_old jsonb, p_apply boolean default false)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
-- p_old — состав рецепта ДО сохранения [{product_id, amount, unit}]: переписываются только снимки
-- с этим составом (ошибка, застывшая при сохранении), более старые версии рецепта не трогаются.
-- p_apply = false — только узнать даты (для вопроса), true — переписать.
declare
    v_dishes uuid[];
    v_dates jsonb;
    v_n integer := 0;
begin
    if not abk_current_user_has_permission('edit_recipe') then
        raise exception 'Нет права править рецепты';
    end if;
    if not exists (select 1 from recipes r where r.id = p_recipe and abk_current_user_can_access_location(r.location_id)) then
        raise exception 'Рецепт не найден';
    end if;

    select array_agg(s.menu_dish_id), coalesce(jsonb_agg(distinct mm.date), '[]'::jsonb)
      into v_dishes, v_dates
      from menu_dish_recipe_snapshots s
      join menu_dishes md on md.id = s.menu_dish_id
      join menu_meals mm on mm.id = md.meal_id
     where s.recipe_id = p_recipe
       and kitchen_private_ingredients_key(s.ingredients) = kitchen_private_ingredients_key(p_old);

    if p_apply and v_dishes is not null then
        update menu_dish_recipe_snapshots s
           set output_amount = r.output_amount,
               output_unit = r.output_unit,
               portion_amount = r.portion_amount,
               ingredients = coalesce((select jsonb_agg(jsonb_build_object('product_id', ri.product_id, 'amount', ri.amount, 'unit', ri.unit)
                                                        order by ri.sort_order, ri.id)
                                         from recipe_ingredients ri where ri.recipe_id = r.id), '[]'::jsonb)
          from recipes r
         where r.id = p_recipe
           and s.menu_dish_id = any(v_dishes);
        get diagnostics v_n = row_count;
    end if;
    return jsonb_build_object('dates', v_dates, 'updated', v_n);
end;
$$;

revoke all on function kitchen_private_ingredients_key(jsonb) from public, anon;
revoke all on function kitchen_resnapshot_recipe(uuid, jsonb, boolean) from public, anon;
grant execute on function kitchen_resnapshot_recipe(uuid, jsonb, boolean) to authenticated;

insert into translations (key, ru, en, hi, context) values
('recipe_amount_checked', 'Проверено — так и должно быть', 'Checked — this is correct', 'जाँचा गया — यह सही है', 'Кухня: рецепт'),
('recipe_amount_confirm_text2', E'Ингредиента указано больше, чем выходит готового блюда ({out}):\n{list}\n\nВы уверены, что данные верны? «Да» — сохранить и отметить как проверенные, «Отмена» — вернуться и исправить.', E'An ingredient is heavier than the dish output ({out}):\n{list}\n\nAre you sure the data is correct? "Yes" saves and marks them as checked, "Cancel" returns to fix it.', E'सामग्री तैयार व्यंजन ({out}) से अधिक है:\n{list}\n\nक्या आप निश्चित हैं कि डेटा सही है? «हाँ» — सहेजें और जाँचा हुआ चिह्नित करें, «रद्द करें» — वापस जाकर ठीक करें।', 'Кухня: рецепт'),
('recipe_raw_total', 'Продуктов всего {raw} → выход {out}', 'Ingredients total {raw} → output {out}', 'कुल सामग्री {raw} → आउटपुट {out}', 'Кухня: рецепт'),
('recipe_raw_total_hint', 'Сумма ингредиентов в весе, которые можно перевести в килограммы (штуки без веса одной штуки не входят). Обычно близко к выходу: больше — уварка и чистка, меньше — добавляется вода.', 'Total weight of ingredients convertible to kilograms (pieces without a piece weight are excluded). Usually close to the output: more means boiling down and trimming, less means water is added.', 'किलोग्राम में बदली जा सकने वाली सामग्री का कुल वज़न (एक नग के वज़न के बिना नग शामिल नहीं)। आमतौर पर आउटपुट के क़रीब।', 'Кухня: рецепт'),
('recipe_resnapshot_title', 'Пересчитать и прошедшие дни?', 'Recalculate past days too?', 'पिछले दिनों की भी पुनर्गणना करें?', 'Кухня: рецепт'),
('recipe_resnapshot_text', E'Это блюдо уже было в меню: {dates}.\nДля них сохранён прежний состав рецепта.\n\n«Да» — если вы исправили ошибку: прошедшие дни пересчитаются по исправленному рецепту.\n«Отмена» — если рецепт поменялся намеренно: прошлое останется как было.', E'This dish was already on the menu: {dates}.\nThe previous recipe is kept for those days.\n\n"Yes" if you fixed an error: past days will be recalculated with the corrected recipe.\n"Cancel" if the recipe changed on purpose: the past stays as it was.', E'यह व्यंजन पहले मेनू में था: {dates}।\nउन दिनों के लिए पुराना नुस्खा सहेजा गया है।\n\n«हाँ» — यदि आपने त्रुटि ठीक की: पिछले दिन सुधारे गए नुस्खे से गिने जाएँगे।\n«रद्द करें» — यदि नुस्खा जानबूझकर बदला: पिछला वैसा ही रहेगा।', 'Кухня: рецепт')
on conflict (key) do nothing;
