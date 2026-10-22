-- 728: телеграм гостя без карточки — из «Вставить список» (ВГ, 22.10.2026).
-- Телефон и почта уже есть (guest_phone, guest_email); у людей с карточкой — в справочник.
alter table residents add column if not exists guest_telegram text;

-- Шаг 4 инструкции: новые столбцы «Здание / гостиница», «Почта», «Телеграм»
update translations set
 ru = 'Под полем появятся карточки столбцов. У каждой выберите, что в ней: Имя, Здание / гостиница, Номер комнаты, Заезд, Выезд, Дни, Сколько человек, Телефон, Почта, Телеграм. Ненужные столбцы — «— не брать —».',
 en = 'Column cards will appear below the field. For each, choose what it contains: Name, Building / hotel, Room number, Check-in, Check-out, Days, How many people, Phone, Email, Telegram. For unneeded columns choose «— skip —».',
 hi = 'फ़ील्ड के नीचे कॉलम कार्ड दिखेंगे। हर कार्ड में चुनें कि उसमें क्या है: नाम, भवन / होटल, कमरा नंबर, आगमन, प्रस्थान, दिन, कितने लोग, फ़ोन, ईमेल, टेलीग्राम। अनावश्यक कॉलम के लिए «— न लें —» चुनें।'
where key = 'timeline_list_step4';
