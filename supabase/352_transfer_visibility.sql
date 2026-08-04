-- Переводы между департаментами: правильный счёт и понятные уведомления.
--
-- Замечания Ванамали Гопала (03.08.2026):
-- 1) перевод из чата завода списывался с общей кассы, а не со счёта завода;
-- 2) в подтверждении отправителю не видно, какому департаменту переданы деньги;
-- 3) получателю не видно, от кого пришло и за что.
--
-- Причина (1): tg_list_source_accounts показывала казначею только реальные
-- счета — без всякой связи с департаментом-заявителем. Теперь первым идёт
-- подотчёт департамента, из чьего чата пришла заявка, а кассы остаются ниже
-- как осознанный выбор «казначей выдал из кассы».
--
-- Причина (2) и (3): триггер уведомлений знал только свою проводку. Теперь
-- он смотрит на вторую сторону операции и на назначение из заявки бота.

-- ---------------------------------------------------------------------------
-- 1. Счета-источники: свой подотчёт первым
-- ---------------------------------------------------------------------------
-- Старую двухпараметрическую версию убираем: иначе вызовы с двумя аргументами
-- (бот, UI) продолжали бы попадать в неё и не видели бы подотчёт департамента.
drop function if exists tg_list_source_accounts(text, boolean);

create or replace function tg_list_source_accounts(
  p_currency text,
  p_cash boolean default null,
  p_department uuid default null
)
returns table(id uuid, name text)
language sql stable security definer
set search_path to 'public'
as $$
  -- Подотчёт департамента-заявителя: его деньги, ими он и передаёт
  select a.id, a.name || ' — свой подотчёт' as name
    from fin_accounts a
   where p_department is not null
     and a.department_id = p_department
     and a.kind = 'custodial'
     and a.currency_code = p_currency
     and a.is_active
  union all
  -- Реальные кассы: сюда лезем, только когда выдаёт казначей
  select a.id, a.name
    from fin_accounts a
   where a.is_active and a.kind = 'real' and not a.is_restricted
     and a.currency_code = p_currency
     and (p_cash is null or (a.reconciliation_mode = 'cash_count') = p_cash)
  order by 2;
$$;

comment on function tg_list_source_accounts(text, boolean, uuid) is
  'Откуда списать. Первым — подотчёт департамента-заявителя, затем реальные кассы.';

-- ---------------------------------------------------------------------------
-- 2. Уведомления: кто, кому, с какого счёта и за что
-- ---------------------------------------------------------------------------
create or replace function tg_notify_dept_credit()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
DECLARE
  v_acc fin_accounts%ROWTYPE;
  v_optype text;
  v_orig_type text;
  v_chat bigint;
  v_bal numeric;
  v_head text;
  v_sign text;
  v_amount text;
  v_text text;
  v_other_acc text;      -- счёт второй стороны операции
  v_other_dept text;     -- её департамент (NULL, если это касса)
  v_purpose text;        -- назначение из заявки бота
