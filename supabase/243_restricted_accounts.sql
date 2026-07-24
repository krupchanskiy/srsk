-- =============================================================
-- Ограниченные счета — «Подушка безопасности» (запрос Адриана, 23.07.2026).
--
-- Задача: резервный счёт, чей остаток не мозолит глаза в общих отчётах
-- (иначе резерв «расслабляет» — его начинают воспринимать как доступные
-- деньги). При этом деньги остаются в честном учёте: счёт настоящий,
-- сверяется, входит в проверки целостности. Прячем ЧИСЛО от лишних глаз,
-- а не деньги от учёта — это разные вещи, вторая недопустима.
--
-- Механика: флаг is_restricted. Для такого счёта общее право «видеть все
-- финансы» (fin_can_read_all) НЕ действует — доступ только у тех, кто
-- поимённо внесён в fin_account_access. Остальным счёт не виден нигде:
-- в остатках, в сумме «Всего под ответственностью», в ленте ДДС, в списке
-- операций (перевод на подушку скрыт целиком — иначе второй конец выдаст
-- сумму), в сверках и в утреннем Telegram-дайджесте.
--
-- Кто видит настраивается записями fin_account_access. Для подушки это
-- три администратора финансов: Адриан, Ванамали Гопал, Нитья-виласини.
-- =============================================================

ALTER TABLE fin_accounts ADD COLUMN IF NOT EXISTS is_restricted boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN fin_accounts.is_restricted IS
'Ограниченный счёт (резерв/подушка): общее право fin_can_read_all на него не распространяется, виден только тем, кто внесён в fin_account_access. Скрыт во всех витринах, суммах и дайджесте.';

-- Единая проверка видимости счёта. Обычный счёт — по общему праву или
-- явному доступу (как было); ограниченный — ТОЛЬКО по явному доступу,
-- даже для fin_admin. Одна функция — один источник правды для всех витрин.
CREATE OR REPLACE FUNCTION public.fin_can_see_account(p_account_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM fin_accounts a
    WHERE a.id = p_account_id
      AND (
        (NOT a.is_restricted AND fin_can_read_all(auth.uid()))
        OR EXISTS (SELECT 1 FROM fin_account_access aa
                   WHERE aa.account_id = a.id AND aa.user_id = auth.uid())
      )
  );
