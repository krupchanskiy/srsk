-- 659b (в журнале базы — 659_group_list_hint; номер 659 занят 659_prepayment_legacy): понятнее подсказка «Вставить список» — копировать всю таблицу сразу, номер комнаты необязателен (ВГ, 09.10.2026).
update translations set
    ru = 'Выделите в Excel или Google-таблице всю таблицу сразу — все столбцы вместе с заголовком, скопируйте (Cmd+C) и вставьте сюда (Cmd+V). Какой столбец что значит, выберете ниже. Столбец с номером комнаты не обязателен: без него люди встанут на места, отмеченные в окне группы.',
    en = 'Select the whole table in Excel or Google Sheets — all columns with the header, copy (Cmd+C) and paste here (Cmd+V). You will choose what each column means below. The room number column is optional: without it people go to the beds selected in the group window.',
    hi = 'Excel या Google शीट में पूरी तालिका एक साथ चुनें — शीर्षक सहित सभी कॉलम, कॉपी करें (Cmd+C) और यहाँ चिपकाएँ (Cmd+V)। हर कॉलम का अर्थ नीचे चुनें। कमरा नंबर वाला कॉलम ज़रूरी नहीं: उसके बिना लोग समूह विंडो में चुने गए बिस्तरों पर रखे जाएँगे।'
 where key = 'timeline_list_hint';