BEGIN
  -- заявка из чата с разбивкой по департаментам сообщает о себе сама
  IF COALESCE(current_setting('tg.suppress_chat_notify', true), '') = '1' THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_acc FROM fin_accounts WHERE id = NEW.account_id;
  IF v_acc.department_id IS NULL OR v_acc.kind <> 'custodial' THEN RETURN NEW; END IF;

  SELECT chat_id INTO v_chat FROM tg_chat_links
   WHERE department_id = v_acc.department_id AND is_active;
  IF v_chat IS NULL THEN RETURN NEW; END IF;

  SELECT o.type::text,
         (SELECT oo.type::text FROM fin_operations oo WHERE oo.id = o.original_operation_id)
    INTO v_optype, v_orig_type
    FROM fin_operations o WHERE o.id = NEW.operation_id;

  -- Вторая сторона: обе проводки перевода вставляются одним оператором,
  -- поэтому к моменту срабатывания AFTER-триггера парная строка уже видна.
  SELECT a2.name, d2.name
    INTO v_other_acc, v_other_dept
    FROM fin_postings p2
    JOIN fin_accounts a2 ON a2.id = p2.account_id
    LEFT JOIN fin_departments d2 ON d2.id = a2.department_id
   WHERE p2.operation_id = NEW.operation_id
     AND p2.direction <> NEW.direction
   LIMIT 1;

  -- Назначение — из заявки бота: там оно написано человеческим языком
  -- («10 стульев для гест-хауса»), включая количество.
  SELECT NULLIF(btrim(dr.purpose), '')
    INTO v_purpose
    FROM tg_draft_operations dop
    JOIN tg_drafts dr ON dr.id = dop.draft_id
   WHERE dop.operation_id = NEW.operation_id
   LIMIT 1;

  v_sign := CASE WHEN NEW.direction = 'in' THEN '+' ELSE '−' END;
  v_amount := v_sign || fin_fmt_money(NEW.amount, v_acc.currency_code);

  v_head := CASE
    -- Перевод: называем вторую сторону поимённо
    WHEN v_optype = 'transfer' AND NEW.direction = 'in' AND v_other_dept IS NOT NULL
      THEN format('📥 <b>Получено от «%s»: %s</b>', tg_escape(v_other_dept), v_amount)
    WHEN v_optype = 'transfer' AND NEW.direction = 'in'
      THEN format('📥 <b>Выдано под отчёт: %s</b>', v_amount)
    WHEN v_optype = 'transfer' AND NEW.direction = 'out' AND v_other_dept IS NOT NULL
      THEN format('🔁 <b>Передано «%s»: %s</b>', tg_escape(v_other_dept), v_amount)
    WHEN v_optype = 'transfer' AND NEW.direction = 'out'
      THEN format('📤 <b>Возвращено в кассу: %s</b>', v_amount)
    WHEN v_optype = 'expense'  THEN format('💸 <b>Проведён расход: %s</b>', v_amount)
    WHEN v_optype = 'refund'   THEN format('↩️ <b>Возврат: %s</b>', v_amount)
    WHEN v_optype = 'reversal' AND v_orig_type = 'transfer'
      THEN format('❌ <b>Выдача отменена: %s</b>', v_amount)
    WHEN v_optype = 'reversal' AND v_orig_type = 'expense'
      THEN format('❌ <b>Расход отменён: %s</b>', v_amount)
    WHEN v_optype = 'reversal' THEN format('❌ <b>Операция отменена: %s</b>', v_amount)
    WHEN NEW.direction = 'in'  THEN format('📥 <b>Приход: %s</b>', v_amount)
    ELSE format('📤 <b>Списание: %s</b>', v_amount)
  END;

  v_text := v_head;

  -- С какого счёта пришло / куда ушло — только для переводов, где это неочевидно
  IF v_optype = 'transfer' AND v_other_acc IS NOT NULL THEN
    v_text := v_text || format(E'\n%s: %s',
      CASE WHEN NEW.direction = 'in' THEN 'Со счёта' ELSE 'На счёт' END,
      tg_escape(v_other_acc));
  END IF;

  IF v_purpose IS NOT NULL THEN
    v_text := v_text || format(E'\nНа что: %s', tg_escape(v_purpose));
  END IF;

  SELECT COALESCE(SUM(CASE direction WHEN 'in' THEN amount ELSE -amount END), 0)
    INTO v_bal FROM fin_postings WHERE account_id = NEW.account_id;

  v_text := v_text || format(E'\nНа руках у департамента: %s',
                             fin_fmt_money(v_bal, v_acc.currency_code));

  PERFORM tg_send_chat(v_chat, v_text);
  RETURN NEW;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 3. Непроведённые заявки: снять навязанную кассу
-- ---------------------------------------------------------------------------
-- Решение Адриана: правим только то, что ещё не проведено. Пустой счёт при
-- проведении означает «списать с подотчёта департамента» — то самое поведение,
-- которого просит ВГ. Проведённые операции не трогаем.
update tg_drafts d
   set source_account_id = null
  from fin_accounts a
 where a.id = d.source_account_id
   and a.kind = 'real'
   and d.status in ('proposed', 'pending')
   and d.department_id is not null
   and exists (select 1 from fin_accounts own
                where own.department_id = d.department_id
                  and own.kind = 'custodial'
                  and own.currency_code = d.currency);
