-- Передача денег между держателями одного департамента (правило ВГ, 22.09.2026).
--
-- «Передал Жене 500» в чате департамента — это НЕ передача другому департаменту
-- (та работает через tg_match_department), а перекладывание уже выданных денег
-- между двумя держателями ОДНОГО департамента. Раз найдено совпадение с
-- зарегистрированным держателем этого же департамента — создаём заявку на
-- передачу и ждём подтверждения именно от адресата.
--
-- Проводится сразу по подтверждению получателя, БЕЗ фин-админа — сознательное
-- единственное исключение из правила «бот не пишет в ядро»: общий остаток
-- департамента не меняется ни на копейку (обе проводки на одном и том же
-- счёте), риска для денег нет, а вся ценность фичи — в том, чтобы это
-- происходило без участия администратора.
--
-- Запасной инструмент на случай ошибки — fin_reassign_holder: та же самая
-- парная проводка, но без обязательного подтверждения получателя, доступна
-- только фин-админу. Обычно же ошибку правят той же передачей в обратную
-- сторону — отдельного UI для fin_reassign_holder нет, вызывается вручную.

-- «Женя» не находится обычным поиском по первым 4 буквам имени (у Евгении
-- Лебедевой это «евге», а не «женя») — уменьшительные имена не разбираем,
-- вместо этого у держателя можно явно указать, как его называют в чате.
ALTER TABLE public.fin_department_holders ADD COLUMN nickname text;

