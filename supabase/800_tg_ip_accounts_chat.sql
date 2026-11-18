-- =============================================================
-- 800. Чат счетов ИП в Телеграме (ВГ 18.11.2026)
--
-- Отдельная группа «ВГ + Нитья-виласини» с ботом. Она привязана не к
-- департаменту, а к трём счетам: ИП ШРСК, Карта ИП, Карта ИП «Касса кафе».
-- Нитья-виласини пишет начисто:
--   • приход — Мурти (размер сета + сколько), Касса кафе, Полученные проценты;
--   • расход — департамент → статья из его набора (+ Оплата труда, Билеты,
--     Виза) либо «Налоги» без департамента; расход уходит во «Входящие»,
--     ВГ проводит там и связывает зарплату с ведомостью;
--   • перевод между этими счетами (ИП → карта).
-- Приход и перевод проводятся сразу от имени автора (он фин-админ) через
-- fin_create_income / fin_create_transfer — те же проверки, что на сайте.
-- Оплаты и возвраты участников вносятся в системе и в чат не идут.
--
-- Сверка: бот спрашивает остаток по банку на каждом счёте, показывает
-- расхождение; в системе сверка фиксируется только кнопкой ВГ
-- (fin_perform_reconciliation от его имени), и только без расхождения.
-- Дата операции берётся из сообщения («12.09 ...») — для внесения задним
-- числом с последней сверки 27.08.
-- =============================================================

-- ---------- статья «Налоги» (одна; разделим позже, если понадобится) ----------
INSERT INTO fin_categories (code, name, direction, visible_to_departments, is_active)
SELECT 'taxes', 'Налоги', 'out', false, true
WHERE NOT EXISTS (SELECT 1 FROM fin_categories WHERE code = 'taxes');

-- ---------- чаты счетов ----------
-- Без внешних ключей на vaishnavas: вторая FK ломает встраивание в PostgREST (797).
CREATE TABLE tg_account_chats (
  chat_id               bigint PRIMARY KEY,
  title                 text NOT NULL,
  approver_vaishnava_id uuid NOT NULL,          -- кто одобряет сверку (ВГ)
  is_active             boolean NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tg_account_chat_accounts (
  chat_id    bigint NOT NULL REFERENCES tg_account_chats(chat_id) ON DELETE CASCADE,
  account_id uuid   NOT NULL REFERENCES fin_accounts(id),
  short_name text   NOT NULL,                   -- «ИП», «Карта», «Кафе» — кнопки и строка остатков
  sort       int    NOT NULL DEFAULT 0,
  PRIMARY KEY (chat_id, account_id)
);

-- ---------- черновики операций чата счетов ----------
CREATE TABLE tg_ip_drafts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id             bigint NOT NULL REFERENCES tg_account_chats(chat_id),
  source_message_id   bigint NOT NULL,
  card_message_id     bigint,
  tg_user_id          bigint NOT NULL,
  author_vaishnava_id uuid,
  author_user_id      uuid,
  kind                text CHECK (kind IN ('income', 'expense', 'move')),
  amount              numeric(14,2) NOT NULL CHECK (amount > 0),
  occurred_on         date NOT NULL,
  account_id          uuid REFERENCES fin_accounts(id),
  target_account_id   uuid REFERENCES fin_accounts(id),
  category_id         uuid REFERENCES fin_categories(id),
  department_id       uuid REFERENCES fin_departments(id),
  no_department       boolean NOT NULL DEFAULT false,   -- налоги: департамента нет
  hint_category_code  text,                              -- подсказка из текста: murti / cafe_cash / interest_received / taxes
  murti_size          text CHECK (murti_size IN ('small', 'medium', 'large')),
  murti_count         int CHECK (murti_count BETWEEN 1 AND 99),
  raw_text            text NOT NULL,
  status              text NOT NULL DEFAULT 'proposed'
                      CHECK (status IN ('proposed', 'posted', 'sent_to_inbox', 'dismissed')),
  operation_id        uuid,
  inbox_draft_id      uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  resolved_at         timestamptz,
  UNIQUE (chat_id, source_message_id)
);

-- ---------- сверка ----------
CREATE TABLE tg_ip_reconciliations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id             bigint NOT NULL REFERENCES tg_account_chats(chat_id),
  started_by          uuid,                     -- vaishnava
  status              text NOT NULL DEFAULT 'collecting'
                      CHECK (status IN ('collecting', 'ready', 'approved', 'cancelled')),
  card_message_id     bigint,
  approved_by         uuid,                     -- vaishnava
  created_at          timestamptz NOT NULL DEFAULT now(),
  resolved_at         timestamptz
);

CREATE TABLE tg_ip_reconciliation_lines (
  recon_id          uuid   NOT NULL REFERENCES tg_ip_reconciliations(id) ON DELETE CASCADE,
  account_id        uuid   NOT NULL REFERENCES fin_accounts(id),
  sort              int    NOT NULL DEFAULT 0,
  prompt_message_id bigint,
  bank_balance      numeric(14,2),
  system_balance    numeric(14,2),
  opened_seq        bigint,
  PRIMARY KEY (recon_id, account_id)
);

ALTER TABLE tg_account_chats           ENABLE ROW LEVEL SECURITY;
ALTER TABLE tg_account_chat_accounts   ENABLE ROW LEVEL SECURITY;
ALTER TABLE tg_ip_drafts               ENABLE ROW LEVEL SECURITY;
ALTER TABLE tg_ip_reconciliations      ENABLE ROW LEVEL SECURITY;
ALTER TABLE tg_ip_reconciliation_lines ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON tg_account_chats, tg_account_chat_accounts, tg_ip_drafts,
              tg_ip_reconciliations, tg_ip_reconciliation_lines FROM anon, authenticated;

-- ---------- дата операции у заявки во «Входящих» ----------
ALTER TABLE tg_drafts ADD COLUMN IF NOT EXISTS occurred_on date;

-- =============================================================
-- Вспомогательное
-- =============================================================

