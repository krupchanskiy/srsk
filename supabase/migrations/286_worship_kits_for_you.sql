-- 286: «Вам выдали» → «Подборки для вас»: блок на главной только про подборки.
update translations set ru = 'Подборки для вас', en = 'Collections for you', hi = 'आपके लिए संग्रह'
 where key = 'worship_given_to_me';
