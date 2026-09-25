-- Себестоимость, режим «Ретрит»: шапка «Касса прасада» вместо карточек и вкладки «Ретрит сейчас» (ВГ 25.09)
insert into translations (key, ru, en, hi) values
 ('cost_cash_title', 'Касса прасада — реальные деньги', 'Prasad cash — real money', 'प्रसाद नकद — वास्तविक पैसा'),
 ('cost_cash_in', 'Получено за прасад', 'Received for prasad', 'प्रसाद के लिए प्राप्त'),
 ('cost_cash_in_hint', 'оплаты участников, по Финансам', 'participants'' payments, from Finance', 'प्रतिभागियों के भुगतान, वित्त से'),
 ('cost_cash_out', 'Потрачено из кассы на прасад', 'Spent from cash on prasad', 'प्रसाद पर नकद से खर्च'),
 ('cost_cash_out_hint', 'расходы, отнесённые в Финансах на прасад ретрита', 'expenses assigned to the retreat''s prasad in Finance', 'वित्त में रिट्रीट के प्रसाद पर दर्ज खर्च'),
 ('cost_cash_balance', 'Сальдо', 'Balance', 'शेष'),
 ('cost_cash_balance_hint', 'получено − потрачено', 'received − spent', 'प्राप्त − खर्च'),
 ('cost_result_hint', 'получено − себестоимость ретрита', 'received − retreat cost', 'प्राप्त − रिट्रीट की लागत'),
 ('cost_result_after_prices', 'появится после внесения цен', 'will appear once prices are entered', 'कीमतें दर्ज होने पर दिखेगा'),
 ('cost_expense_ops', 'Расходы прасада ретрита', 'Retreat prasad expenses', 'रिट्रीट प्रसाद के खर्च'),
 ('cost_row_participants', 'Участники', 'Participants', 'प्रतिभागी'),
 ('cost_eaten_today', 'съедено на сегодня', 'eaten to date', 'आज तक खाया गया'),
 ('cost_summary_kicker', 'Себестоимость — расчёт по меню', 'Cost — calculated by menu', 'लागत — मेनू के अनुसार गणना'),
 ('cost_eaters_note_retreat', 'Люди ретрита: участники и приехавшие под ретрит. Постоянная команда и волонтёры — на вкладке «Команда и волонтёры».', 'Retreat people: participants and those who came for the retreat. Permanent team and volunteers are on the «Team and volunteers» tab.', 'रिट्रीट के लोग: प्रतिभागी और रिट्रीट के लिए आए लोग। स्थायी टीम और स्वयंसेवक — «टीम और स्वयंसेवक» टैब पर।'),
 ('cost_summary_note_retreat', 'Ретрит целиком, включая дни раннего заезда и позднего выезда его участников, до конца — по броням. «На участника» — вся стоимость ретрита на одного участника без постоянной команды и волонтёров (они — на вкладке «Команда и волонтёры»).', 'The whole retreat, including early arrival and late departure days of its participants, up to the end — by bookings. «Per participant» — the whole retreat cost per participant without the permanent team and volunteers (they are on the «Team and volunteers» tab).', 'पूरा रिट्रीट, प्रतिभागियों के जल्दी आने और देर से जाने के दिनों सहित, अंत तक — बुकिंग के अनुसार। «प्रति प्रतिभागी» — स्थायी टीम और स्वयंसेवकों के बिना एक प्रतिभागी पर पूरे रिट्रीट की लागत (वे «टीम और स्वयंसेवक» टैब पर हैं)।')
on conflict (key) do update set ru = excluded.ru, en = excluded.en, hi = excluded.hi;
