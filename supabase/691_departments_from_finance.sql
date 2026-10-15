-- 691: один список департаментов — финансовый (fin_departments). ВГ, 25.09 / 10.10.2026.
-- Было два списка: departments (у людей, шахматка, себестоимость) и fin_departments (финансы).
-- Теперь департаменты заводятся и переименовываются только в Финансах → Справочники,
-- люди, проживания и история «с — по» ссылаются на fin_departments, и новое название
-- подхватывается везде само (по id). Где нужен конкретный департамент (роли поваров,
-- склад, меню) — по постоянному code, а не по названию: переименование их не ломает.
--
-- Сопоставление (решение ВГ 10.10):
--   Кухня, Кафе, Стройка, Мастерская → то же; Зеленый → Зелёные; Божества → Поклонение;
--   Красота → Мастерская (Мани Манджари); Хозяйство → Гест-хаус; Офис → без департамента
--   (Ачинтья Кришна дас: «офис» — его позиция, не департамент).
--   Акшара дас — Завод за всё время. Амала-Камала деви даси — история сохраняется
--   (Божества → Поклонение, август — Мастерская), с 10.10.2026 — Мастерская.
-- Личные (Ашиш, Ачинтья Кришна, Олег Карпов (личный)) у людей не показываются:
-- галочка «показывать у людей» снята, включить можно в справочнике.
-- Старая таблица departments не удаляется (ни на что не ссылается) — убрать позже.

-- ── 1. Новые поля финансового справочника ──
ALTER TABLE fin_departments
    ADD COLUMN IF NOT EXISTS color text,
    ADD COLUMN IF NOT EXISTS code text UNIQUE,
    ADD COLUMN IF NOT EXISTS for_people boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN fin_departments.color IS 'Цвет плашки у людей (список команды, карточка)';
COMMENT ON COLUMN fin_departments.code IS 'Постоянный код для логики (kitchen, cafe, guesthouse) — название можно менять свободно';
COMMENT ON COLUMN fin_departments.for_people IS 'Показывать в выборе департамента у людей; личные счета — нет';

UPDATE fin_departments f SET color = d.color
  FROM departments d
 WHERE f.color IS NULL
   AND f.name = CASE d.name_ru WHEN 'Зеленый' THEN 'Зелёные' WHEN 'Божества' THEN 'Поклонение'
                               WHEN 'Хозяйство' THEN 'Гест-хаус' ELSE d.name_ru END;
UPDATE fin_departments SET code = 'kitchen' WHERE name = 'Кухня';
UPDATE fin_departments SET code = 'cafe'    WHERE name = 'Кафе';
UPDATE fin_departments SET code = 'guesthouse' WHERE name = 'Гест-хаус';
UPDATE fin_departments SET for_people = false
 WHERE name IN ('Ашиш', 'Ачинтья Кришна', 'Олег Карпов (личный)');

-- Названия и цвета нужны всем (карточка, шахматка, склад); остатки и чаты —
-- по-прежнему только в fin_v_departments для финансов.
DROP POLICY IF EXISTS "Departments read all" ON fin_departments;
CREATE POLICY "Departments read all" ON fin_departments FOR SELECT TO authenticated USING (true);

-- ── 2. Перевод людей, проживаний и истории ──
CREATE TEMP TABLE _dept_map ON COMMIT DROP AS
SELECT d.id AS old_id, f.id AS new_id, d.name_ru AS old_name
  FROM departments d
  LEFT JOIN fin_departments f ON f.name = CASE d.name_ru
        WHEN 'Зеленый' THEN 'Зелёные' WHEN 'Божества' THEN 'Поклонение'
        WHEN 'Красота' THEN 'Мастерская' WHEN 'Хозяйство' THEN 'Гест-хаус'
        WHEN 'Офис' THEN NULL ELSE d.name_ru END;

DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM _dept_map WHERE new_id IS NULL AND old_name <> 'Офис') THEN
        RAISE EXCEPTION 'Не сопоставлен департамент: %',
            (SELECT string_agg(old_name, ', ') FROM _dept_map WHERE new_id IS NULL AND old_name <> 'Офис');
    END IF;
END $$;

ALTER TABLE vaishnavas DROP CONSTRAINT vaishnavas_department_id_fkey;
ALTER TABLE residents DROP CONSTRAINT residents_department_id_fkey;
ALTER TABLE vaishnava_departments DROP CONSTRAINT vaishnava_departments_department_id_fkey;

