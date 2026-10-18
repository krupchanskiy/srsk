-- 705: переводы раздела «Департаменты» и списка «Кто видит департамент» (ВГ 18.10)
insert into translations (key, ru, en, hi, context) values
('module_departments', 'Департаменты', 'Departments', 'विभाग', 'Модуль «Департаменты»'),
('nav_departments', 'Департаменты', 'Departments', 'विभाग', 'Модуль «Департаменты»: меню'),
('dept_list_subtitle', 'Выберите департамент', 'Choose a department', 'विभाग चुनें', 'Департаменты: плитки'),
('dept_none', 'Вам пока не открыт ни один департамент', 'No departments are open to you yet', 'अभी तक आपके लिए कोई विभाग खुला नहीं है', 'Департаменты: плитки'),
('dept_no_head', 'Глава не назначен', 'No head assigned', 'कोई प्रमुख नियुक्त नहीं', 'Департаменты: плитки'),
('dept_open_module', 'Открыть модуль', 'Open module', 'मॉड्यूल खोलें', 'Департамент: ссылка на рабочий модуль'),
('fin_dept_viewers', 'Кто ещё видит департамент', 'Who else can see the department', 'विभाग और कौन देख सकता है', 'Справочники → Департаменты'),
('fin_dept_viewers_add', 'Добавить человека…', 'Add a person…', 'व्यक्ति जोड़ें…', 'Справочники → Департаменты'),
('fin_dept_viewers_hint', 'Видят всё, что глава: страницу департамента в разделе «Департаменты». Только люди со входом в систему.', 'They see everything the head sees: the department page in the Departments section. Only people with a login.', 'वे वह सब देखते हैं जो प्रमुख देखता है: «विभाग» अनुभाग में विभाग का पृष्ठ। केवल लॉगिन वाले लोग।', 'Справочники → Департаменты'),
('fin_dept_viewers_also', 'также видят', 'also see', 'यह भी देखते हैं', 'Справочники → Департаменты: таблица')
on conflict (key) do update set ru = excluded.ru, en = excluded.en, hi = excluded.hi, context = excluded.context;

update translations
   set ru = 'Департамент видят его глава, люди из списка «Кто видит» и финансисты',
       en = 'The department is visible to its head, people on its viewers list and finance staff',
       hi = 'विभाग को उसका प्रमुख, दर्शकों की सूची के लोग और वित्त कर्मचारी देख सकते हैं'
 where key = 'dacc_no_access';