CREATE OR REPLACE FUNCTION public.fin_set_department_holder(p_department uuid, p_vaishnava uuid, p_active boolean, p_nickname text DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT fin_is_admin(auth.uid()) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;
  INSERT INTO fin_department_holders (department_id, vaishnava_id, is_active, nickname, created_by)
  VALUES (p_department, p_vaishnava, p_active, NULLIF(btrim(p_nickname), ''), auth.uid())
  ON CONFLICT (department_id, vaishnava_id) DO UPDATE
    SET is_active = p_active,
        nickname = COALESCE(NULLIF(btrim(p_nickname), ''), fin_department_holders.nickname);
  RETURN jsonb_build_object('ok', true);
END;
$function$;

CREATE TABLE public.tg_handoffs (
  id                     uuid primary key default gen_random_uuid(),
  chat_id                bigint not null,
  source_message_id      bigint not null,
  card_message_id        bigint,
  department_id          uuid not null references public.fin_departments(id),
  account_id             uuid not null references public.fin_accounts(id),
  sender_vaishnava_id    uuid not null references public.vaishnavas(id),
  recipient_vaishnava_id uuid not null references public.vaishnavas(id),
  amount                 numeric not null check (amount > 0),
  currency               text not null,
  raw_text               text not null,
  status                 text not null default 'pending' check (status in ('pending','posted','dismissed')),
  operation_id           uuid,
  created_at             timestamptz not null default now(),
  resolved_at            timestamptz,
  resolved_by            uuid references public.vaishnavas(id),
  unique (chat_id, source_message_id)
);

ALTER TABLE public.tg_handoffs ENABLE ROW LEVEL SECURITY;

CREATE POLICY tg_handoffs_read_admin ON public.tg_handoffs
  FOR SELECT TO authenticated
  USING (fin_is_admin(auth.uid()));

-- Тот же приём подбора имени по первым 4 буквам, что и у tg_match_department,
-- плюс явный ник, если он задан. p_exclude — сам автор сообщения: чтобы его
-- собственное имя в подписи не засчиталось получателем.
CREATE OR REPLACE FUNCTION public.tg_match_department_holder(p_department uuid, p_text text, p_exclude uuid)
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH t AS (SELECT lower(translate(p_text, 'Ёё', 'Ее')) AS txt),
  keys AS (
    SELECT fh.vaishnava_id AS id,
           lower(translate(left(COALESCE(NULLIF(v.spiritual_name,''),
                    trim(COALESCE(v.first_name,'') || ' ' || COALESCE(v.last_name,''))), 4), 'Ёё', 'Ее')) AS k
      FROM fin_department_holders fh
      JOIN vaishnavas v ON v.id = fh.vaishnava_id
     WHERE fh.department_id = p_department AND fh.is_active
    UNION ALL
    SELECT fh.vaishnava_id, lower(translate(fh.nickname, 'Ёё', 'Ее'))
      FROM fin_department_holders fh
     WHERE fh.department_id = p_department AND fh.is_active AND fh.nickname IS NOT NULL
  ),
  hits AS (
    SELECT DISTINCT k.id FROM keys k, t
    WHERE length(k.k) >= 3 AND t.txt LIKE '%' || k.k || '%'
      AND k.id <> COALESCE(p_exclude, '00000000-0000-0000-0000-000000000000')
  )
  SELECT id FROM hits WHERE (SELECT count(*) FROM hits) = 1;
$function$;

-- Заводит заявку на передачу. Требует, чтобы ОБА участника были
-- зарегистрированными держателями этого департамента. Валюту берёт из
-- сообщения, а если не названа — подставляет сама, только если у департамента
-- ровно один активный счёт (иначе не гадаем, тихо отступаем).
CREATE OR REPLACE FUNCTION public.tg_create_handoff(p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_chat bigint := (p->>'chat_id')::bigint;
  v_msg  bigint := (p->>'source_message_id')::bigint;
  v_user bigint := (p->>'tg_user_id')::bigint;
  v_amount numeric := (p->>'amount')::numeric;
  v_currency text := NULLIF(p->>'currency','');
  v_recipient uuid := NULLIF(p->>'recipient_vaishnava_id','')::uuid;
  v_raw text := p->>'raw_text';
  v_dept uuid;
  v_sender uuid;
  v_acc uuid;
  v_acc_count int;
  v_id uuid;
  v_dept_name text;
  v_sender_name text;
  v_recipient_name text;
BEGIN
  SELECT vaishnava_id INTO v_sender FROM tg_user_links WHERE tg_user_id = v_user;
  SELECT department_id INTO v_dept FROM tg_chat_links WHERE chat_id = v_chat AND is_active;
  IF v_dept IS NULL OR v_sender IS NULL OR v_recipient IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'no_context');
  END IF;
  IF v_recipient = v_sender THEN
    RETURN jsonb_build_object('ok', false, 'error', 'self');
  END IF;
  IF v_amount IS NULL OR v_amount <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'bad_amount');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM fin_department_holders WHERE department_id = v_dept AND vaishnava_id = v_sender AND is_active) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'sender_not_holder');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM fin_department_holders WHERE department_id = v_dept AND vaishnava_id = v_recipient AND is_active) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'recipient_not_holder');
  END IF;

  IF v_currency IS NULL THEN
    SELECT currency_code, count(*) OVER () INTO v_currency, v_acc_count
      FROM fin_accounts WHERE department_id = v_dept AND kind = 'custodial' AND is_active;
    IF v_acc_count IS DISTINCT FROM 1 THEN
      RETURN jsonb_build_object('ok', false, 'error', 'currency_ambiguous');
    END IF;
  END IF;

  v_acc := fin_dept_account(v_dept, v_currency);

  INSERT INTO tg_handoffs (chat_id, source_message_id, department_id, account_id,
                            sender_vaishnava_id, recipient_vaishnava_id, amount, currency, raw_text)
  VALUES (v_chat, v_msg, v_dept, v_acc, v_sender, v_recipient, v_amount, v_currency, v_raw)
  ON CONFLICT (chat_id, source_message_id) DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'duplicate');
  END IF;

  SELECT d.name INTO v_dept_name FROM fin_departments d WHERE d.id = v_dept;
  SELECT COALESCE(NULLIF(v.spiritual_name,''), TRIM(COALESCE(v.first_name,'')||' '||COALESCE(v.last_name,'')))
    INTO v_sender_name FROM vaishnavas v WHERE v.id = v_sender;
  SELECT COALESCE(NULLIF(v.spiritual_name,''), TRIM(COALESCE(v.first_name,'')||' '||COALESCE(v.last_name,'')))
    INTO v_recipient_name FROM vaishnavas v WHERE v.id = v_recipient;

  PERFORM tg_set_reaction(v_chat, v_msg, '👀');

  RETURN jsonb_build_object('ok', true, 'id', v_id, 'department_name', v_dept_name,
    'sender_name', v_sender_name, 'recipient_name', v_recipient_name, 'currency', v_currency);
END;
$function$;

