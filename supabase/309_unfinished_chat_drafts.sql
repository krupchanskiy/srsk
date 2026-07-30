-- Незавершённые заявки из чатов: бот спросил — человек не ответил.
--
-- Нашлось при сквозной проверке 29.07.2026. Бот присылает карточку с вопросом
-- («какая статья?», «в какой валюте?»), человек отвлекается, карточка уезжает
-- вверх по чату — и заявка навсегда остаётся в статусе proposed. В «Входящих»
-- видны только pending, поэтому таких заявок не видит НИКТО: ни казначей, ни автор.
-- На проде так висели четыре настоящие траты (овощи, семена авокадо, варенье,
-- навоз) возрастом от двух до шести дней. Деньги ушли, в учёте их нет.
--
-- Витрина показывает их фин-администратору, чтобы он мог напомнить человеку.
-- Отдельно от pending: pending ждёт действия казначея, а эти ждут ответа автора.

create or replace view fin_v_chat_drafts_unfinished as
select
    t.id,
    t.chat_id,
    t.source_message_id,
    t.kind,
    t.amount,
    t.currency,
    t.raw_text,
    t.purpose,
    c.name  as category,
    t.created_at,
    (current_date - t.created_at::date) as days_waiting,
    d.name  as department,
    coalesce(nullif(v.spiritual_name, ''),
             nullif(trim(coalesce(v.first_name, '') || ' ' || coalesce(v.last_name, '')), '')) as author,
    -- Чего именно не хватает, чтобы казначей понимал, о чём напоминать
    case
      when t.kind is null                                    then 'kind'
      when t.kind = 'transfer' and t.target_department_id is null then 'target'
      when t.currency is null                                then 'currency'
      when t.kind = 'expense' and t.category_id is null      then 'category'
      else 'confirm'
    end as missing
from tg_drafts t
join fin_departments d on d.id = t.department_id
left join fin_categories c on c.id = t.category_id
left join vaishnavas v on v.id = t.author_vaishnava_id
where t.status = 'proposed'
  and fin_can_read_all(auth.uid());

grant select on fin_v_chat_drafts_unfinished to authenticated;
