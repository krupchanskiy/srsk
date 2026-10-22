-- 736: имя наёмного рабочего — точно как в листе проходной (ВГ, 22.10.2026):
-- «KALLO», «RAM DEKLI», а не «Kallo», чтобы не было разночтений с листом стройки.
-- Сравнение при поиске рабочего и так без учёта регистра — меняется только запись.
DO $mig$
DECLARE
  d text := pg_get_functiondef('public.fin_gate_sheet_post(jsonb)'::regprocedure);
  a text := 'values (initcap(lower(btrim(v_r.name))), v_r.department_id,';
  b text := 'values (btrim(v_r.name), v_r.department_id,';
BEGIN
  IF (length(d) - length(replace(d, a, ''))) / length(a) <> 1 THEN
    RAISE EXCEPTION 'fin_gate_sheet_post: замена не нашлась ровно один раз';
  END IF;
  EXECUTE replace(d, a, b);
END
$mig$;
