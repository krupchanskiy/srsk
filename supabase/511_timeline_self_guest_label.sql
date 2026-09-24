-- Гость без ретрита в шахматке: «Самостоятельный гость» вместо «Вне ретрита» (решение ВГ 24.09.2026)
update translations set ru = 'Самостоятельный гость', en = 'Independent guest', hi = 'स्वतंत्र अतिथि'
 where key = 'timeline_self_guest';
