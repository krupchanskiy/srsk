-- 700: проверка shared_login_blocks_portal видит все общие входы.
-- Раньше она замечала вход, только если у кого-то на нём были финансы, и
-- считала удалённые карточки. Теперь: живые карточки, больше одной на входе,
-- и хотя бы одна без семейной связи с остальными — финансы не важны.
-- Меняем точечно (replace) в fin_run_integrity_checks и fin_get_integrity_details,
-- чтобы не переписывать длинные функции целиком.

do $mig$
declare
  v_def text;
  v_new text;
begin
  -- 1. Счётчик в fin_run_integrity_checks
  v_def := pg_get_functiondef('public.fin_run_integrity_checks()'::regprocedure);
  v_new := replace(v_def,
    'SELECT v.user_id FROM vaishnavas v WHERE v.user_id IS NOT NULL GROUP BY v.user_id HAVING count(*) > 1 AND bool_or(EXISTS (SELECT 1 FROM fin_charges c WHERE c.participant_id = v.id) OR EXISTS (SELECT 1 FROM fin_participant_opening_balances ob WHERE ob.participant_id = v.id) OR EXISTS (SELECT 1 FROM fin_postings p WHERE p.participant_id = v.id)) AND EXISTS (SELECT 1 FROM vaishnavas v1 WHERE v1.user_id = v.user_id AND',
    'SELECT v.user_id FROM vaishnavas v WHERE v.user_id IS NOT NULL AND NOT COALESCE(v.is_deleted, false) GROUP BY v.user_id HAVING count(*) > 1 AND EXISTS (SELECT 1 FROM vaishnavas v1 WHERE v1.user_id = v.user_id AND NOT COALESCE(v1.is_deleted, false) AND');
  v_new := replace(v_new,
    'AND v2.user_id = v.user_id))) x',
    'AND v2.user_id = v.user_id AND NOT COALESCE(v2.is_deleted, false)))) x');
  v_new := replace(v_new,
    'Один вход делят несколько человек — портал не может показать им финансы, нужен отдельный вход каждому',
    'Один вход делят несколько человек без семейной связи — склеить дубль, связать семью или отвязать чужую карточку');
  if v_new = v_def or v_new not like '%NOT COALESCE(v2.is_deleted, false)))) x%' or v_new like '%bool_or(EXISTS (SELECT 1 FROM fin_charges%' then
    raise exception '700: fin_run_integrity_checks — замена не нашлась';
  end if;
  execute v_new;

  -- 2. Список в fin_get_integrity_details
  v_def := pg_get_functiondef('public.fin_get_integrity_details(text)'::regprocedure);
  v_new := replace(v_def,
    'select v.user_id from vaishnavas v where v.user_id is not null group by v.user_id',
    'select v.user_id from vaishnavas v where v.user_id is not null and not coalesce(v.is_deleted, false) group by v.user_id');
  v_new := regexp_replace(v_new,
    'and bool_or\(exists \(select 1 from fin_charges c where c\.participant_id = v\.id\).*?or exists \(select 1 from fin_postings p where p\.participant_id = v\.id\)\)\s*',
    '');
  v_new := replace(v_new,
    'select 1 from vaishnavas v1 where v1.user_id = v.user_id',
    'select 1 from vaishnavas v1 where v1.user_id = v.user_id and not coalesce(v1.is_deleted, false)');
  v_new := replace(v_new,
    'and v2.user_id = v.user_id)))',
    'and v2.user_id = v.user_id and not coalesce(v2.is_deleted, false))))
           and not coalesce(v.is_deleted, false)');
  if v_new like '%bool_or(exists (select 1 from fin_charges%'
     or v_new not like '%not coalesce(v2.is_deleted, false))))%'
     or v_new not like '%where v.user_id is not null and not coalesce(v.is_deleted, false) group by%' then
    raise exception '700: fin_get_integrity_details — замена не нашлась';
  end if;
  execute v_new;
end
$mig$;
