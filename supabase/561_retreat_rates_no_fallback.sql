-- 561: курс ретрита в карточке участника — без подмены общим курсом для
-- событий новой системы (фаза 2).
--
-- Карточка Лила-киртана 2027 показывала «Курс ретрита: 1 € = 108 ₹ …» —
-- это общие курсы из справочника (object_id is null), а смена валюты расчёта
-- падала с retreat_rate_missing: fin_private_retreat_rate требует курс,
-- заведённый на событие (ВГ, 27.09). Теперь общий курс подставляется только
-- для старой системы (Сева-ретрит) и событий без объекта учёта; у событий
-- новой системы — только собственный курс, иначе пусто и карточка просит
-- его завести.

create or replace function public.fin_get_retreat_rates(p_retreat uuid)
 returns table(currency_code text, rate numeric)
 language sql
 stable security definer
 set search_path to 'public'
as $function$
    select distinct on (r.from_currency) r.from_currency::text, r.rate
      from fin_exchange_rates r
      left join fin_accounting_objects o on o.id = r.object_id
     where o.retreat_id = p_retreat
        or (r.object_id is null
            and not exists (select 1 from fin_accounting_objects e
                             where e.retreat_id = p_retreat and not e.legacy_inr_settlement))
     order by r.from_currency, (o.retreat_id = p_retreat) desc nulls last, r.effective_date desc;
$function$;

insert into translations (key, ru, en, hi) values
  ('fin_retreat_rate_missing',
   'Курс ретрита не заведён — Финансы → Справочники → Курсы валют, с привязкой к событию',
   'Retreat rate is not set — Finance → Dictionaries → Exchange rates, linked to the event',
   'रिट्रीट दर सेट नहीं है — वित्त → संदर्भ → विनिमय दरें, कार्यक्रम से जोड़ें')
on conflict (key) do nothing;
