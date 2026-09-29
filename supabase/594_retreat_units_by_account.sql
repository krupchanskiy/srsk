-- 594: отчёт ретрита — Ретрит / Прасад / Кафе по СЧЁТУ, а не по статье (ВГ 29.09.2026).
-- Трата принадлежит департаменту своего счёта: всё со счёта Кафе — в «Кафе»
-- (в т.ч. «Закупка готового Прасада», Сева 35 670), всё со счёта Кухни — в «Прасад».
-- Было: к прасаду относились статьи 'Прасад' / 'Закупка готового Прасада' с любого счёта.
-- Меняем только условия отбора в двух функциях точечной заменой текста.
DO $mig$
DECLARE
  v_def text;
  v_new text;
BEGIN
  -- 1. Снимок отчёта
  SELECT pg_get_functiondef('public.fin_private_build_snapshot'::regproc) INTO v_def;
  v_new := replace(v_def,
    $s$AND c.name NOT IN ('Прасад', 'Закупка готового Прасада')$s$,
    $s$/* мигр. 594: всё со счёта кафе — кафе */$s$);
  v_new := replace(v_new,
    $s$AND c.name IN ('Прасад', 'Закупка готового Прасада')$s$,
    $s$AND p.account_id IN (SELECT fa.id FROM fin_accounts fa JOIN fin_departments fd ON fd.id = fa.department_id WHERE fd.name = 'Кухня')$s$);
  IF v_new = v_def OR v_new LIKE '%Закупка готового Прасада%' THEN
    RAISE EXCEPTION '594: fin_private_build_snapshot — условия не найдены';
  END IF;
  EXECUTE v_new;

  -- 2. Детализация строки отчёта — те же правила
  SELECT pg_get_functiondef('public.fin_get_report_drilldown'::regproc) INTO v_def;
  v_new := replace(v_def,
    $s$WHEN c.direction::text = 'out' AND c.name IN ('Прасад', 'Закупка готового Прасада') THEN 'prasad'$s$,
    $s$WHEN c.direction::text = 'out' AND a.department_id IN (SELECT fd.id FROM fin_departments fd WHERE fd.name = 'Кухня') THEN 'prasad'$s$);
  IF v_new = v_def THEN
    RAISE EXCEPTION '594: fin_get_report_drilldown — условие не найдено';
  END IF;
  EXECUTE v_new;
END
$mig$;
