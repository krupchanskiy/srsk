-- Непокрытые ночи: бронь не покрывает даты рейсов гостя.
--
-- Даты рейсов живут в чеклисте сделки и до сих пор работали только на трансфер.
-- Бронь при создании из сделки бралась по датам ретрита, поэтому гость, прилетающий
-- за четыре дня до начала, оказывался без места именно в эти дни — и узнавали об этом
-- на ресепшене в день заезда.
--
-- Витрина считает обе стороны: сколько ночей не покрыто до заезда и после выезда.
-- Даты рейсов — TIMESTAMPTZ, введённые как местное время, поэтому берём их
-- в UTC (at time zone 'UTC') — так же, как их показывает карточка сделки.

create or replace view v_placement_uncovered as
select
    d.id                                        as deal_id,
    d.retreat_id,
    r.name_ru                                   as retreat_name,
    r.start_date                                as retreat_start,
    r.end_date                                  as retreat_end,
    d.vaishnava_id,
    coalesce(
        v.spiritual_name,
        nullif(trim(coalesce(v.first_name, '') || ' ' || coalesce(v.last_name, '')), ''),
        b.contact_name
    )                                           as guest_name,
    (d.arrival_datetime   at time zone 'UTC')::date as arrival_date,
    (d.departure_datetime at time zone 'UTC')::date as departure_date,
    b.id                                        as booking_id,
    b.check_in,
    b.check_out,
    greatest(0, b.check_in - (d.arrival_datetime at time zone 'UTC')::date)   as nights_before,
    greatest(0, (d.departure_datetime at time zone 'UTC')::date - b.check_out) as nights_after
from crm_deals d
join bookings  b on b.id = d.booking_id
left join retreats   r on r.id = d.retreat_id
left join vaishnavas v on v.id = d.vaishnava_id
where d.status <> 'cancelled'
  and b.status <> 'cancelled'
  and (
        (d.arrival_datetime   is not null and (d.arrival_datetime   at time zone 'UTC')::date < b.check_in)
     or (d.departure_datetime is not null and (d.departure_datetime at time zone 'UTC')::date > b.check_out)
      );

grant select on v_placement_uncovered to authenticated;
