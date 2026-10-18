-- «Старший уехал» должно быть видно там, где его ждут: в очереди на утверждение
-- и в шахматке. Иначе правка висит, расписание стоит, и никто не понимает почему.
create or replace function worship_approvers_away()
returns jsonb language sql stable security definer set search_path to 'public', 'pg_temp' as $$
    select coalesce(jsonb_agg(jsonb_build_object(
               'имя', coalesce(v.spiritual_name,
                       btrim(coalesce(v.first_name, '') || ' ' || coalesce(v.last_name, ''))),
               'по', a.date_to)
           order by a.date_from), '[]'::jsonb)
      from worship_absences a
      join worship_people p on p.id = a.person_id
      join vaishnavas v on v.id = p.vaishnava_id
     where v.user_id in (select worship_holders('worship_approve'))
       and current_date between a.date_from and coalesce(a.date_to, 'infinity'::date)
$$;

revoke all on function worship_approvers_away() from public, anon;
grant execute on function worship_approvers_away() to authenticated;