-- Провести от имени человека: функции fin_* берут автора из auth.uid().
-- Только внутри транзакции (is_local = true).
CREATE OR REPLACE FUNCTION tg_ip_act_as(p_user uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub', p_user::text, true);
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
END $$;

-- Чат счетов: null — чат не такой
CREATE OR REPLACE FUNCTION tg_ip_chat(p_chat bigint)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object(
    'chat_id', c.chat_id, 'title', c.title,
    'approver_vaishnava_id', c.approver_vaishnava_id,
    'accounts', (SELECT jsonb_agg(jsonb_build_object('id', a.account_id, 'short', a.short_name, 'name', f.name)
                                  ORDER BY a.sort)
                   FROM tg_account_chat_accounts a JOIN fin_accounts f ON f.id = a.account_id
                  WHERE a.chat_id = c.chat_id))
  FROM tg_account_chats c
  WHERE c.chat_id = p_chat AND c.is_active;
$$;

-- Строка остатков под проведённой операцией: «Остатки: ИП … · Карта … · Кафе …».
-- Для чужих чатов — null (используется и в tg_post_draft).
CREATE OR REPLACE FUNCTION tg_ip_balance_line(p_chat bigint)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT E'\nОстатки: ' || string_agg(
           format('%s %s', tg_escape(a.short_name),
                  fin_fmt_money(fin_private_account_balance(a.account_id), f.currency_code)),
           ' · ' ORDER BY a.sort)
    FROM tg_account_chat_accounts a
    JOIN tg_account_chats c ON c.chat_id = a.chat_id AND c.is_active
    JOIN fin_accounts f ON f.id = a.account_id
   WHERE a.chat_id = p_chat
  HAVING count(*) > 0;
$$;

-- /баланс в чате счетов: остаток каждого счёта, дата последней сверки,
-- сколько операций прошло после неё и что ждёт во «Входящих».
CREATE OR REPLACE FUNCTION tg_ip_balances_text(p_chat bigint)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  r record; v_text text := '💰 <b>Остатки по системе</b>';
  v_pending int; v_pending_sum numeric;
BEGIN
  FOR r IN
    SELECT a.short_name, f.name, f.currency_code,
           fin_private_account_balance(a.account_id) AS bal,
           lr.performed_at, lr.cutoff_ledger_seq,
           (SELECT count(DISTINCT p.operation_id) FROM fin_postings p
             WHERE p.account_id = a.account_id
               AND p.ledger_seq > COALESCE(lr.cutoff_ledger_seq, 0)) AS ops_after
      FROM tg_account_chat_accounts a
      JOIN fin_accounts f ON f.id = a.account_id
      LEFT JOIN LATERAL (
        SELECT performed_at, cutoff_ledger_seq FROM fin_reconciliations
         WHERE account_id = a.account_id ORDER BY performed_at DESC LIMIT 1) lr ON true
     WHERE a.chat_id = p_chat
     ORDER BY a.sort
  LOOP
    v_text := v_text || format(E'\n• <b>%s: %s</b>', tg_escape(r.short_name), fin_fmt_money(r.bal, r.currency_code))
           || CASE WHEN r.performed_at IS NULL THEN E'\n   сверки ещё не было'
                   ELSE format(E'\n   сверка %s · после неё операций: %s',
                               to_char((r.performed_at AT TIME ZONE 'Asia/Kolkata')::date, 'DD.MM.YYYY'), r.ops_after) END;
  END LOOP;

  SELECT count(*), COALESCE(sum(amount), 0) INTO v_pending, v_pending_sum
    FROM tg_drafts WHERE chat_id = p_chat AND status = 'pending';
  IF v_pending > 0 THEN
    v_text := v_text || format(E'\n\n⏳ Ждут проведения во «Входящих»: %s на %s — в остатке их ещё нет.',
                               v_pending, fin_fmt_money(v_pending_sum, 'RUB'));
  END IF;
  RETURN v_text;
END $$;

-- =============================================================
-- Черновик: создание, состояние, выбор, подтверждение
-- =============================================================

CREATE OR REPLACE FUNCTION tg_ip_create_draft(p jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_chat bigint := (p->>'chat_id')::bigint;
  v_user bigint := (p->>'tg_user_id')::bigint;
  v_msg  bigint := (p->>'source_message_id')::bigint;
  v_amount numeric := (p->>'amount')::numeric;
  v_on date := COALESCE(NULLIF(p->>'occurred_on', '')::date, (now() AT TIME ZONE 'Asia/Kolkata')::date);
  v_today date := (now() AT TIME ZONE 'Asia/Kolkata')::date;
  v_vid uuid; v_uid uuid; v_id uuid; v_dup timestamptz;
  v_norm text := lower(regexp_replace(btrim(COALESCE(p->>'raw_text', '')), '\s+', ' ', 'g'));
BEGIN
  IF NOT EXISTS (SELECT 1 FROM tg_account_chats WHERE chat_id = v_chat AND is_active) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_account_chat');
  END IF;

  SELECT l.vaishnava_id, v.user_id INTO v_vid, v_uid
    FROM tg_user_links l JOIN vaishnavas v ON v.id = l.vaishnava_id
   WHERE l.tg_user_id = v_user;
  IF v_uid IS NULL OR NOT fin_is_admin(v_uid) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_admin');
  END IF;

  IF v_on > v_today THEN
    RETURN jsonb_build_object('ok', false, 'error', 'future_date', 'date', v_on);
  END IF;
  IF v_on < v_today - 366 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'too_old', 'date', v_on);
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('tg_ip:' || v_chat::text || ':' || v_user::text, 0));
  SELECT d.created_at INTO v_dup FROM tg_ip_drafts d
   WHERE d.chat_id = v_chat AND d.tg_user_id = v_user AND d.source_message_id <> v_msg
     AND d.status <> 'dismissed' AND d.created_at > now() - interval '10 minutes'
     AND d.amount = v_amount
     AND lower(regexp_replace(btrim(d.raw_text), '\s+', ' ', 'g')) = v_norm
   LIMIT 1;
  IF FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'duplicate');
  END IF;

  INSERT INTO tg_ip_drafts (chat_id, source_message_id, tg_user_id, author_vaishnava_id, author_user_id,
                            amount, occurred_on, raw_text, hint_category_code, murti_size, murti_count)
  VALUES (v_chat, v_msg, v_user, v_vid, v_uid, v_amount, v_on, p->>'raw_text',
          NULLIF(p->>'hint_category_code', ''), NULLIF(p->>'murti_size', ''),
          NULLIF(p->>'murti_count', '')::int)
  ON CONFLICT (chat_id, source_message_id) DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'exists'); END IF;
  RETURN tg_ip_state(v_id);
END $$;

