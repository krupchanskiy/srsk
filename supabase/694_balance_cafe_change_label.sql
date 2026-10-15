-- 694: /баланс в чате Кафе — деньги без держателя называются «выдано на сдачу» (ВГ, 15.10.2026).
-- У Кафе остаток без держателя — это сдача в кассе 2 этажа (693), а не «не привязано»:
-- так их и называют Нитья и кассир. У остальных департаментов надпись прежняя.
-- Кафе по названию, как в 693; после 691 — перевести на code = 'cafe'.

DO $do$
DECLARE def text; new text;
BEGIN
  def := pg_get_functiondef('public.tg_department_balance(bigint)'::regprocedure);
  new := replace(def, $$'не привязано') AS label$$,
    $$CASE WHEN d.name = 'Кафе' THEN 'выдано на сдачу' ELSE 'не привязано' END) AS label$$);
  IF new = def THEN RAISE EXCEPTION 'tg_department_balance: замена не сработала'; END IF;
  EXECUTE new;
END
$do$;