-- Перенос один к одному: триггеры истории и ролей поваров на время выключаем,
-- иначе они дописали бы «переход с сегодня» тем, у кого история не совпадает с карточкой.
ALTER TABLE vaishnavas DISABLE TRIGGER trg_vaishnava_department_history;
ALTER TABLE vaishnavas DISABLE TRIGGER trg_vaishnava_kitchen_roles;
ALTER TABLE residents DISABLE TRIGGER trg_resident_department_history;

DELETE FROM vaishnava_departments h USING _dept_map m WHERE h.department_id = m.old_id AND m.new_id IS NULL;
UPDATE vaishnava_departments h SET department_id = m.new_id FROM _dept_map m WHERE h.department_id = m.old_id;
UPDATE residents r SET department_id = m.new_id FROM _dept_map m WHERE r.department_id = m.old_id;
UPDATE vaishnavas v SET department_id = m.new_id FROM _dept_map m WHERE v.department_id = m.old_id;

-- Акшара дас — Завод за всё время
UPDATE vaishnava_departments SET department_id = (SELECT id FROM fin_departments WHERE name = 'Завод')
 WHERE vaishnava_id = '39783034-a06f-49ef-ad37-729c6e24cc52';
UPDATE residents SET department_id = (SELECT id FROM fin_departments WHERE name = 'Завод')
 WHERE vaishnava_id = '39783034-a06f-49ef-ad37-729c6e24cc52' AND department_id IS NOT NULL;
UPDATE vaishnavas SET department_id = (SELECT id FROM fin_departments WHERE name = 'Завод')
 WHERE id = '39783034-a06f-49ef-ad37-729c6e24cc52';

ALTER TABLE vaishnavas ENABLE TRIGGER trg_vaishnava_department_history;
ALTER TABLE vaishnavas ENABLE TRIGGER trg_vaishnava_kitchen_roles;
ALTER TABLE residents ENABLE TRIGGER trg_resident_department_history;

ALTER TABLE vaishnavas ADD CONSTRAINT vaishnavas_department_id_fkey
    FOREIGN KEY (department_id) REFERENCES fin_departments(id);
ALTER TABLE residents ADD CONSTRAINT residents_department_id_fkey
    FOREIGN KEY (department_id) REFERENCES fin_departments(id);
ALTER TABLE vaishnava_departments ADD CONSTRAINT vaishnava_departments_department_id_fkey
    FOREIGN KEY (department_id) REFERENCES fin_departments(id);

COMMENT ON TABLE departments IS 'УСТАРЕЛО (691): департаменты — fin_departments. Ни на что не ссылается, удалить позже';

