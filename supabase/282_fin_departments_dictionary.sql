-- Департаменты не имели интерфейса вовсе: список жил в fin_departments, привязка
-- чата — в tg_chat_links, и то и другое правилось только через базу. Запрос ВГ
-- от 26.07.2026 — уметь заводить и переименовывать самому.
--
-- Подотчётный счёт департаменту заводится сам при первой выдаче (fin_dept_account),
-- поэтому здесь его создавать не нужно. А вот ПЕРЕИМЕНОВЫВАТЬ нужно: имя счёта
-- собрано из имени департамента («Кухня (₹)»), и без синхронизации в «Счетах»
-- навсегда осталось бы старое название.
--
-- Витрина чатов (fin_v_known_chats) уже существовала — переиспользуем её.
--
-- ВАЖНО про необязательные поля (дефект первых двух версий, пойман тестом):
-- отсутствие ключа в payload и явный null — разные вещи. Раньше правка
-- департамента без ключа chat_id молча отвязывала чат, а без ключа
-- responsible_person_id — обнуляла ответственного. Переименовал департамент —
-- заявки из его чата перестали приниматься, и никто бы не понял почему.
--   ключа нет           → поле не трогаем;
--   'ключ': null        → очищаем осознанно;
--   'ключ': <значение>  → ставим.

CREATE OR REPLACE VIEW public.fin_v_departments AS
SELECT d.id,
       d.name,
       d.responsible_person_id,
       fin_private_person_name(d.responsible_person_id) AS responsible_name,
       l.chat_id,
       k.title AS chat_title,
       (SELECT string_agg(fin_fmt_money(
                 (SELECT COALESCE(SUM(CASE p.direction WHEN 'in' THEN p.amount ELSE -p.amount END), 0)
                    FROM fin_postings p WHERE p.account_id = a.id),
                 a.currency_code), ' · ' ORDER BY a.currency_code)
          FROM fin_accounts a
         WHERE a.department_id = d.id AND a.kind = 'custodial' AND a.is_active) AS balances
FROM fin_departments d
LEFT JOIN tg_chat_links l ON l.department_id = d.id AND l.is_active
LEFT JOIN tg_known_chats k ON k.chat_id = l.chat_id
WHERE fin_can_read_all();

GRANT SELECT ON public.fin_v_departments TO authenticated;

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
  v_old_name text;
  v_detail text;
BEGIN
  IF NOT fin_is_admin() THEN
    RAISE EXCEPTION 'forbidden' USING DETAIL = 'Только администратор финансов';
  END IF;
  PERFORM fin_private_assert_keys(payload, ARRAY['id', 'name', 'responsible_person_id', 'chat_id']);

  v_name := NULLIF(btrim(COALESCE(payload->>'name', '')), '');
  IF v_name IS NULL THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Название департамента обязательно';
  END IF;

  v_id   := fin_private_get_uuid(payload, 'id');
  v_resp_given := payload ? 'responsible_person_id';
  v_resp := fin_private_get_uuid(payload, 'responsible_person_id');
  v_chat_given := payload ? 'chat_id';
  v_chat := NULLIF(payload->>'chat_id', '')::bigint;

  IF v_resp IS NOT NULL AND NOT EXISTS (SELECT 1 FROM vaishnavas WHERE id = v_resp) THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Ответственный не найден в справочнике людей';
  END IF;

  -- Имя уникально без учёта регистра: бот ищет департамент по тексту сообщения
  -- и на «Кухня» / «кухня» выбрать между ними не смог бы.
  IF EXISTS (SELECT 1 FROM fin_departments
              WHERE lower(name) = lower(v_name) AND (v_id IS NULL OR id <> v_id)) THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = format('Департамент «%s» уже есть', v_name);
  END IF;

  IF v_chat IS NOT NULL AND NOT EXISTS (SELECT 1 FROM tg_known_chats WHERE chat_id = v_chat) THEN
    RAISE EXCEPTION 'invalid_payload'
      USING DETAIL = 'Такого чата бот ещё не видел — добавьте бота в чат, он появится в списке';
  END IF;

  IF v_id IS NULL THEN
    INSERT INTO fin_departments (name, responsible_person_id) VALUES (v_name, v_resp)
    RETURNING id INTO v_id;
  ELSE
    SELECT name INTO v_old_name FROM fin_departments WHERE id = v_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Департамент не найден';
    END IF;

    UPDATE fin_departments
       SET name = v_name,
           responsible_person_id = CASE WHEN v_resp_given THEN v_resp ELSE responsible_person_id END
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
      -- чат принадлежит одному департаменту, департамент — одному чату,
      -- иначе заявки из чата уедут не тому
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

REVOKE ALL ON FUNCTION public.fin_save_department(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fin_save_department(jsonb) TO authenticated;

COMMENT ON FUNCTION public.fin_save_department(jsonb) IS
  'Завести или переименовать департамент и привязать его чат. Подотчётный счёт создаётся сам при первой выдаче; при переименовании имя счёта тянется следом.';
