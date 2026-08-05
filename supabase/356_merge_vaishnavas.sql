-- Склейка дублей карточек: инструмент + пять подтверждённых случаев.
--
-- Нитья-виласини подтвердила (05.08.2026), что это один человек:
--   Мадхурья-бхакти дд (Наталья Шпак) — 2 карточки
--   Николай Зайцев — 3 карточки
--   Гитамрита дд (Гузель Адельянова) — 2 карточки
--   Амита Рай дд = Амина-Анна Куанышбай, верный телефон +77074005940
--   Арадхита дд = Ольга Рахимжанова, верный телефон +77772773895
--
-- Заодно разрешилась аномалия: номер +77772773895 стоял и у Амины-Анны —
-- чужой, попал при заведении второй карточки. Гасим её, и остаётся верный.
--
-- Человек связан с системой 42 внешними ключами, поэтому перенос делает
-- функция, обходящая FK по каталогу, а не ручной список: список руками
-- обязательно окажется неполным после следующей миграции.

create or replace function merge_vaishnavas(p_main uuid, p_dup uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
DECLARE
  r record;
  v_moved jsonb := '{}'::jsonb;
  v_cnt bigint;
  v_conflict text;
BEGIN
  IF p_main = p_dup THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Карточка не может поглотить сама себя');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM vaishnavas WHERE id = p_main) OR
     NOT EXISTS (SELECT 1 FROM vaishnavas WHERE id = p_dup) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Карточка не найдена');
  END IF;

  -- Одна регистрация на ретрит: если обе карточки записаны на один и тот же
  -- ретрит, переносить нельзя — сначала надо решить, какая запись верная.
  SELECT string_agg(ret.name_ru, ', ') INTO v_conflict
    FROM retreat_registrations a
    JOIN retreat_registrations b ON b.retreat_id = a.retreat_id AND b.vaishnava_id = p_main
    JOIN retreats ret ON ret.id = a.retreat_id
   WHERE a.vaishnava_id = p_dup;
  IF v_conflict IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'error',
      format('Обе карточки зарегистрированы на: %s — разберите вручную', v_conflict));
  END IF;

  -- Обход всех внешних ключей на vaishnavas.id по системному каталогу
  FOR r IN
    SELECT tc.table_name AS tbl, kcu.column_name AS col
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name
      JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name
     WHERE tc.constraint_type = 'FOREIGN KEY'
       AND ccu.table_name = 'vaishnavas' AND ccu.column_name = 'id'
       AND tc.table_schema = 'public'
     ORDER BY 1, 2
  LOOP
    EXECUTE format('UPDATE %I SET %I = $1 WHERE %I = $2', r.tbl, r.col, r.col)
      USING p_main, p_dup;
    GET DIAGNOSTICS v_cnt = ROW_COUNT;
    IF v_cnt > 0 THEN
      v_moved := v_moved || jsonb_build_object(r.tbl || '.' || r.col, v_cnt);
    END IF;
  END LOOP;

  -- Родство с самим собой после слияния бессмысленно
  DELETE FROM family_links WHERE vaishnava_id = relative_id;
  UPDATE vaishnavas SET parent_id = NULL WHERE id = p_main AND parent_id = p_main;
  UPDATE vaishnavas SET senior_id = NULL WHERE id = p_main AND senior_id = p_main;

  -- Дубль гасим и снимаем логин: вход перестаёт быть общим (сторож смотрит
  -- именно на user_id), история остаётся на месте
  UPDATE vaishnavas SET is_deleted = true, user_id = NULL WHERE id = p_dup;

  RETURN jsonb_build_object('ok', true, 'moved', v_moved);
END;
$$;

revoke all on function merge_vaishnavas(uuid, uuid) from public, anon;
grant execute on function merge_vaishnavas(uuid, uuid) to service_role;

comment on function merge_vaishnavas(uuid, uuid) is
  'Слить дубль карточки в основную: переносит все связи по каталогу FK, гасит дубль. Отказывает, если обе карточки записаны на один ретрит.';

