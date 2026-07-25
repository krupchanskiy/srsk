-- Гостевой портал мог показать чужие деньги.
--
-- portal_fin_get_my_finances определял «кто я» так:
--   SELECT id FROM vaishnavas WHERE user_id = auth.uid() LIMIT 1
-- без сортировки. А один вход делят несколько карточек вайшнавов: таких
-- входов 17, один делят 93 человека (групповая бронь).
--
-- Сегодня утечка скрытая: ни на одном общем входе нет двух человек с
-- финансовыми данными по одному ретриту. Но после загрузки авансов 1 августа
-- их станет четыре пары (проверено симуляцией на живых данных):
--   Гаури прия дд | Лалита лила дд          (gintare.gudeliene@…)
--   Ангелина Трунина | Ольга Библис          (oljabiblis@…)
--   Аруна Гауранга Дас | Георгета Фолештян   (artiom.foleshteanu@…)
--   Адхиягья дас | Анастасия Еронина         (govinda108s@…)
-- Ни одна пара НЕ связана через family_links, то есть по правилам самой
-- системы видеть финансы друг друга им нельзя. При этом какой именно человек
-- показывался бы — решал случай, и выбор мог меняться между открытиями страницы.
--
-- Решение: при неоднозначном входе возвращаем shared_account=true и пустой
-- список. Портал показывает объяснение (ключ portal_fin_shared_account).
-- Показать чужой баланс хуже, чем не показать никакого. Настоящее лечение —
-- отдельный вход каждому человеку; до этого портал честно молчит.
--
-- Полное тело функции — в базе; здесь зафиксирована суть правки:
--   добавлен блок перед разрешением v_viewer
--     SELECT count(*) INTO v_count FROM vaishnavas WHERE user_id = auth.uid();
--     IF v_count > 1 THEN RETURN jsonb_build_object('ok', true,
--       'shared_account', true, 'result', '[]'::jsonb); END IF;
--   и снят LIMIT 1 с последующего SELECT id INTO v_viewer.
-- Актуальное определение: SELECT pg_get_functiondef('portal_fin_get_my_finances()'::regprocedure);

-- Мёртвый код с той же ловушкой: нигде не использовался, но если взять его
-- за основу — получишь ту же неоднозначность.
DROP FUNCTION IF EXISTS fin_actor_contact_id();

-- Сторож: сколько общих входов мешают людям видеть свои финансы.
-- Добавлен в fin_run_integrity_checks как shared_login_blocks_portal:
--   SELECT count(*) FROM (SELECT v.user_id FROM vaishnavas v
--     WHERE v.user_id IS NOT NULL GROUP BY v.user_id
--     HAVING count(*) > 1 AND bool_or(
--       EXISTS (SELECT 1 FROM fin_charges c WHERE c.participant_id = v.id)
--    OR EXISTS (SELECT 1 FROM fin_participant_opening_balances ob WHERE ob.participant_id = v.id)
--    OR EXISTS (SELECT 1 FROM fin_postings p WHERE p.participant_id = v.id))) x
-- Проверок стало 15.

-- Перевод пояснения для портала
INSERT INTO translations (key, ru, en, hi, page)
VALUES ('portal_fin_shared_account',
        'Этим входом пользуются несколько человек, поэтому финансы не показываем — иначе можно увидеть чужой баланс. Напишите организаторам, чтобы вам сделали отдельный вход.',
        'This login is shared by several people, so we cannot show finances — you might see someone else''s balance. Please ask the organisers for your own login.',
        'यह लॉगिन कई लोग साझा करते हैं, इसलिए वित्तीय जानकारी नहीं दिखाई जा रही — आपको किसी और का बैलेंस दिख सकता है। अपने लिए अलग लॉगिन के लिए आयोजकों से संपर्क करें।',
        'guest-portal/index.html')
ON CONFLICT (key) DO UPDATE SET ru=EXCLUDED.ru, en=EXCLUDED.en, hi=EXCLUDED.hi;
