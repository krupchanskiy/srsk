-- 661: пошаговая инструкция «Вставить список» вместо одной строки (ВГ, 09.10.2026).
insert into translations (key, ru, en, hi, page)
select v.key, v.ru, v.en, v.hi, 'timeline'
  from (values
    ('timeline_list_step1', 'Откройте таблицу организатора как есть — ничего не сортируйте и не переставляйте, лишние столбцы не удаляйте.',
                            'Open the organiser''s table as it is — do not sort or rearrange anything, do not delete extra columns.',
                            'आयोजक की तालिका जैसी है वैसी खोलें — कुछ भी क्रमबद्ध या पुनर्व्यवस्थित न करें, अतिरिक्त कॉलम न हटाएँ।'),
    ('timeline_list_step2', 'Выделите всю таблицу вместе со строкой заголовков (мышью или Cmd+A) и скопируйте (Cmd+C).',
                            'Select the whole table including the header row (with the mouse or Cmd+A) and copy (Cmd+C).',
                            'शीर्षक पंक्ति सहित पूरी तालिका चुनें (माउस से या Cmd+A) और कॉपी करें (Cmd+C)।'),
    ('timeline_list_step3', 'Нажмите в поле ниже и вставьте (Cmd+V).',
                            'Click the field below and paste (Cmd+V).',
                            'नीचे वाले फ़ील्ड में क्लिक करें और चिपकाएँ (Cmd+V)।'),
    ('timeline_list_step4', 'Под полем появятся карточки столбцов. У каждой выберите, что в ней: Имя, Номер комнаты, Заезд, Выезд, Дни, Сколько человек, Телефон. Ненужные столбцы — «— не брать —».',
                            'Column cards will appear below the field. For each, choose what it contains: Name, Room number, Check-in, Check-out, Days, How many people, Phone. For unneeded columns choose «— skip —».',
                            'फ़ील्ड के नीचे कॉलम कार्ड दिखेंगे। हर कार्ड में चुनें कि उसमें क्या है: नाम, कमरा नंबर, आगमन, प्रस्थान, दिन, कितने लोग, फ़ोन। अनावश्यक कॉलम के लिए «— न लें —» चुनें।'),
    ('timeline_list_step5', 'Проверьте таблицу внизу: жёлтое «тот же?» — выберите человека из базы или «другой человек»; красный номер — комната не найдена, выберите её сами. Комнату и даты можно поправить у любого.',
                            'Check the table below: yellow «same person?» — choose the person from the database or «another person»; a red room — not found, choose it yourself. Room and dates can be corrected for anyone.',
                            'नीचे तालिका जाँचें: पीला «वही व्यक्ति?» — डेटाबेस से व्यक्ति या «दूसरा व्यक्ति» चुनें; लाल कमरा — नहीं मिला, स्वयं चुनें। किसी का भी कमरा और तिथियाँ ठीक की जा सकती हैं।'),
    ('timeline_list_step6', 'Нажмите «Расставить по номерам», проверьте номера в окне группы и нажмите «Сохранить».',
                            'Click «Place into rooms», check the rooms in the group window and click «Save».',
                            '«कमरों में रखें» दबाएँ, समूह विंडो में कमरे जाँचें और «सहेजें» दबाएँ।'),
    ('timeline_list_room_optional', 'Столбец с номером комнаты не обязателен: без него люди встанут на места, отмеченные в окне группы.',
                            'The room number column is optional: without it people go to the beds selected in the group window.',
                            'कमरा नंबर वाला कॉलम ज़रूरी नहीं: उसके बिना लोग समूह विंडो में चुने गए बिस्तरों पर रखे जाएँगे।')
  ) v(key, ru, en, hi)
 where not exists (select 1 from translations t where t.key = v.key);