CREATE OR REPLACE FUNCTION public.tg_set_handoff_card(p_id uuid, p_message_id bigint)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  UPDATE tg_handoffs SET card_message_id = p_message_id WHERE id = p_id;
$function$;

REVOKE ALL ON FUNCTION public.tg_match_department_holder(uuid, text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tg_create_handoff(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tg_set_handoff_card(uuid, bigint) FROM PUBLIC, anon, authenticated;

-- Подтверждение — только получатель, по его Telegram-id (не по имени в тексте).
-- На «да» сразу проводит парную проводку по одному и тому же счёту: держатель
-- меняется, общий остаток департамента не двигается. На «нет» просто закрывает
-- заявку. tg.suppress_chat_notify — чтобы обычный триггер прихода/расхода не
-- продублировал своё уведомление поверх нашего собственного сообщения.
CREATE OR REPLACE FUNCTION public.tg_handoff_confirm(p_id uuid, p_tg_user bigint, p_accept boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  h tg_handoffs%ROWTYPE;
  v_actor uuid;
  v_sender_name text;
  v_recipient_name text;
  v_dept_name text;
  v_op uuid;
  v_rate numeric;
  v_base numeric;
  v_sender_bal numeric;
  v_recipient_bal numeric;
  v_amount_txt text;
BEGIN
  SELECT * INTO h FROM tg_handoffs WHERE id = p_id AND status = 'pending' FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'not_found'); END IF;

  SELECT vaishnava_id INTO v_actor FROM tg_user_links WHERE tg_user_id = p_tg_user;

  SELECT COALESCE(NULLIF(v.spiritual_name,''), TRIM(COALESCE(v.first_name,'')||' '||COALESCE(v.last_name,'')))
    INTO v_recipient_name FROM vaishnavas v WHERE v.id = h.recipient_vaishnava_id;

  IF v_actor IS DISTINCT FROM h.recipient_vaishnava_id THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_recipient', 'recipient_name', v_recipient_name);
  END IF;

  SELECT COALESCE(NULLIF(v.spiritual_name,''), TRIM(COALESCE(v.first_name,'')||' '||COALESCE(v.last_name,'')))
    INTO v_sender_name FROM vaishnavas v WHERE v.id = h.sender_vaishnava_id;
  SELECT name INTO v_dept_name FROM fin_departments WHERE id = h.department_id;
  v_amount_txt := fin_fmt_money(h.amount, h.currency);

  IF NOT p_accept THEN
    UPDATE tg_handoffs SET status = 'dismissed', resolved_at = now(), resolved_by = v_actor WHERE id = p_id;
    PERFORM tg_set_reaction(h.chat_id, h.source_message_id, '👎');
    PERFORM tg_send_chat(h.chat_id,
      format('✖️ <b>Передача отклонена: %s</b>', v_amount_txt)
      || format(E'\n%s → %s', tg_escape(v_sender_name), tg_escape(v_recipient_name)),
      h.source_message_id);
    RETURN jsonb_build_object('ok', true, 'action', 'dismissed');
  END IF;

  PERFORM set_config('tg.suppress_chat_notify', '1', true);

  v_op := gen_random_uuid();
  v_rate := fin_private_get_rate(h.currency, NULL, current_date);
  v_base := round(h.amount * v_rate, 2);

  INSERT INTO fin_operations (id, request_hash, type, occurred_on, approval, created_by, comment)
  VALUES (v_op,
          fin_private_hash(jsonb_build_object('command', 'tg_handoff', 'op', v_op)),
          'transfer', current_date, 'not_required', v_actor,
          format('Передача внутри «%s»: %s → %s (из чата: %s)', v_dept_name, v_sender_name, v_recipient_name, h.raw_text));

  INSERT INTO fin_postings (id, operation_id, account_id, direction, amount, currency_code, amount_base, rate_used, holder_person_id)
  VALUES
    (fin_private_child_uuid(v_op, 'out'), v_op, h.account_id, 'out', h.amount, h.currency, v_base, v_rate, h.sender_vaishnava_id),
    (fin_private_child_uuid(v_op, 'in'),  v_op, h.account_id, 'in',  h.amount, h.currency, v_base, v_rate, h.recipient_vaishnava_id);

  UPDATE tg_handoffs SET status = 'posted', operation_id = v_op, resolved_at = now(), resolved_by = v_actor WHERE id = p_id;

  SELECT COALESCE(SUM(CASE direction WHEN 'in' THEN amount ELSE -amount END), 0) INTO v_sender_bal
    FROM fin_postings WHERE account_id = h.account_id AND holder_person_id = h.sender_vaishnava_id;
  SELECT COALESCE(SUM(CASE direction WHEN 'in' THEN amount ELSE -amount END), 0) INTO v_recipient_bal
    FROM fin_postings WHERE account_id = h.account_id AND holder_person_id = h.recipient_vaishnava_id;

  PERFORM tg_set_reaction(h.chat_id, h.source_message_id, '👍');
  PERFORM tg_send_chat(h.chat_id,
    format('✅ <b>Передача принята: %s</b>', v_amount_txt)
    || format(E'\n%s → %s', tg_escape(v_sender_name), tg_escape(v_recipient_name))
    || format(E'\nУ %s: %s', tg_escape(v_sender_name), fin_fmt_money(v_sender_bal, h.currency))
    || format(E'\nУ %s: %s', tg_escape(v_recipient_name), fin_fmt_money(v_recipient_bal, h.currency)),
    h.source_message_id);

  RETURN jsonb_build_object('ok', true, 'action', 'posted');
END;
$function$;

REVOKE ALL ON FUNCTION public.tg_handoff_confirm(uuid, bigint, boolean) FROM PUBLIC, anon, authenticated;

-- Запасной инструмент фин-админа: та же парная проводка, но без подтверждения
-- получателя — для случаев, когда исправить обратной передачей в чате
-- неудобно. p_from/p_to могут быть NULL — это означает «неразмеченный остаток»
-- (то же самое «не привязано» в /баланс), реассигнация работает и с ним.
CREATE OR REPLACE FUNCTION public.fin_reassign_holder(p_account uuid, p_from uuid, p_to uuid, p_amount numeric, p_reason text DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_acc fin_accounts%ROWTYPE;
  v_op uuid;
  v_rate numeric;
  v_base numeric;
BEGIN
  IF NOT fin_is_admin(auth.uid()) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'bad_amount');
  END IF;
  IF p_from IS NOT DISTINCT FROM p_to THEN
    RETURN jsonb_build_object('ok', false, 'error', 'same_holder');
  END IF;

  SELECT * INTO v_acc FROM fin_accounts WHERE id = p_account;
  IF v_acc.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'account_not_found'); END IF;

  PERFORM set_config('tg.suppress_chat_notify', '1', true);

  v_op := gen_random_uuid();
  v_rate := fin_private_get_rate(v_acc.currency_code, NULL, current_date);
  v_base := round(p_amount * v_rate, 2);

  INSERT INTO fin_operations (id, request_hash, type, occurred_on, approval, created_by, comment)
  VALUES (v_op,
          fin_private_hash(jsonb_build_object('command', 'fin_reassign_holder', 'op', v_op)),
          'transfer', current_date, 'not_required', auth.uid(),
          COALESCE(NULLIF(btrim(p_reason), ''), 'Ручная правка держателя'));

  INSERT INTO fin_postings (id, operation_id, account_id, direction, amount, currency_code, amount_base, rate_used, holder_person_id)
  VALUES
    (fin_private_child_uuid(v_op, 'out'), v_op, p_account, 'out', p_amount, v_acc.currency_code, v_base, v_rate, p_from),
    (fin_private_child_uuid(v_op, 'in'),  v_op, p_account, 'in',  p_amount, v_acc.currency_code, v_base, v_rate, p_to);

  RETURN jsonb_build_object('ok', true, 'operation_id', v_op);
END;
$function$;

REVOKE ALL ON FUNCTION public.fin_reassign_holder(uuid, uuid, uuid, numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fin_reassign_holder(uuid, uuid, uuid, numeric, text) TO authenticated;

-- Ник для Жени — иначе «Передал Жене» никогда не сматчится с «Евгения Лебедева»
UPDATE fin_department_holders SET nickname = 'Женя'
 WHERE department_id = '6b127381-1d7e-4bf0-9eaf-2594802b4524'
   AND vaishnava_id = '59c2b041-52ca-44ee-b342-fa4e35276eac';