-- ---------------------------------------------------------------------------
-- Применение: пять подтверждённых склеек
-- ---------------------------------------------------------------------------
-- Гитамрита дд НЕ склеена: у обеих карточек сделка на Сева-ретрит (одна
-- отменённая с пятью задачами и историей менеджера, одна живая), а БД держит
-- одну сделку на пару человек-ретрит. Удалять историю работы без спроса
-- нельзя — отдано Нитья-виласини. Её вход в сигнале не числится: денег на
-- карточках нет.
select merge_vaishnavas('120540ae-1353-4fee-b0f9-ff11e6f87ac0','bc09a388-9527-4f87-83ec-9de3b0f70f0b'); -- Амита Рай дд = Амина-Анна Куанышбай
select merge_vaishnavas('dd1aa4c0-0199-4ffd-a4a9-10ac8cc4c48b','69d24411-538e-4b22-ada6-793c19d1f5b7'); -- Николай Зайцев 2/3
select merge_vaishnavas('dd1aa4c0-0199-4ffd-a4a9-10ac8cc4c48b','50f1eefe-1a69-4009-bfa0-ab20089347fc'); -- Николай Зайцев 3/3
select merge_vaishnavas('1f88f5e8-61a9-48f8-8174-5227d197907c','2da44099-ca16-4075-9686-e15415855369'); -- Арадхита дд = Ольга Рахимжанова
select merge_vaishnavas('7b72de84-3bda-4377-8a25-910594c4bb49','2a6baffc-ea17-4067-b2f1-64a688657287'); -- Мадхурья-бхакти дд

-- ---------------------------------------------------------------------------
-- Семейные связи (состав подтвердила Нитья-виласини)
-- ---------------------------------------------------------------------------
insert into family_links (vaishnava_id, relative_id, relation, created_by) values
  ('e9d37d11-c9af-4c0e-bf5c-4b4bdf414b59','17aca7c0-4a10-46e5-b273-167874792dd2','spouse','2160b531-4e37-4d2a-ba46-cc1ee230cfeb'), -- Сварупананда — Оксана Николаева
  ('9d35ff88-f89b-4d47-b944-a408b99fd642','00d72da1-0a1b-448e-a5c1-eb25253fa236','spouse','2160b531-4e37-4d2a-ba46-cc1ee230cfeb'), -- Аруна Гауранга — Георгета
  ('e0da9d41-1e89-4501-a91b-cbce586fb658','18ea2170-45d2-4d9c-9927-734ed170e1ca','spouse','2160b531-4e37-4d2a-ba46-cc1ee230cfeb'), -- Адхиягья — Анастасия Еронина
  ('1d833a3d-5db6-476f-801a-b80369682435','2a36ea77-42a7-466c-91f8-97bda9ce2ac3','child','2160b531-4e37-4d2a-ba46-cc1ee230cfeb'),  -- Кришодари — Нитай
  ('1d833a3d-5db6-476f-801a-b80369682435','411d1a74-4c09-4b9e-9fe3-65da0581e476','child','2160b531-4e37-4d2a-ba46-cc1ee230cfeb'),  -- Кришодари — Лила
  ('1d833a3d-5db6-476f-801a-b80369682435','e3f949c9-abb8-429d-8c25-34e8c67ad4dd','child','2160b531-4e37-4d2a-ba46-cc1ee230cfeb'),  -- Кришодари — Вринда
  ('5850e34c-19f0-4d6d-81f3-fb5dff0ab2ad','041524a2-8a98-4aee-adf6-52dc8560868a','child','2160b531-4e37-4d2a-ba46-cc1ee230cfeb'),  -- Ольга Библис — Ангелина
  ('4140e048-105f-4d43-8dc6-eb8028d74f57','0c9f4256-48d2-4860-94e2-4866428bb3f9','child','2160b531-4e37-4d2a-ba46-cc1ee230cfeb')   -- Гаури прия — Лалита лила
on conflict (vaishnava_id, relative_id) do nothing;

-- ---------------------------------------------------------------------------
-- Портал и сторож учатся отличать семью от посторонних
-- ---------------------------------------------------------------------------
-- Обе функции пропатчены программно (pg_get_functiondef + replace); тела
-- большие, ручная копия рискованна. Что изменено:
--
-- portal_fin_get_my_finances (было в 274: любой вход с несколькими карточками
--   получал отказ):
--   * отказ теперь только если под входом есть человек, НЕ связанный роднёй
--     ни с кем из остальных;
--   * viewer выбирается по числу родственных связей внутри входа — мама
--     видит всех детей, ребёнок увидел бы только маму.
--
-- fin_run_integrity_checks, проверка shared_login_blocks_portal:
--   * то же условие «есть посторонний» добавлено в SQL проверки, иначе сторож
--     будил бы каждое утро из-за законных семей.
--
-- Актуальные тела: SELECT pg_get_functiondef('portal_fin_get_my_finances()'::regprocedure);
