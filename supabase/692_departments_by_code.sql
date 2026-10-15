-- 692: функции находят Кухню и Гест-хаус по постоянному коду, а не по названию (ВГ, 10.10.2026).
-- Название департамента теперь правится в Финансах → Справочники, и переименование
-- не должно ломать бота кухни/ресепшена, себестоимость, отчёты и права кухни.
-- Замена механическая: d.name = 'Кухня' ⇔ d.code = 'kitchen' (код проставлен в 691 на
-- тот же департамент), поэтому результат функций не меняется. После замены в функциях
-- не должно остаться ни одного 'Кухня' / 'Гест-хаус' — иначе миграция откатывается.

DO $$
DECLARE
    r record;
    src text;
    fixed text;
    n int := 0;
BEGIN
    FOR r IN
        SELECT p.oid, p.proname FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
         WHERE ns.nspname = 'public' AND p.prosrc ~ '''(Кухня|Гест-хаус)'''
    LOOP
        src := pg_get_functiondef(r.oid);
        fixed := src;
        fixed := replace(fixed, 'd.name = ''Кухня''',      'd.code = ''kitchen''');
        fixed := replace(fixed, 'fd.name = ''Кухня''',     'fd.code = ''kitchen''');
        fixed := replace(fixed, 'd.name = ''Гест-хаус''',  'd.code = ''guesthouse''');
        -- fin_set_posting_destination: сравнивал название департамента счёта
        fixed := replace(fixed, 'o.is_reversed, d.name dept', 'o.is_reversed, d.code dept');
        fixed := replace(fixed, 'v.dept is distinct from ''Кухня''', 'v.dept is distinct from ''kitchen''');
        IF fixed ~ '''(Кухня|Гест-хаус)''' THEN
            RAISE EXCEPTION 'В функции % осталось название департамента — заменить вручную', r.proname;
        END IF;
        IF fixed <> src THEN
            EXECUTE fixed;
            n := n + 1;
        END IF;
    END LOOP;
    RAISE NOTICE 'Переведено на код: % функций', n;
END $$;

-- «Счёт департамента» (kitchen/account.html) — по коду; название тоже принимается,
-- чтобы старая страница в кэше браузера не сломалась до обновления
DO $$
DECLARE src text;
BEGIN
    src := pg_get_functiondef('public.fin_department_accounts(text)'::regprocedure);
    src := replace(src, 'where d.name = p_department;', 'where d.code = p_department or d.name = p_department;');
    IF src !~ 'd.code = p_department' THEN
        RAISE EXCEPTION 'fin_department_accounts: не найдено место замены';
    END IF;
    EXECUTE src;
END $$;
