-- «Действует за держателя» (просьба ВГ 24.09.2026): в «Кафе» Антон и Джамбала Малика — одно целое,
-- всё пишется на Джамбалу Малику, даже если сообщение пишет или подтверждает Антон.
CREATE TABLE public.fin_holder_proxies (
  id                  uuid primary key default gen_random_uuid(),
  department_id       uuid not null references public.fin_departments(id),
  proxy_vaishnava_id  uuid not null references public.vaishnavas(id),
  holder_vaishnava_id uuid not null references public.vaishnavas(id),
  created_at          timestamptz not null default now(),
  unique (department_id, proxy_vaishnava_id)
);
ALTER TABLE public.fin_holder_proxies ENABLE ROW LEVEL SECURITY;
CREATE POLICY fin_holder_proxies_admin_all ON public.fin_holder_proxies
  FOR ALL TO authenticated USING (fin_is_admin(auth.uid())) WITH CHECK (fin_is_admin(auth.uid()));

-- Кого считать держателем: сам держатель (активный) либо тот, кто действует за активного держателя
CREATE OR REPLACE FUNCTION public.fin_effective_holder(p_department uuid, p_person uuid)
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(
    (SELECT fh.vaishnava_id FROM fin_holder_proxies px
       JOIN fin_department_holders fh ON fh.department_id = px.department_id
                                     AND fh.vaishnava_id = px.holder_vaishnava_id AND fh.is_active
      WHERE px.department_id = p_department AND px.proxy_vaishnava_id = p_person),
    (SELECT fh.vaishnava_id FROM fin_department_holders fh
      WHERE fh.department_id = p_department AND fh.vaishnava_id = p_person AND fh.is_active));
$function$;
REVOKE ALL ON FUNCTION public.fin_effective_holder(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- Правки четырёх функций точечными заменами (тела функций см. в 466/470/471):
--  tg_post_draft: держатель расхода = эффективный держатель автора заявки;
--  tg_create_handoff: отправитель = эффективный держатель;
--  tg_handoff_confirm: за получателя может подтвердить и тот, кто за него действует;
--  tg_match_department_holder: автор исключается как эффективный держатель.
DO $do$
DECLARE
  def text; new text;
BEGIN
  def := pg_get_functiondef('public.tg_post_draft(uuid, jsonb, uuid)'::regprocedure);
  new := replace(def,
    'WHERE department_id = v_d.department_id AND vaishnava_id = v_d.author_vaishnava_id AND is_active;',
    'WHERE department_id = v_d.department_id AND is_active
       AND vaishnava_id = COALESCE(fin_effective_holder(v_d.department_id, v_d.author_vaishnava_id), v_d.author_vaishnava_id);');
  IF new = def THEN RAISE EXCEPTION 'tg_post_draft: замена не сработала'; END IF;
  EXECUTE new;

  def := pg_get_functiondef('public.tg_create_handoff(jsonb)'::regprocedure);
  new := replace(def,
    'IF v_dept IS NULL OR v_sender IS NULL OR v_recipient IS NULL THEN',
    E'v_sender := COALESCE(fin_effective_holder(v_dept, v_sender), v_sender);\n  IF v_dept IS NULL OR v_sender IS NULL OR v_recipient IS NULL THEN');
  IF new = def THEN RAISE EXCEPTION 'tg_create_handoff: замена не сработала'; END IF;
  EXECUTE new;

  def := pg_get_functiondef('public.tg_handoff_confirm(uuid, bigint, boolean)'::regprocedure);
  new := replace(def,
    'SELECT vaishnava_id INTO v_actor FROM tg_user_links WHERE tg_user_id = p_tg_user;',
    E'SELECT vaishnava_id INTO v_actor FROM tg_user_links WHERE tg_user_id = p_tg_user;\n  v_actor := COALESCE(fin_effective_holder(h.department_id, v_actor), v_actor);');
  IF new = def THEN RAISE EXCEPTION 'tg_handoff_confirm: замена не сработала'; END IF;
  EXECUTE new;

  def := pg_get_functiondef('public.tg_match_department_holder(uuid, text, uuid)'::regprocedure);
  new := replace(def,
    $$AND k.id <> COALESCE(p_exclude, '00000000-0000-0000-0000-000000000000')$$,
    $$AND k.id <> COALESCE(fin_effective_holder(p_department, p_exclude), p_exclude, '00000000-0000-0000-0000-000000000000')$$);
  IF new = def THEN RAISE EXCEPTION 'tg_match_department_holder: замена не сработала'; END IF;
  EXECUTE new;
END
$do$;

-- Данные (не миграция, сделано разово): в «Кафе» держатели — Васудева Датта дас, Джамбала Малика дд
-- (ник «Антон»), Диана Полякова; Антон Лещенко действует за Джамбалу; остаток 5 399 ₹ на Васудеве.
