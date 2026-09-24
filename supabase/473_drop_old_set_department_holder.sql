-- 470 добавил в fin_set_department_holder четвёртый параметр (ник) через CREATE OR REPLACE,
-- и старая версия на 3 аргумента осталась рядом: вызов с 3 аргументами стал неоднозначным.
DROP FUNCTION IF EXISTS public.fin_set_department_holder(uuid, uuid, boolean);
