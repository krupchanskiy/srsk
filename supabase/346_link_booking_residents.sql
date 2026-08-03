-- Связка заглушек размещения с людьми из сделок CRM.
--
-- Бронирование из сделки писало в residents пустую заглушку: ни vaishnava_id,
-- ни retreat_id — хотя сделка знает обоих. Отсюда двойной счёт питания (бронь
-- и регистрация одного человека не дедуплицировались), неработающая проверка
-- долга при выезде и ложные «без места» в сводках. Разобрано с Адрианом
-- 03.08.2026: план «Единый путь гостя».
--
-- Правило: на бронь — один «главный» гость из сделки (первое место по дате
-- заезда), остальные места остаются безымянными спутниками (это норма: имена
-- могут появиться в последний момент или не появиться вовсе). Ретрит сделки
-- проставляется всем местам брони. arrived_at не трогаем: связанные брони
-- остаются ожидаемыми, пока ресепшен не нажмёт «Заселить».
--
-- Проверено перед применением: 73 брони (72 человека — у Ишвари Радхи д.д.
-- две сделки на разные ретриты, даты не пересекаются), дифф eating_counts
-- на 60 дней вперёд — ноль.

-- Главное место брони: человек из сделки
with главные as (
  select distinct on (r.booking_id)
         r.id, d.vaishnava_id, d.retreat_id
    from residents r
    join crm_deals d on d.booking_id = r.booking_id and d.status not in ('cancelled')
   where r.vaishnava_id is null
     -- если человек сделки уже сидит на другом месте этой брони — не дублируем
     and not exists (select 1 from residents r2
                      where r2.booking_id = r.booking_id
                        and r2.vaishnava_id = d.vaishnava_id)
   order by r.booking_id, r.check_in, r.id
)
update residents r
   set vaishnava_id = g.vaishnava_id,
       retreat_id   = coalesce(r.retreat_id, g.retreat_id)
  from главные g
 where r.id = g.id;

-- Остальные места тех же броней: только ретрит (спутники едут на тот же ретрит)
update residents r
   set retreat_id = d.retreat_id
  from crm_deals d
 where d.booking_id = r.booking_id
   and d.status not in ('cancelled')
   and d.retreat_id is not null
   and r.retreat_id is null;