-- ── 3. Роли поваров — по коду, а не по названию ──
CREATE OR REPLACE FUNCTION public.kitchen_cook_sync_roles(p_vaishnava uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
    v_user  uuid;
    v_level text;
    v_want  text;
    v_role  record;
begin
    select user_id into v_user from vaishnavas where id = p_vaishnava;
    if v_user is null then return; end if;
    if (select count(*) from vaishnavas where user_id = v_user and not coalesce(is_deleted, false)) > 1 then
        return;
    end if;

    select c.level into v_level
      from kitchen_cooks c
      join vaishnavas v on v.id = c.vaishnava_id
      join fin_departments d on d.id = v.department_id
     where c.vaishnava_id = p_vaishnava and c.is_active
       and d.code = 'kitchen'
       and v.is_active and not coalesce(v.is_deleted, false)
     order by case c.level when 'chef' then 0 when 'sous_chef' then 1 else 2 end
     limit 1;

    v_want := case v_level when 'cook' then 'kitchen_cook' when 'sous_chef' then 'sous_chef' end;

    for v_role in select id, code from roles where code in ('kitchen_cook', 'sous_chef') loop
        if v_role.code = v_want then
            insert into user_roles (user_id, role_id, is_active) values (v_user, v_role.id, true)
            on conflict (user_id, role_id) do update set is_active = true, assigned_at = now()
             where not user_roles.is_active;
        else
            update user_roles set is_active = false
             where user_id = v_user and role_id = v_role.id and is_active;
        end if;
    end loop;
end $function$;

-- ── 4. Амала-Камала деви даси — с 10.10.2026 Мастерская (история до этого сохраняется) ──
SELECT vaishnava_department_apply('c73db40f-36a5-4e57-85b5-71582f072af2',
                                  (SELECT id FROM fin_departments WHERE name = 'Мастерская'), DATE '2026-10-10');
UPDATE vaishnavas SET department_id = (SELECT id FROM fin_departments WHERE name = 'Мастерская')
 WHERE id = 'c73db40f-36a5-4e57-85b5-71582f072af2';

-- ── 5. Справочник: цвет и «показывать у людей» ──
CREATE OR REPLACE VIEW fin_v_departments AS
 SELECT d.id,
    d.name,
    d.responsible_person_id,
    fin_private_person_name(d.responsible_person_id) AS responsible_name,
    l.chat_id,
    k.title AS chat_title,
    ( SELECT jsonb_agg(jsonb_build_object('currency', a.currency_code, 'amount', ( SELECT COALESCE(sum(
                        CASE p.direction
                            WHEN 'in'::fin_direction THEN p.amount
                            ELSE (- p.amount)
                        END), (0)::numeric) AS "coalesce"
                   FROM fin_postings p
                  WHERE (p.account_id = a.id))) ORDER BY a.currency_code) AS jsonb_agg
           FROM fin_accounts a
          WHERE ((a.department_id = d.id) AND (a.kind = 'custodial'::fin_account_kind) AND a.is_active)) AS balances,
    ((d.responsible_person_id IS NOT NULL) AND ((EXISTS ( SELECT 1
           FROM tg_user_links tl
          WHERE (tl.vaishnava_id = d.responsible_person_id))) OR (EXISTS ( SELECT 1
           FROM vaishnavas v
          WHERE ((v.id = d.responsible_person_id) AND (NULLIF(tg_norm_username(v.telegram), ''::text) IS NOT NULL)))))) AS bot_knows_responsible,
    d.color,
    d.for_people,
    d.code,
    (SELECT count(*) FROM vaishnavas v WHERE v.department_id = d.id AND NOT coalesce(v.is_deleted, false))::int AS people_count
   FROM ((fin_departments d
     LEFT JOIN tg_chat_links l ON (((l.department_id = d.id) AND l.is_active)))
     LEFT JOIN tg_known_chats k ON ((k.chat_id = l.chat_id)))
  WHERE fin_can_read_all();

CREATE OR REPLACE FUNCTION public.fin_save_department(payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_id uuid;
  v_name text;
  v_resp uuid;
  v_resp_given boolean;
  v_chat bigint;
  v_chat_given boolean;
  v_cats_given boolean;
  v_bad int;
  v_old_name text;
  v_detail text;
  v_color text;
BEGIN
  IF NOT fin_is_admin() THEN
    RAISE EXCEPTION 'forbidden' USING DETAIL = 'Только администратор финансов';
  END IF;
  PERFORM fin_private_assert_keys(payload,
    ARRAY['id', 'name', 'responsible_person_id', 'chat_id', 'category_ids', 'color', 'for_people']);

  v_name := NULLIF(btrim(COALESCE(payload->>'name', '')), '');
  IF v_name IS NULL THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Название департамента обязательно';
  END IF;

  v_color := NULLIF(btrim(COALESCE(payload->>'color', '')), '');
  IF v_color IS NOT NULL AND v_color !~ '^#[0-9a-fA-F]{6}$' THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Цвет — в виде #RRGGBB';
  END IF;

  v_id   := fin_private_get_uuid(payload, 'id');
  v_resp_given := payload ? 'responsible_person_id';
  v_resp := fin_private_get_uuid(payload, 'responsible_person_id');
  v_chat_given := payload ? 'chat_id';
  v_chat := NULLIF(payload->>'chat_id', '')::bigint;
  v_cats_given := payload ? 'category_ids';

  IF v_resp IS NOT NULL AND NOT EXISTS (SELECT 1 FROM vaishnavas WHERE id = v_resp) THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Ответственный не найден в справочнике людей';
  END IF;

  IF EXISTS (SELECT 1 FROM fin_departments
              WHERE lower(name) = lower(v_name) AND (v_id IS NULL OR id <> v_id)) THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = format('Департамент «%s» уже есть', v_name);
  END IF;

  IF v_chat IS NOT NULL AND NOT EXISTS (SELECT 1 FROM tg_known_chats WHERE chat_id = v_chat) THEN
    RAISE EXCEPTION 'invalid_payload'
      USING DETAIL = 'Такого чата бот ещё не видел — добавьте бота в чат, он появится в списке';
  END IF;

  -- В наборе департамента могут быть только действующие расходные статьи:
  -- иначе бот предложил бы приходную статью или архивную.
  IF v_cats_given AND jsonb_typeof(payload->'category_ids') = 'array' THEN
    SELECT count(*) INTO v_bad
      FROM jsonb_array_elements_text(payload->'category_ids') x
     WHERE NOT EXISTS (SELECT 1 FROM fin_categories c
                        WHERE c.id = NULLIF(x, '')::uuid
                          AND c.is_active AND c.direction = 'out');
    IF v_bad > 0 THEN
      RAISE EXCEPTION 'invalid_payload'
        USING DETAIL = 'В наборе есть статья, которая не является действующей статьёй расхода';
    END IF;
  END IF;

  IF v_id IS NULL THEN
    INSERT INTO fin_departments (name, responsible_person_id, color, for_people)
    VALUES (v_name, v_resp, v_color, COALESCE((payload->>'for_people')::boolean, true))
    RETURNING id INTO v_id;
  ELSE
    SELECT name INTO v_old_name FROM fin_departments WHERE id = v_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Департамент не найден';
    END IF;

    UPDATE fin_departments
       SET name = v_name,
           responsible_person_id = CASE WHEN v_resp_given THEN v_resp ELSE responsible_person_id END,
           color = CASE WHEN payload ? 'color' THEN v_color ELSE color END,
           for_people = CASE WHEN payload ? 'for_people' THEN (payload->>'for_people')::boolean ELSE for_people END
     WHERE id = v_id;

    IF v_old_name IS DISTINCT FROM v_name THEN
      UPDATE fin_accounts
         SET name = v_name || ' (' || CASE currency_code
                       WHEN 'INR' THEN '₹' WHEN 'RUB' THEN '₽'
                       WHEN 'USD' THEN '$' WHEN 'EUR' THEN '€'
                       ELSE currency_code END || ')'
       WHERE department_id = v_id AND kind = 'custodial'
         AND name = v_old_name || ' (' || CASE currency_code
                       WHEN 'INR' THEN '₹' WHEN 'RUB' THEN '₽'
                       WHEN 'USD' THEN '$' WHEN 'EUR' THEN '€'
                       ELSE currency_code END || ')';
      UPDATE tg_chat_links SET department_name = v_name WHERE department_id = v_id;
    END IF;
  END IF;

  IF v_chat_given THEN
    IF v_chat IS NOT NULL THEN
      UPDATE tg_chat_links SET is_active = false
       WHERE is_active AND (chat_id = v_chat OR department_id = v_id);
      INSERT INTO tg_chat_links (chat_id, department_id, department_name, is_active)
      VALUES (v_chat, v_id, v_name, true)
      ON CONFLICT (chat_id) DO UPDATE
        SET department_id = EXCLUDED.department_id,
            department_name = EXCLUDED.department_name,
            is_active = true;
    ELSE
      UPDATE tg_chat_links SET is_active = false WHERE department_id = v_id AND is_active;
    END IF;
  END IF;

  IF v_cats_given THEN
    DELETE FROM fin_department_categories WHERE department_id = v_id;
    INSERT INTO fin_department_categories (department_id, category_id)
    SELECT v_id, NULLIF(x, '')::uuid
      FROM jsonb_array_elements_text(COALESCE(payload->'category_ids', '[]'::jsonb)) x
     WHERE NULLIF(x, '') IS NOT NULL
    ON CONFLICT DO NOTHING;
  END IF;

  RETURN jsonb_build_object('ok', true, 'result', jsonb_build_object('id', v_id));
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

-- ── 6. Подписи справочника ──
insert into translations (key, ru, en, hi, page)
select v.key, v.ru, v.en, v.hi, 'fin_dictionaries'
  from (values
    ('fin_dept_color', 'Цвет у людей', 'Colour for people', 'लोगों के लिए रंग'),
    ('fin_dept_for_people', 'Показывать у людей', 'Show for people', 'लोगों के लिए दिखाएँ'),
    ('fin_dept_for_people_hint', 'В карточке человека, шахматке и Себестоимости. Снимите для личных счетов.', 'In the person card, timeline and cost page. Untick for personal accounts.', 'व्यक्ति कार्ड, टाइमलाइन और लागत पृष्ठ में। निजी खातों के लिए हटाएँ।'),
    ('fin_dept_people', 'Людей', 'People', 'लोग'),
    ('fin_dept_personal', 'не у людей', 'not for people', 'लोगों के लिए नहीं')
  ) v(key, ru, en, hi)
 where not exists (select 1 from translations t where t.key = v.key);
