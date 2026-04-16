-- Недостающие ключи переводов для модуля Housing

INSERT INTO translations (key, ru, en, hi, context) VALUES
  -- Статусы присутствия (vaishnavas/index.html, team.html)
  ('currently_in_srsk', 'Находится в ШРСК', 'Currently at SRSK', 'वर्तमान में SRSK में', 'Статус присутствия вайшнава'),
  ('coming_for_retreat', 'Приедет на ретрит', 'Coming for retreat', 'रिट्रीट के लिए आ रहे हैं', 'Статус будущего приезда'),
  ('plans_to_come', 'Планирует приехать', 'Plans to come', 'आने की योजना है', 'Статус планируемого приезда'),

  -- Placeholder-ы (vaishnavas/person.html)
  ('placeholder_comment_example', 'Например: Картика', 'E.g.: Kartika', 'उदा.: कार्तिक', 'Placeholder для комментария к проживанию'),
  ('placeholder_org_notes', 'Организационные заметки...', 'Organizational notes...', 'संगठनात्मक नोट्स...', 'Placeholder для заметок ретрита'),

  -- Arrivals / общее
  ('persons_short', 'чел.', 'ppl.', 'लोग', 'Сокращение: человек'),
  ('weekdays_short', 'Вс,Пн,Вт,Ср,Чт,Пт,Сб', 'Sun,Mon,Tue,Wed,Thu,Fri,Sat', 'रवि,सोम,मंगल,बुध,गुरु,शुक्र,शनि', 'Короткие названия дней недели через запятую'),
  ('flight_time', 'Время прилёта', 'Flight time', 'उड़ान का समय', 'Tooltip: время рейса'),
  ('arrives_at_srsk', 'Приедет в ШРСК', 'Arrives at SRSK', 'SRSK पहुँचेंगे', 'Tooltip: время прибытия'),
  ('data_updated', 'Данные обновлены', 'Data updated', 'डेटा अपडेट किया गया', 'Уведомление при обновлении данных в реальном времени'),

  -- Transfers
  ('weekdays_full', 'воскресенье,понедельник,вторник,среда,четверг,пятница,суббота', 'Sunday,Monday,Tuesday,Wednesday,Thursday,Friday,Saturday', 'रविवार,सोमवार,मंगलवार,बुधवार,गुरुवार,शुक्रवार,शनिवार', 'Полные названия дней недели через запятую'),
  ('months_genitive', 'января,февраля,марта,апреля,мая,июня,июля,августа,сентября,октября,ноября,декабря', 'January,February,March,April,May,June,July,August,September,October,November,December', 'जनवरी,फ़रवरी,मार्च,अप्रैल,मई,जून,जुलाई,अगस्त,सितंबर,अक्टूबर,नवंबर,दिसंबर', 'Названия месяцев в родительном падеже через запятую'),
  ('today', 'Сегодня', 'Today', 'आज', 'Метка дня: сегодня'),
  ('tomorrow', 'Завтра', 'Tomorrow', 'कल', 'Метка дня: завтра'),
  ('check_in', 'Заезд', 'Check-in', 'चेक-इन', 'Направление трансфера: заезд'),
  ('check_out', 'Выезд', 'Check-out', 'चेक-आउट', 'Направление трансфера: выезд'),
  ('departure_flight', 'Вылет', 'Departure', 'प्रस्थान', 'Метка: рейс вылета'),
  ('arrival_flight', 'Прилёт', 'Arrival', 'आगमन', 'Метка: рейс прилёта'),
  ('taxi_ordered', 'Такси заказано', 'Taxi ordered', 'टैक्सी बुक की गई', 'Бейдж: такси заказано'),
  ('order_taxi', 'Заказать такси', 'Order taxi', 'टैक्सी बुक करें', 'Кнопка: заказать такси'),
  ('taxi_completed', 'Такси завершено', 'Taxi completed', 'टैक्सी पूरी हुई', 'Уведомление: такси завершено'),
  ('ordered_by', 'Заказал', 'Ordered by', 'बुक किया', 'Подпись: кто заказал такси'),
  ('back_to_deal', 'Вернуться к сделке', 'Back to deal', 'सौदे पर वापस जाएं', 'Кнопка: вернуться к CRM-сделке'),

  -- Fullscreen
  ('normal_view', 'Обычный вид', 'Normal view', 'सामान्य दृश्य', 'Tooltip: выйти из полноэкранного режима'),
  ('fullscreen', 'На весь экран', 'Fullscreen', 'पूर्ण स्क्रीन', 'Tooltip: полноэкранный режим'),

  -- Ошибки
  ('error_saving_taxi', 'Сохранение заказа такси', 'Saving taxi order', 'टैक्सी ऑर्डर सहेजना', 'Контекст ошибки'),
  ('error_updating_taxi', 'Обновление информации о такси', 'Updating taxi info', 'टैक्सी जानकारी अपडेट करना', 'Контекст ошибки'),
  ('error_cancelling_taxi', 'Отмена такси', 'Cancelling taxi', 'टैक्सी रद्द करना', 'Контекст ошибки'),
  ('error_loading_residents', 'Загрузка проживающих', 'Loading residents', 'निवासियों को लोड करना', 'Контекст ошибки'),
  ('error_updating_meal', 'Обновление питания', 'Updating meal', 'भोजन अपडेट करना', 'Контекст ошибки'),
  ('error_updating', 'Обновление', 'Updating', 'अपडेट करना', 'Контекст ошибки'),
  ('error_adding_rooms', 'Массовое добавление комнат', 'Bulk adding rooms', 'कमरे जोड़ना', 'Контекст ошибки'),
  ('error_saving_meal_type', 'Сохранение типа питания', 'Saving meal type', 'भोजन प्रकार सहेजना', 'Контекст ошибки'),
  ('error_saving_transfers', 'Сохранение трансферов', 'Saving transfers', 'ट्रांसफर सहेजना', 'Контекст ошибки'),
  ('error_saving_accommodation', 'Сохранение размещения', 'Saving accommodation', 'आवास सहेजना', 'Контекст ошибки'),
  ('error_creating_guest', 'Создание гостя', 'Creating guest', 'अतिथि बनाना', 'Контекст ошибки')

ON CONFLICT (key) DO UPDATE SET
  ru = EXCLUDED.ru,
  en = EXCLUDED.en,
  hi = EXCLUDED.hi,
  context = EXCLUDED.context;
