-- «План на завтра» кухни: дата в шапке убрана — строкой ниже «Вкушающие ДД.ММ.ГГГГ»,
-- дата повторялась дважды (просьба ВГ 08.10).

CREATE OR REPLACE FUNCTION public.tg_kitchen_plan_text(p_date date, p_detail boolean DEFAULT false)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT '📋 <b>План на завтра</b>' || E'\n'
         || tg_eating_text(p_date, p_detail, true);
$function$;
