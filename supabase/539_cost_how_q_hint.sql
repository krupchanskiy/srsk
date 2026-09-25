-- Себестоимость: подсказка у «?» на вкладках — что по нему нужно нажать (ВГ 25.09)
insert into translations (key, ru, en, hi) values
 ('cost_how_q_hint', 'Нажмите, чтобы открыть подсказку: как считается', 'Click to open the hint: how it is calculated', 'संकेत खोलने के लिए क्लिक करें: गणना कैसे होती है')
on conflict (key) do update set ru = excluded.ru, en = excluded.en, hi = excluded.hi;