-- Варианты для текущего вопроса карточки: [{v, t}] — v уходит обратно в tg_ip_pick
CREATE OR REPLACE FUNCTION tg_ip_options(p_id uuid, p_need text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE d tg_ip_drafts%ROWTYPE; v jsonb;
BEGIN
  SELECT * INTO d FROM tg_ip_drafts WHERE id = p_id;
  IF p_need = 'kind' THEN
    RETURN '[{"v":"income","t":"📥 Приход"},{"v":"expense","t":"💸 Расход"},{"v":"move","t":"🔁 Перевод между счетами"}]'::jsonb;
  ELSIF p_need IN ('account', 'target') THEN
    SELECT jsonb_agg(jsonb_build_object('v', left(a.account_id::text, 8), 't', f.name) ORDER BY a.sort) INTO v
      FROM tg_account_chat_accounts a JOIN fin_accounts f ON f.id = a.account_id
     WHERE a.chat_id = d.chat_id
       AND (p_need = 'account' OR a.account_id <> d.account_id);
  ELSIF p_need = 'category' AND d.kind = 'income' THEN
    SELECT jsonb_agg(jsonb_build_object('v', left(c.id::text, 8), 't', c.name)
                     ORDER BY array_position(ARRAY['murti','cafe_cash','interest_received'], c.code)) INTO v
      FROM fin_categories c
     WHERE c.code IN ('murti', 'cafe_cash', 'interest_received') AND c.is_active;
  ELSIF p_need = 'department' THEN
    SELECT jsonb_build_array(jsonb_build_object('v', 'none', 't', '🧾 Налоги — без департамента'))
           || COALESCE(jsonb_agg(jsonb_build_object('v', left(x.id::text, 8), 't', x.name) ORDER BY x.name), '[]'::jsonb)
      INTO v FROM fin_departments x;
  ELSIF p_need = 'category' AND d.kind = 'expense' THEN
    -- набор департамента (или общий, если своего нет) + Оплата труда, Билеты, Виза
    WITH own AS (
      SELECT c.id, c.name FROM fin_department_categories dc JOIN fin_categories c ON c.id = dc.category_id
       WHERE dc.department_id = d.department_id AND c.is_active AND c.direction = 'out'
    ), base AS (
      SELECT id, name FROM own
      UNION
      SELECT c.id, c.name FROM fin_categories c
       WHERE NOT EXISTS (SELECT 1 FROM own) AND c.direction = 'out' AND c.visible_to_departments AND c.is_active
      UNION
      SELECT c.id, c.name FROM fin_categories c WHERE c.code IN ('dept_labor', 'tickets', 'visa') AND c.is_active
    )
    SELECT jsonb_agg(jsonb_build_object('v', left(id::text, 8), 't', name) ORDER BY name) INTO v FROM base;
  ELSIF p_need = 'murti_size' THEN
    RETURN '[{"v":"small","t":"Маленький"},{"v":"medium","t":"Средний"},{"v":"large","t":"Большой"}]'::jsonb;
  ELSIF p_need = 'murti_count' THEN
    SELECT jsonb_agg(jsonb_build_object('v', n::text, 't', n::text) ORDER BY n) INTO v FROM generate_series(1, 6) n;
  END IF;
  RETURN COALESCE(v, '[]'::jsonb);
END $$;

-- Состояние черновика: что уже понятно, какой следующий вопрос и варианты ответа
CREATE OR REPLACE FUNCTION tg_ip_state(p_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  d tg_ip_drafts%ROWTYPE; v_need text; v_code text; v_murti text;
  v_today date := (now() AT TIME ZONE 'Asia/Kolkata')::date;
BEGIN
  SELECT * INTO d FROM tg_ip_drafts WHERE id = p_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'not_found'); END IF;
  SELECT code INTO v_code FROM fin_categories WHERE id = d.category_id;

  v_need := CASE
    WHEN d.kind IS NULL THEN 'kind'
    WHEN d.account_id IS NULL THEN 'account'
    WHEN d.kind = 'move' AND d.target_account_id IS NULL THEN 'target'
    WHEN d.kind = 'income' AND d.category_id IS NULL THEN 'category'
    WHEN d.kind = 'income' AND v_code = 'murti' AND d.murti_size IS NULL THEN 'murti_size'
    WHEN d.kind = 'income' AND v_code = 'murti' AND d.murti_count IS NULL THEN 'murti_count'
    WHEN d.kind = 'expense' AND d.department_id IS NULL AND NOT d.no_department THEN 'department'
    WHEN d.kind = 'expense' AND d.category_id IS NULL THEN 'category'
  END;

  IF d.murti_size IS NOT NULL THEN
    v_murti := CASE d.murti_size WHEN 'small' THEN 'Маленький' WHEN 'medium' THEN 'Средний' ELSE 'Большой' END
               || ' сет' || COALESCE(' × ' || d.murti_count, '');
  END IF;

  RETURN jsonb_build_object(
    'ok', true, 'id', d.id, 'status', d.status, 'kind', d.kind,
    'amount', d.amount, 'amount_fmt', fin_fmt_money(d.amount, 'RUB'),
    'occurred_on', to_char(d.occurred_on, 'DD.MM.YYYY'),
    'days_ago', v_today - d.occurred_on,
    'raw_text', d.raw_text,
    'account', (SELECT name FROM fin_accounts WHERE id = d.account_id),
    'target', (SELECT name FROM fin_accounts WHERE id = d.target_account_id),
    'category', (SELECT name FROM fin_categories WHERE id = d.category_id),
    'department', CASE WHEN d.no_department THEN 'без департамента'
                       ELSE (SELECT name FROM fin_departments WHERE id = d.department_id) END,
    'murti', v_murti,
    'needs', v_need,
    'options', CASE WHEN v_need IS NULL THEN '[]'::jsonb ELSE tg_ip_options(d.id, v_need) END
  );
END $$;

-- Ответ кнопкой: p_field = kind / account / target / category / department / murti_size / murti_count
CREATE OR REPLACE FUNCTION tg_ip_pick(p_id uuid, p_field text, p_value text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  d tg_ip_drafts%ROWTYPE; v_opt jsonb; v_full uuid;
BEGIN
  SELECT * INTO d FROM tg_ip_drafts WHERE id = p_id AND status = 'proposed' FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'closed'); END IF;

  -- значение должно быть среди показанных вариантов этого вопроса
  SELECT o INTO v_opt FROM jsonb_array_elements(tg_ip_options(p_id, p_field)) o WHERE o->>'v' = p_value;
  IF v_opt IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'bad_value'); END IF;

  IF p_field = 'kind' THEN
    UPDATE tg_ip_drafts SET kind = p_value, target_account_id = NULL, category_id = NULL,
           department_id = NULL, no_department = false
     WHERE id = p_id;
    -- подсказка из текста: «мурти», «касса кафе», «проценты» → статья прихода сразу
    IF p_value = 'income' AND d.hint_category_code IN ('murti', 'cafe_cash', 'interest_received') THEN
      UPDATE tg_ip_drafts SET category_id = (SELECT id FROM fin_categories WHERE code = d.hint_category_code)
       WHERE id = p_id;
    ELSIF p_value = 'expense' AND d.hint_category_code = 'taxes' THEN
      UPDATE tg_ip_drafts SET no_department = true, category_id = (SELECT id FROM fin_categories WHERE code = 'taxes')
       WHERE id = p_id;
    END IF;
  ELSIF p_field IN ('account', 'target') THEN
    SELECT a.account_id INTO v_full FROM tg_account_chat_accounts a
     WHERE a.chat_id = d.chat_id AND left(a.account_id::text, 8) = p_value;
    IF p_field = 'account' THEN
      UPDATE tg_ip_drafts SET account_id = v_full,
             target_account_id = CASE WHEN target_account_id = v_full THEN NULL ELSE target_account_id END
       WHERE id = p_id;
    ELSE
      UPDATE tg_ip_drafts SET target_account_id = v_full WHERE id = p_id;
    END IF;
  ELSIF p_field = 'department' THEN
    IF p_value = 'none' THEN
      UPDATE tg_ip_drafts SET no_department = true, department_id = NULL,
             category_id = (SELECT id FROM fin_categories WHERE code = 'taxes')
       WHERE id = p_id;
    ELSE
      UPDATE tg_ip_drafts SET no_department = false, category_id = NULL,
             department_id = (SELECT id FROM fin_departments WHERE left(id::text, 8) = p_value LIMIT 1)
       WHERE id = p_id;
    END IF;
  ELSIF p_field = 'category' THEN
    UPDATE tg_ip_drafts SET category_id = (SELECT id FROM fin_categories WHERE left(id::text, 8) = p_value LIMIT 1)
     WHERE id = p_id;
  ELSIF p_field = 'murti_size' THEN
    UPDATE tg_ip_drafts SET murti_size = p_value WHERE id = p_id;
  ELSIF p_field = 'murti_count' THEN
    UPDATE tg_ip_drafts SET murti_count = p_value::int WHERE id = p_id;
  ELSE
    RETURN jsonb_build_object('ok', false, 'error', 'bad_field');
  END IF;
  RETURN tg_ip_state(p_id);