$function$;
REVOKE ALL ON FUNCTION public.fin_can_see_account(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fin_can_see_account(uuid) TO authenticated;

-- ---------- Остатки: ограниченный счёт — только по доступу ----------
CREATE OR REPLACE VIEW public.fin_v_account_balances AS
SELECT a.id AS account_id, a.name, a.kind, a.reconciliation_mode, a.currency_code,
    a.group_name, a.responsible_person_id, a.default_cost_center_id, a.is_active,
    COALESCE(s.balance, 0::numeric)::numeric(14,2) AS balance,
    s.last_ledger_seq,
    COALESCE(s.balance, 0::numeric) < 0::numeric AS is_negative,
    r.cutoff_ledger_seq AS last_checkpoint_seq,
    r.performed_at AS last_checkpoint_at,
    (SELECT count(*) FROM fin_postings p
      WHERE p.account_id = a.id AND p.ledger_seq > COALESCE(r.cutoff_ledger_seq, 0::bigint)) AS unreconciled_count
FROM fin_accounts a
LEFT JOIN (SELECT fin_postings.account_id,
        sum(CASE fin_postings.direction WHEN 'in'::fin_direction THEN fin_postings.amount ELSE - fin_postings.amount END) AS balance,
        max(fin_postings.ledger_seq) AS last_ledger_seq
       FROM fin_postings GROUP BY fin_postings.account_id) s ON s.account_id = a.id
LEFT JOIN LATERAL (SELECT rr.cutoff_ledger_seq, rr.performed_at
       FROM fin_reconciliations rr WHERE rr.account_id = a.id
       ORDER BY rr.performed_at DESC, rr.cutoff_ledger_seq DESC LIMIT 1) r ON true
WHERE fin_can_see_account(a.id);

-- ---------- Лента ДДС ----------
CREATE OR REPLACE VIEW public.fin_v_account_ledger AS
SELECT p.id AS posting_id, p.ledger_seq, p.operation_id, o.type, o.approval, o.is_reversed,
    o.occurred_on, o.created_at, o.comment, o.reason,
    o.created_at::date > o.occurred_on AS is_late,
    p.account_id, a.name AS account_name, p.currency_code, p.direction, p.amount,
    CASE p.direction WHEN 'in'::fin_direction THEN p.amount ELSE - p.amount END AS signed_amount,
    p.amount_base, p.rate_used, p.category_id, cat.name AS category_name,
    p.cost_center_id, cc.name AS cost_center_name, p.object_id, obj.display_name AS object_name,
    p.participant_id, fin_private_person_name(p.participant_id) AS participant_name,
    p.contractor_id, con.name AS contractor_name, p.payment_channel, p.is_post_close,
    sum(CASE p.direction WHEN 'in'::fin_direction THEN p.amount ELSE - p.amount END)
        OVER (PARTITION BY p.account_id ORDER BY p.ledger_seq) AS running_balance,
    fin_private_analytics_hash(p.category_id, p.cost_center_id, p.object_id, p.participant_id, p.participant_balance_kind, p.contractor_id) AS analytics_hash,
    p.participant_balance_kind
FROM fin_postings p
JOIN fin_operations o ON o.id = p.operation_id
JOIN fin_accounts a ON a.id = p.account_id
LEFT JOIN fin_categories cat ON cat.id = p.category_id
LEFT JOIN fin_cost_centers cc ON cc.id = p.cost_center_id
LEFT JOIN fin_accounting_objects obj ON obj.id = p.object_id
LEFT JOIN fin_contractors con ON con.id = p.contractor_id
WHERE fin_can_see_account(p.account_id);

-- ---------- Операции: скрыть целиком те, что касаются невидимого счёта ----------
-- Операция видна, если у пользователя есть общий доступ И среди её проводок
-- нет ни одной на счёт, который пользователю видеть не положено. Перевод
-- «оборот → подушка» пропадает целиком у того, кто подушку не видит —
-- вместе с суммой второго конца.
CREATE OR REPLACE VIEW public.fin_v_operations AS
SELECT o.id AS operation_id, o.type, o.occurred_on, o.approval, o.is_reversed,
    o.original_operation_id, o.payer_contact_id,
    fin_private_person_name(o.payer_contact_id) AS payer_name,
    o.reason, o.comment, o.created_by, o.created_at,
    o.created_at::date > o.occurred_on AS is_late,
    agg.has_post_close, agg.accounts_count, agg.max_ledger_seq, agg.amounts_by_currency,
    (EXISTS (SELECT 1 FROM fin_attachments att
          WHERE att.parent_type = 'operation'::fin_attachment_parent_type AND att.parent_id = o.id)) AS has_attachments
FROM fin_operations o
JOIN LATERAL (SELECT bool_or(p.is_post_close) AS has_post_close,
        count(DISTINCT p.account_id) AS accounts_count,
        max(p.ledger_seq) AS max_ledger_seq,
        (SELECT jsonb_object_agg(x.currency_code, x.total)
               FROM (SELECT pp.currency_code,
                            CASE WHEN o.type = 'transfer'::fin_operation_type
                                 THEN sum(pp.amount) FILTER (WHERE pp.direction = 'in'::fin_direction)
                                 ELSE sum(CASE pp.direction WHEN 'in'::fin_direction THEN pp.amount ELSE - pp.amount END)
                            END AS total
                       FROM fin_postings pp WHERE pp.operation_id = o.id
                      GROUP BY pp.currency_code) x
              WHERE x.total IS NOT NULL) AS amounts_by_currency
       FROM fin_postings p WHERE p.operation_id = o.id) agg ON true
WHERE fin_can_read_all()
  AND NOT EXISTS (
    SELECT 1 FROM fin_postings pr
    JOIN fin_accounts ar ON ar.id = pr.account_id
    WHERE pr.operation_id = o.id
      AND ar.is_restricted
      AND NOT EXISTS (SELECT 1 FROM fin_account_access aa
                      WHERE aa.account_id = ar.id AND aa.user_id = auth.uid())
  );

-- ---------- Сверки ----------
CREATE OR REPLACE VIEW public.fin_v_reconciliations AS
SELECT r.id, r.account_id, a.name AS account_name, r.performed_at, r.performed_by,
    fin_private_person_name((SELECT v.id FROM vaishnavas v WHERE v.user_id = r.performed_by LIMIT 1)) AS performed_by_name,
    r.system_balance, r.counted_balance, r.original_difference, r.difference,
    r.cutoff_ledger_seq, r.adjustment_operation_id, r.counts, r.comment, r.is_checkpoint
FROM fin_reconciliations r
JOIN fin_accounts a ON a.id = r.account_id
WHERE fin_can_see_account(r.account_id);

-- ---------- Список доступов (кто к какому счёту) ----------
CREATE OR REPLACE VIEW public.fin_v_account_access AS
SELECT aa.user_id, aa.account_id, a.name AS account_name,
    (SELECT fin_private_person_name(v.id) FROM vaishnavas v WHERE v.user_id = aa.user_id) AS user_name
FROM fin_account_access aa
JOIN fin_accounts a ON a.id = aa.account_id
WHERE fin_can_see_account(aa.account_id);

-- ---------- Telegram-дайджест: остатки без ограниченных счетов ----------
-- Дайджест идёт в канал; подушка не должна попасть даже туда. Правим
-- только выборку остатков — остальное тело функции не трогаем.
CREATE OR REPLACE FUNCTION public.fin_tg_daily_digest()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_balances text := '';
  v_empty int := 0;
  v_in text := '';
  v_out text := '';
  v_moves text := '';
  v_attention text := '';
  v_pending bigint;
  v_unposted bigint;
  v_stale text[] := '{}';
  v_stale_n int;
  r record;
BEGIN
  FOR r IN
    SELECT a.name, a.currency_code,
           COALESCE(SUM(CASE p.direction WHEN 'in' THEN p.amount ELSE -p.amount END), 0) AS bal
    FROM fin_accounts a
    LEFT JOIN fin_postings p ON p.account_id = a.id
    WHERE a.kind = 'real' AND a.is_active AND NOT a.is_restricted
    GROUP BY a.id, a.name, a.currency_code
    ORDER BY a.name
  LOOP
    IF r.bal = 0 THEN
      v_empty := v_empty + 1;
    ELSE
      v_balances := v_balances || format(E'\n• %s — <b>%s</b>',
        tg_escape(fin_short_account_name(r.name)), fin_fmt_money(r.bal, r.currency_code));
    END IF;
  END LOOP;
  IF v_balances = '' THEN
    v_balances := E'\nвсе счета пусты';
  ELSIF v_empty > 0 THEN
    v_balances := v_balances || format(E'\n<i>ещё %s %s пуст%s</i>',
      v_empty, fin_plural(v_empty, 'счёт', 'счёта', 'счетов'),
      fin_plural(v_empty, '', 'ы', 'ы'));
  END IF;

  FOR r IN
    SELECT p.currency_code,
           SUM(p.amount) FILTER (WHERE p.direction = 'in') AS s_in,
           SUM(p.amount) FILTER (WHERE p.direction = 'out') AS s_out
    FROM fin_postings p
    JOIN fin_operations o ON o.id = p.operation_id
    JOIN fin_accounts a ON a.id = p.account_id
    WHERE o.occurred_on = CURRENT_DATE - 1
      AND a.kind = 'real' AND NOT a.is_restricted
      AND o.type NOT IN ('transfer', 'reversal')
      AND NOT o.is_reversed
    GROUP BY p.currency_code
    ORDER BY p.currency_code
  LOOP
    IF COALESCE(r.s_in, 0) > 0 THEN
      v_in := v_in || CASE WHEN v_in = '' THEN '' ELSE ', ' END || fin_fmt_money(r.s_in, r.currency_code);
    END IF;
    IF COALESCE(r.s_out, 0) > 0 THEN
      v_out := v_out || CASE WHEN v_out = '' THEN '' ELSE ', ' END || fin_fmt_money(r.s_out, r.currency_code);
    END IF;
  END LOOP;
  IF v_in <> '' THEN v_moves := v_moves || format(E'\n• приход — <b>%s</b>', v_in); END IF;
  IF v_out <> '' THEN v_moves := v_moves || format(E'\n• расход — <b>%s</b>', v_out); END IF;
  IF v_moves = '' THEN v_moves := E'\nдвижения не было'; END IF;

  SELECT count(*) INTO v_pending FROM crm_payments WHERE NOT is_confirmed;
  SELECT count(*) INTO v_unposted
  FROM crm_payments cp
  WHERE cp.is_confirmed
    AND COALESCE(cp.received_at::date, CURRENT_DATE) >= COALESCE(fin_cutover_date(), DATE '1900-01-01')
    AND NOT EXISTS (SELECT 1 FROM fin_operations o WHERE o.id = cp.id)
    AND EXISTS (SELECT 1 FROM fin_crm_autopost_log g WHERE g.payment_id = cp.id AND g.status <> 'skipped');

  IF v_unposted > 0 THEN
    v_attention := v_attention || format(E'\n🔴 не разнесен%s в учёт — <b>%s</b>',
      fin_plural(v_unposted, '', 'ы', 'ы'), v_unposted);
  END IF;
  IF v_pending > 0 THEN
    v_attention := v_attention || format(E'\n• ждут подтверждения — <b>%s %s</b>',
      v_pending, fin_plural(v_pending, 'платёж', 'платежа', 'платежей'));
  END IF;

  FOR r IN
    SELECT a.name,
           (SELECT max(c.performed_at) FROM fin_reconciliations c
            WHERE c.account_id = a.id AND c.is_checkpoint) AS last_cp
    FROM fin_accounts a
    WHERE a.kind = 'real' AND a.is_active AND NOT a.is_restricted
      AND EXISTS (SELECT 1 FROM fin_postings p WHERE p.account_id = a.id)
    ORDER BY a.name
  LOOP
    IF r.last_cp IS NULL OR r.last_cp < now() - interval '3 days' THEN
      v_stale := v_stale || fin_short_account_name(r.name);
    END IF;
  END LOOP;
  v_stale_n := array_length(v_stale, 1);
  IF v_stale_n IS NOT NULL THEN
    v_attention := v_attention || CASE
      WHEN v_stale_n <= 3 THEN format(E'\n• давно не сверялись — %s', tg_escape(array_to_string(v_stale, ', ')))
      ELSE format(E'\n• давно не сверялись — <b>%s %s</b>', v_stale_n,
                  fin_plural(v_stale_n, 'счёт', 'счёта', 'счетов')) END;
  END IF;
  IF v_attention = '' THEN v_attention := E'\nвсё в порядке'; END IF;

  PERFORM tg_send('finance', format(
    E'☀️ <b>Финансы · %s</b>\n\n<b>Остатки</b>%s\n\n<b>Вчера</b>%s\n\n<b>Требует внимания</b>%s\n\n<a href="https://in.rupaseva.com/finance/index.html">Открыть финмодуль</a>',
    fin_fmt_date_ru(CURRENT_DATE), v_balances, v_moves, v_attention));
END;
$function$;
REVOKE ALL ON FUNCTION public.fin_tg_daily_digest() FROM PUBLIC, anon, authenticated;

-- ---------- Сигнал «минус» в Telegram: не выдавать ограниченный счёт ----------
CREATE OR REPLACE FUNCTION public.tg_on_negative_balance()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_acc fin_accounts%ROWTYPE;
  v_balance numeric;
BEGIN
  IF NEW.direction <> 'out' THEN RETURN NEW; END IF;
  SELECT * INTO v_acc FROM fin_accounts WHERE id = NEW.account_id;
  IF v_acc.kind <> 'real' OR v_acc.is_restricted THEN RETURN NEW; END IF;
  SELECT COALESCE(SUM(CASE direction WHEN 'in' THEN amount ELSE -amount END), 0)
    INTO v_balance FROM fin_postings WHERE account_id = NEW.account_id;
  IF v_balance < 0 AND v_balance + NEW.amount >= 0 THEN
    PERFORM tg_send('finance', format(
      E'🔴 <b>Счёт ушёл в минус</b>\n%s — <b>%s</b>\n\n<a href="https://in.rupaseva.com/finance/dds.html?account=%s">Открыть ленту счёта</a>',
      tg_escape(fin_short_account_name(v_acc.name)),
      fin_fmt_money(v_balance, v_acc.currency_code), v_acc.id));
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON public.fin_v_account_balances FROM anon;
REVOKE ALL ON public.fin_v_account_ledger FROM anon;
REVOKE ALL ON public.fin_v_operations FROM anon;
REVOKE ALL ON public.fin_v_reconciliations FROM anon;
REVOKE ALL ON public.fin_v_account_access FROM anon;
GRANT SELECT ON public.fin_v_account_balances TO authenticated;
GRANT SELECT ON public.fin_v_account_ledger TO authenticated;
GRANT SELECT ON public.fin_v_operations TO authenticated;
GRANT SELECT ON public.fin_v_reconciliations TO authenticated;
GRANT SELECT ON public.fin_v_account_access TO authenticated;