END $$;

CREATE OR REPLACE FUNCTION tg_ip_set_card(p_id uuid, p_message_id bigint)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE tg_ip_drafts SET card_message_id = p_message_id WHERE id = p_id;
$$;

-- «Отмена»: 👎 на исходном сообщении — как в чатах департаментов, видно и после
-- удаления карточки, что операция не записана
CREATE OR REPLACE FUNCTION tg_ip_dismiss(p_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE d tg_ip_drafts%ROWTYPE;
BEGIN
  UPDATE tg_ip_drafts SET status = 'dismissed', resolved_at = now()
   WHERE id = p_id AND status = 'proposed'
  RETURNING * INTO d;
  IF FOUND THEN PERFORM tg_set_reaction(d.chat_id, d.source_message_id, '👎'); END IF;
END $$;

-- «Записать»: приход и перевод — сразу проводка от имени автора;
-- расход — заявка во «Входящие» (там департамент, статья, связь с ведомостью).
CREATE OR REPLACE FUNCTION tg_ip_confirm(p_id uuid, p_tg_user bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  d tg_ip_drafts%ROWTYPE; s jsonb; v_res jsonb; v_op uuid; v_note text; v_inbox uuid;
  v_text text;
BEGIN
  SELECT * INTO d FROM tg_ip_drafts WHERE id = p_id AND status = 'proposed' FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'closed'); END IF;
  IF d.tg_user_id <> p_tg_user THEN RETURN jsonb_build_object('ok', false, 'error', 'not_author'); END IF;
  s := tg_ip_state(p_id);
  IF s->>'needs' IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'incomplete'); END IF;

  IF d.kind = 'expense' THEN
    INSERT INTO tg_drafts (chat_id, source_message_id, card_message_id, tg_user_id, author_vaishnava_id,
                           department_id, target_department_id, kind, amount, currency, purpose, raw_text,
                           status, category_id, source_account_id, occurred_on)
    VALUES (d.chat_id, d.source_message_id, d.card_message_id, d.tg_user_id, d.author_vaishnava_id,
            NULL, d.department_id, 'expense', d.amount, 'RUB', btrim(d.raw_text), d.raw_text,
            'pending', d.category_id, d.account_id, d.occurred_on)
    RETURNING id INTO v_inbox;
    UPDATE tg_ip_drafts SET status = 'sent_to_inbox', inbox_draft_id = v_inbox, resolved_at = now() WHERE id = p_id;
    PERFORM tg_set_reaction(d.chat_id, d.source_message_id, '👀');
    RETURN jsonb_build_object('ok', true, 'text',
      format('📨 <b>Расход %s — во «Входящих»</b>', s->>'amount_fmt')
      || format(E'\n%s · %s → %s', s->>'occurred_on', tg_escape(s->>'account'),
                CASE WHEN d.no_department THEN tg_escape(s->>'category')
                     ELSE tg_escape(s->>'department') || ' · ' || tg_escape(s->>'category') END)
      || E'\nВ остатке появится после проведения — эта карточка обновится.');
  END IF;

  PERFORM tg_ip_act_as(d.author_user_id);
  PERFORM set_config('tg.suppress_chat_notify', '1', true);

  IF d.kind = 'income' THEN
    v_note := s->>'murti';
    v_res := fin_create_income(jsonb_build_object(
      'request_id', d.id, 'occurred_on', d.occurred_on,
      'comment', format('Из чата «%s»: %s',
                        (SELECT title FROM tg_account_chats WHERE chat_id = d.chat_id), d.raw_text),
      'rows', jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
        'id', fin_private_child_uuid(d.id, 'ip-income-row'),
        'account_id', d.account_id, 'amount', d.amount,
        'category_id', d.category_id, 'note', v_note)))));
  ELSE
    v_res := fin_create_transfer(jsonb_build_object(
      'request_id', d.id, 'occurred_on', d.occurred_on,
      'source_account_id', d.account_id, 'target_account_id', d.target_account_id,
      'source_amount', d.amount,
      'comment', format('Из чата «%s»: %s',
                        (SELECT title FROM tg_account_chats WHERE chat_id = d.chat_id), d.raw_text)));
  END IF;

  IF NOT COALESCE((v_res->>'ok')::boolean, false) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'post_failed',
                              'message', COALESCE(v_res#>>'{error,message}', 'не удалось провести'));
  END IF;
  v_op := COALESCE(NULLIF(v_res#>>'{result,operation_id}', '')::uuid, d.id);
  UPDATE tg_ip_drafts SET status = 'posted', operation_id = v_op, resolved_at = now() WHERE id = p_id;
  PERFORM tg_set_reaction(d.chat_id, d.source_message_id, '👍');

  v_text := CASE WHEN d.kind = 'income'
      THEN format('✅ <b>Приход %s</b>', s->>'amount_fmt')
           || format(E'\n%s · %s%s → %s', s->>'occurred_on', tg_escape(s->>'category'),
                     COALESCE(' (' || tg_escape(v_note) || ')', ''), tg_escape(s->>'account'))
      ELSE format('✅ <b>Перевод %s</b>', s->>'amount_fmt')
           || format(E'\n%s · %s → %s', s->>'occurred_on', tg_escape(s->>'account'), tg_escape(s->>'target'))
    END || COALESCE(tg_ip_balance_line(d.chat_id), '');
  RETURN jsonb_build_object('ok', true, 'text', v_text);
END $$;

-- =============================================================
-- Сверка
-- =============================================================

-- Кто может вести сверку в чате: фин-админ по привязке Телеграма
CREATE OR REPLACE FUNCTION tg_ip_user(p_tg_user bigint)
RETURNS TABLE (vaishnava_id uuid, user_id uuid, is_admin boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT l.vaishnava_id, v.user_id, COALESCE(fin_is_admin(v.user_id), false)
    FROM tg_user_links l JOIN vaishnavas v ON v.id = l.vaishnava_id
   WHERE l.tg_user_id = p_tg_user;
$$;

-- Начать: прежняя незаконченная сверка чата отменяется, строки — по счетам чата
CREATE OR REPLACE FUNCTION tg_ip_recon_start(p_chat bigint, p_tg_user bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE u record; v_id uuid;
BEGIN
  SELECT * INTO u FROM tg_ip_user(p_tg_user);
  IF NOT COALESCE(u.is_admin, false) THEN RETURN jsonb_build_object('ok', false, 'error', 'not_admin'); END IF;
  IF NOT EXISTS (SELECT 1 FROM tg_account_chats WHERE chat_id = p_chat AND is_active) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_account_chat');
  END IF;
  UPDATE tg_ip_reconciliations SET status = 'cancelled', resolved_at = now()
   WHERE chat_id = p_chat AND status IN ('collecting', 'ready');
  INSERT INTO tg_ip_reconciliations (chat_id, started_by) VALUES (p_chat, u.vaishnava_id) RETURNING id INTO v_id;
  INSERT INTO tg_ip_reconciliation_lines (recon_id, account_id, sort)
  SELECT v_id, account_id, sort FROM tg_account_chat_accounts WHERE chat_id = p_chat;
  RETURN tg_ip_recon_next(v_id);
END $$;

-- Следующий счёт без банковского остатка либо «все введены»
CREATE OR REPLACE FUNCTION tg_ip_recon_next(p_recon uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(
    (SELECT jsonb_build_object('ok', true, 'recon_id', p_recon, 'done', false,
                               'account_id', l.account_id, 'account', f.name,
                               'step', (SELECT count(*) FROM tg_ip_reconciliation_lines x
                                         WHERE x.recon_id = p_recon AND x.bank_balance IS NOT NULL) + 1,
                               'total', (SELECT count(*) FROM tg_ip_reconciliation_lines x WHERE x.recon_id = p_recon))
       FROM tg_ip_reconciliation_lines l JOIN fin_accounts f ON f.id = l.account_id
      WHERE l.recon_id = p_recon AND l.bank_balance IS NULL
      ORDER BY l.sort LIMIT 1),
    jsonb_build_object('ok', true, 'recon_id', p_recon, 'done', true));
$$;

CREATE OR REPLACE FUNCTION tg_ip_recon_set_prompt(p_recon uuid, p_account uuid, p_message_id bigint)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE tg_ip_reconciliation_lines SET prompt_message_id = p_message_id
   WHERE recon_id = p_recon AND account_id = p_account;
$$;

-- Ответ на вопрос «остаток по банку?» (reply на сообщение бота)
CREATE OR REPLACE FUNCTION tg_ip_recon_answer(p_chat bigint, p_reply_to bigint, p_tg_user bigint, p_amount numeric)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_recon uuid; v_acc uuid; u record;
BEGIN
  SELECT l.recon_id, l.account_id INTO v_recon, v_acc
    FROM tg_ip_reconciliation_lines l JOIN tg_ip_reconciliations r ON r.id = l.recon_id
   WHERE r.chat_id = p_chat AND r.status = 'collecting' AND l.prompt_message_id = p_reply_to;
  IF v_recon IS NULL THEN RETURN NULL; END IF;   -- это не ответ на вопрос сверки
  SELECT * INTO u FROM tg_ip_user(p_tg_user);
  IF NOT COALESCE(u.is_admin, false) THEN RETURN jsonb_build_object('ok', false, 'error', 'not_admin'); END IF;
  UPDATE tg_ip_reconciliation_lines SET bank_balance = round(p_amount, 2)
   WHERE recon_id = v_recon AND account_id = v_acc;
  RETURN tg_ip_recon_next(v_recon);
END $$;

-- Сводка: остаток в системе на сейчас против банка; фиксирует номер последней
-- проводки — одобрение пройдёт, только если после сводки по счёту ничего не провели.
CREATE OR REPLACE FUNCTION tg_ip_recon_summary(p_recon uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  r record; v_text text; v_all_zero boolean := true; v_diff numeric; v_chat bigint;
  v_pending int; v_pending_sum numeric;
BEGIN
  SELECT chat_id INTO v_chat FROM tg_ip_reconciliations WHERE id = p_recon AND status IN ('collecting', 'ready');
  IF v_chat IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'closed'); END IF;
  IF EXISTS (SELECT 1 FROM tg_ip_reconciliation_lines WHERE recon_id = p_recon AND bank_balance IS NULL) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'incomplete');
  END IF;

  UPDATE tg_ip_reconciliation_lines l
     SET opened_seq = (SELECT COALESCE(max(ledger_seq), 0) FROM fin_postings p WHERE p.account_id = l.account_id),
         system_balance = fin_private_account_balance(l.account_id)
   WHERE l.recon_id = p_recon;
  UPDATE tg_ip_reconciliations SET status = 'ready' WHERE id = p_recon;

  v_text := format('🧮 <b>Сверка на %s</b>',
                   to_char(now() AT TIME ZONE 'Asia/Kolkata', 'DD.MM.YYYY HH24:MI'));
  FOR r IN
    SELECT f.name, f.currency_code, l.bank_balance, l.system_balance
      FROM tg_ip_reconciliation_lines l JOIN fin_accounts f ON f.id = l.account_id
     WHERE l.recon_id = p_recon ORDER BY l.sort
  LOOP
    v_diff := r.bank_balance - r.system_balance;
    IF v_diff <> 0 THEN v_all_zero := false; END IF;
    v_text := v_text || format(E'\n\n<b>%s</b>\nБанк: %s\nСистема: %s\n%s',
      tg_escape(r.name), fin_fmt_money(r.bank_balance, r.currency_code),
      fin_fmt_money(r.system_balance, r.currency_code),
      CASE WHEN v_diff = 0 THEN '✅ Сходится'
           WHEN v_diff > 0 THEN format('⚠️ В банке больше на %s — не внесён приход?', fin_fmt_money(v_diff, r.currency_code))
           ELSE format('⚠️ В банке меньше на %s — не внесён расход?', fin_fmt_money(-v_diff, r.currency_code)) END);
  END LOOP;

  SELECT count(*), COALESCE(sum(amount), 0) INTO v_pending, v_pending_sum
    FROM tg_drafts WHERE chat_id = v_chat AND status = 'pending';
  IF v_pending > 0 THEN
    v_text := v_text || format(E'\n\n⏳ Во «Входящих» ждут проведения: %s на %s — проведите их и пересчитайте.',
                               v_pending, fin_fmt_money(v_pending_sum, 'RUB'));
  END IF;

  v_text := v_text || CASE WHEN v_all_zero
    THEN E'\n\nВсё сходится. Сверка запишется в систему после одобрения Ванамали Гопала.'
    ELSE E'\n\nПока есть расхождение, сверку не записываем: внесите недостающие операции и нажмите «Пересчитать».' END;

  RETURN jsonb_build_object('ok', true, 'recon_id', p_recon, 'all_zero', v_all_zero, 'text', v_text);
END $$;

CREATE OR REPLACE FUNCTION tg_ip_recon_set_card(p_recon uuid, p_message_id bigint)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE tg_ip_reconciliations SET card_message_id = p_message_id WHERE id = p_recon;
$$;

-- Операции после прошлой сверки — искать, чего не хватает
CREATE OR REPLACE FUNCTION tg_ip_recon_ops(p_recon uuid)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE a record; o record; v_text text := '📋 <b>Операции после прошлой сверки</b>'; v_n int;
BEGIN
  FOR a IN
    SELECT l.account_id, f.name, f.currency_code,
           (SELECT max(cutoff_ledger_seq) FROM fin_reconciliations x WHERE x.account_id = l.account_id) AS cutoff,
           (SELECT (max(performed_at) AT TIME ZONE 'Asia/Kolkata')::date FROM fin_reconciliations x
             WHERE x.account_id = l.account_id) AS last_on
      FROM tg_ip_reconciliation_lines l JOIN fin_accounts f ON f.id = l.account_id
     WHERE l.recon_id = p_recon ORDER BY l.sort
  LOOP
    SELECT count(*) INTO v_n FROM fin_postings p WHERE p.account_id = a.account_id AND p.ledger_seq > COALESCE(a.cutoff, 0);
    v_text := v_text || format(E'\n\n<b>%s</b> — с %s: %s',
                               tg_escape(a.name), COALESCE(to_char(a.last_on, 'DD.MM.YYYY'), 'начала'), v_n);
    FOR o IN
      SELECT op.occurred_on, p.direction, p.amount, c.name AS cat, op.comment, op.type
        FROM fin_postings p JOIN fin_operations op ON op.id = p.operation_id
        LEFT JOIN fin_categories c ON c.id = p.category_id
       WHERE p.account_id = a.account_id AND p.ledger_seq > COALESCE(a.cutoff, 0)
       ORDER BY op.occurred_on DESC, p.ledger_seq DESC LIMIT 15
    LOOP
      v_text := v_text || format(E'\n%s %s%s · %s',
        to_char(o.occurred_on, 'DD.MM'),
        CASE WHEN o.direction = 'in' THEN '+' ELSE '−' END,
        fin_fmt_money(o.amount, a.currency_code),
        tg_escape(left(COALESCE(o.cat, CASE o.type WHEN 'transfer' THEN 'перевод' ELSE o.type::text END)
                       || COALESCE(' — ' || o.comment, ''), 70)));
    END LOOP;
    IF v_n > 15 THEN v_text := v_text || format(E'\n… и ещё %s — полностью на сайте: Финансы → Счета', v_n - 15); END IF;
  END LOOP;
  RETURN v_text;
END $$;

-- Одобрение: только одобряющий чата (ВГ), только без расхождения. Все счета —
-- одной транзакцией: если хоть один не прошёл (по счёту успели провести
-- операцию), не записывается ни один.
CREATE OR REPLACE FUNCTION tg_ip_recon_approve(p_recon uuid, p_tg_user bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  rc tg_ip_reconciliations%ROWTYPE; u record; ln record; v_res jsonb; v_approver uuid;
  v_text text;
BEGIN
  SELECT * INTO rc FROM tg_ip_reconciliations WHERE id = p_recon FOR UPDATE;
  IF NOT FOUND OR rc.status <> 'ready' THEN RETURN jsonb_build_object('ok', false, 'error', 'closed'); END IF;
  SELECT approver_vaishnava_id INTO v_approver FROM tg_account_chats WHERE chat_id = rc.chat_id;
  SELECT * INTO u FROM tg_ip_user(p_tg_user);
  IF u.vaishnava_id IS DISTINCT FROM v_approver OR NOT COALESCE(u.is_admin, false) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_approver');
  END IF;
  IF EXISTS (SELECT 1 FROM tg_ip_reconciliation_lines WHERE recon_id = p_recon
              AND (bank_balance IS NULL OR system_balance IS NULL OR bank_balance <> system_balance)) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'has_difference');
  END IF;

  PERFORM tg_ip_act_as(u.user_id);
  BEGIN
    FOR ln IN SELECT * FROM tg_ip_reconciliation_lines WHERE recon_id = p_recon ORDER BY sort LOOP
      v_res := fin_perform_reconciliation(jsonb_build_object(
        'request_id', fin_private_child_uuid(p_recon, 'recon-' || ln.account_id::text),
        'account_id', ln.account_id, 'opened_seq', ln.opened_seq,
        'statement_balance', ln.bank_balance,
        'comment', 'Сверка в чате счетов ИП (Телеграм)'));
      IF NOT COALESCE((v_res->>'ok')::boolean, false) THEN
        RAISE EXCEPTION 'recon_failed' USING DETAIL = COALESCE(v_res#>>'{error,message}', 'сверка не прошла');
      END IF;
    END LOOP;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_text = PG_EXCEPTION_DETAIL;
    RETURN jsonb_build_object('ok', false, 'error', 'recon_failed',
                              'message', COALESCE(NULLIF(v_text, ''), SQLERRM));
  END;

  UPDATE tg_ip_reconciliations SET status = 'approved', approved_by = u.vaishnava_id, resolved_at = now()
   WHERE id = p_recon;
  SELECT format('✅ <b>Сверка записана %s</b>', to_char(now() AT TIME ZONE 'Asia/Kolkata', 'DD.MM.YYYY'))
         || string_agg(format(E'\n• %s: %s', tg_escape(f.name), fin_fmt_money(l.bank_balance, f.currency_code)), '' ORDER BY l.sort)
         || E'\nОдобрил: Ванамали Гопал'
    INTO v_text
    FROM tg_ip_reconciliation_lines l JOIN fin_accounts f ON f.id = l.account_id
   WHERE l.recon_id = p_recon;
  RETURN jsonb_build_object('ok', true, 'text', v_text);
END $$;

CREATE OR REPLACE FUNCTION tg_ip_recon_cancel(p_recon uuid)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE tg_ip_reconciliations SET status = 'cancelled', resolved_at = now()
   WHERE id = p_recon AND status IN ('collecting', 'ready');
$$;

-- =============================================================
-- Карточка бота — одна на операцию: расход, проведённый или отклонённый
-- во «Входящих», переписывает ту же карточку («ИП ШРСК → Кухня + остатки»),
-- а не шлёт новое сообщение. Телеграм позволяет боту править свои сообщения
-- без срока давности. Возвращает false — чат не счетов или карточки нет:
-- тогда вызывающий шлёт сообщение как раньше.
-- =============================================================
CREATE OR REPLACE FUNCTION tg_ip_edit_card(p_chat bigint, p_message bigint, p_text text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_token text;
BEGIN
  IF p_message IS NULL OR NOT EXISTS (SELECT 1 FROM tg_account_chats WHERE chat_id = p_chat) THEN
    RETURN false;
  END IF;
  SELECT decrypted_secret INTO v_token FROM vault.decrypted_secrets WHERE name = 'telegram_bot_token';
  PERFORM net.http_post(
    url := format('https://api.telegram.org/bot%s/editMessageText', v_token),
    headers := '{"Content-Type":"application/json"}'::jsonb,
    body := jsonb_build_object('chat_id', p_chat, 'message_id', p_message, 'text', p_text,
                               'parse_mode', 'HTML', 'disable_web_page_preview', true,
                               'reply_markup', jsonb_build_object('inline_keyboard', '[]'::jsonb)),
    timeout_milliseconds := 15000);
  RETURN true;
EXCEPTION WHEN OTHERS THEN
  RETURN false;   -- запись в учёте важнее карточки
END $$;

-- Итог проведённого расхода: «💸 Расход 5 000 ₽ · 12.09.2026 / ИП ШРСК → Кухня · Продукты»;
-- при разбивке — строками. p_rows — разбивка из «Входящих» (null — одной строкой по заявке).
CREATE OR REPLACE FUNCTION tg_ip_expense_text(p_draft uuid, p_acc uuid, p_rows jsonb, p_note_tg text)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE d tg_drafts%ROWTYPE; v_acc text; v_lab text[]; v_amt numeric[]; v text; i int;
BEGIN
  SELECT * INTO d FROM tg_drafts WHERE id = p_draft;
  SELECT name INTO v_acc FROM fin_accounts WHERE id = p_acc;
  SELECT array_agg(lab ORDER BY ord), array_agg(amt ORDER BY ord) INTO v_lab, v_amt
    FROM (
      SELECT min(t.ord) AS ord, sum((t.r->>'amount')::numeric) AS amt,
             concat_ws(' · ', dp.name, c.name) AS lab
        FROM jsonb_array_elements(COALESCE(p_rows, jsonb_build_array(jsonb_build_object(
               'amount', d.amount, 'category_id', d.category_id,
               'department_id', d.target_department_id)))) WITH ORDINALITY AS t(r, ord)
        LEFT JOIN fin_departments dp ON dp.id = NULLIF(t.r->>'department_id', '')::uuid
        LEFT JOIN fin_categories  c  ON c.id  = NULLIF(t.r->>'category_id', '')::uuid
       GROUP BY concat_ws(' · ', dp.name, c.name)
    ) x;
  v := format('💸 <b>Расход %s</b> · %s', fin_fmt_money(d.amount, d.currency),
              to_char(COALESCE(d.occurred_on, d.created_at::date), 'DD.MM.YYYY'));
  IF COALESCE(array_length(v_lab, 1), 0) <= 1 THEN
    v := v || format(E'\n%s → %s', tg_escape(v_acc), tg_escape(COALESCE(NULLIF(v_lab[1], ''), '—')));
  ELSE
    v := v || format(E'\n%s →', tg_escape(v_acc));
    FOR i IN 1 .. array_length(v_lab, 1) LOOP
      v := v || format(E'\n• %s — %s', tg_escape(COALESCE(NULLIF(v_lab[i], ''), '—')),
                       fin_fmt_money(v_amt[i], d.currency));
    END LOOP;
  END IF;
  RETURN v || COALESCE(p_note_tg, '') || COALESCE(tg_ip_balance_line(d.chat_id), '');
END $$;

-- Функции бота вызывает только вебхук (service_role): они проводят деньги от имени людей
DO $$
DECLARE f text;
BEGIN
  FOR f IN SELECT p.oid::regprocedure::text FROM pg_proc p
            WHERE p.pronamespace = 'public'::regnamespace
              AND (p.proname LIKE 'tg\_ip\_%' OR p.proname = 'tg_ip_chat')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END LOOP;
END $$;

-- =============================================================
-- «Входящие»: заявки из чата счетов (департамента у них нет)
-- =============================================================
CREATE OR REPLACE VIEW fin_v_chat_drafts AS
 SELECT t.id,
    t.chat_id,
    t.source_message_id,
    t.kind,
    t.amount,
    t.currency,
    t.raw_text,
    t.purpose,
    c.name AS category,
    a.name AS source_account,
    t.created_at,
    COALESCE(d.name, ac.title) AS department,
    td.name AS target_department,
    COALESCE(NULLIF(v.spiritual_name, ''::text), TRIM(BOTH FROM ((COALESCE(v.first_name, ''::text) || ' '::text) || COALESCE(v.last_name, ''::text)))) AS author,
    t.category_id,
    t.department_id,
    t.target_department_id,
    t.source_account_id,
    t.note,
    t.occurred_on
   FROM tg_drafts t
     LEFT JOIN fin_departments d ON d.id = t.department_id
     LEFT JOIN tg_account_chats ac ON ac.chat_id = t.chat_id
     LEFT JOIN fin_departments td ON td.id = t.target_department_id
     LEFT JOIN fin_categories c ON c.id = t.category_id
     LEFT JOIN fin_accounts a ON a.id = t.source_account_id
     LEFT JOIN vaishnavas v ON v.id = t.author_vaishnava_id
  WHERE t.status = 'pending'::text AND (d.id IS NOT NULL OR ac.chat_id IS NOT NULL)
    AND fin_can_read_all(auth.uid());

-- tg_post_draft: дата операции — из заявки (задним числом), остатки счетов чата
-- ИП — в сообщении о проведении. Правка по месту: тело функции большое (23 КБ),
-- меняются только эти выражения; если функция уже другая — миграция падает.
DO $$
DECLARE v text;
BEGIN
  v := pg_get_functiondef('tg_post_draft(uuid,jsonb,uuid,text,uuid,boolean)'::regprocedure);
  IF position('v_d.created_at::date' IN v) = 0
     OR position('v_bal_line := COALESCE(v_bal_line, '''');' IN v) = 0 THEN
    RAISE EXCEPTION 'tg_post_draft изменилась — правку 800 нужно пересобрать';
  END IF;
  v := replace(v, 'v_d.created_at::date', 'COALESCE(v_d.occurred_on, v_d.created_at::date)');
  -- расход из чата счетов: та же карточка становится итогом «откуда → куда + остатки»
  IF position(E'  IF v_suppress THEN\n    v_bal_acc :=' IN v) = 0 THEN
    RAISE EXCEPTION 'tg_post_draft изменилась — правку 800 нужно пересобрать';
  END IF;
  v := replace(v, E'  IF v_suppress THEN\n    v_bal_acc :=',
    E'  IF tg_ip_edit_card(v_d.chat_id, v_d.card_message_id,\n'
    || E'                     tg_ip_expense_text(v_d.id, v_acc, p_rows, v_note_tg)) THEN\n'
    || E'    NULL;\n'
    || E'  ELSIF v_suppress THEN\n    v_bal_acc :=');
  EXECUTE v;

  -- отклонение во «Входящих»: в чате счетов — той же карточкой
  v := pg_get_functiondef('tg_dismiss_draft(uuid,text)'::regprocedure);
  IF position('PERFORM tg_send_chat(v_d.chat_id, v_text, v_d.source_message_id);' IN v) = 0 THEN
    RAISE EXCEPTION 'tg_dismiss_draft изменилась — правку 800 нужно пересобрать';
  END IF;
  v := replace(v, 'PERFORM tg_send_chat(v_d.chat_id, v_text, v_d.source_message_id);',
    'IF NOT tg_ip_edit_card(v_d.chat_id, v_d.card_message_id, v_text) THEN PERFORM tg_send_chat(v_d.chat_id, v_text, v_d.source_message_id); END IF;');
  EXECUTE v;
END $$;

-- =============================================================
-- Сторно → 👎 и в чате счетов ИП (как в чатах департаментов, 457)
-- =============================================================
-- Приход и перевод из чата ИП проводятся сразу, их операция — в tg_ip_drafts.
-- Расходы идут через tg_drafts и уже покрыты общей веткой.
CREATE OR REPLACE FUNCTION public.tg_on_reversal_reaction()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_d record;
BEGIN
  IF NEW.type::text <> 'reversal' OR NEW.original_operation_id IS NULL THEN RETURN NEW; END IF;

  FOR v_d IN
    SELECT d.id, d.chat_id, d.source_message_id
      FROM tg_drafts d
     WHERE d.status = 'posted'
       AND (d.id IN (SELECT dop.draft_id FROM tg_draft_operations dop WHERE dop.operation_id = NEW.original_operation_id)
            OR d.operation_id = NEW.original_operation_id)
  LOOP
    -- в силе остаётся хоть одна операция заявки (кроме отменяемой) — 👍 не трогаем
    IF EXISTS (
      SELECT 1
        FROM fin_operations o
       WHERE o.id <> NEW.original_operation_id
         AND o.type::text <> 'reversal'
         AND NOT o.is_reversed
         AND (o.id IN (SELECT dop.operation_id FROM tg_draft_operations dop WHERE dop.draft_id = v_d.id)
              OR o.id = (SELECT d2.operation_id FROM tg_drafts d2 WHERE d2.id = v_d.id))
    ) THEN
      CONTINUE;
    END IF;

    PERFORM tg_set_reaction(v_d.chat_id, v_d.source_message_id, '👎');
  END LOOP;

  -- чат счетов ИП: одна операция на сообщение
  FOR v_d IN
    SELECT d.chat_id, d.source_message_id FROM tg_ip_drafts d
     WHERE d.status = 'posted' AND d.operation_id = NEW.original_operation_id
  LOOP
    PERFORM tg_set_reaction(v_d.chat_id, v_d.source_message_id, '👎');
  END LOOP;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.tg_on_reversal_reaction() FROM PUBLIC, anon, authenticated;
