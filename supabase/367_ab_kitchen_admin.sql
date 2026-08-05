-- AB Kitchen: отдельная административная роль, доступ к скрытой локации
-- и серверная изоляция кухонных/складских процессов.

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Явная привязка пользователя к локации
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.user_locations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    location_id UUID NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
    is_default BOOLEAN NOT NULL DEFAULT false,
    is_active BOOLEAN NOT NULL DEFAULT true,
    granted_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.user_locations ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE public.user_locations ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE public.user_locations ADD COLUMN IF NOT EXISTS granted_by UUID REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.user_locations ADD COLUMN IF NOT EXISTS granted_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE public.user_locations ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE UNIQUE INDEX IF NOT EXISTS user_locations_user_location_uidx
    ON public.user_locations(user_id, location_id);
CREATE INDEX IF NOT EXISTS user_locations_user_active_idx
    ON public.user_locations(user_id, is_active);
CREATE INDEX IF NOT EXISTS user_locations_location_active_idx
    ON public.user_locations(location_id, is_active);

ALTER TABLE public.user_locations ENABLE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- 2. Серверные проверки роли, permissions и локации
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.abk_is_superuser(p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT p_user_id IS NOT NULL AND (
        EXISTS (SELECT 1 FROM public.superusers s WHERE s.user_id = p_user_id)
        OR EXISTS (
            SELECT 1
            FROM public.vaishnavas v
            WHERE v.user_id = p_user_id
              AND v.is_superuser = true
              AND v.is_active = true
              AND v.is_deleted = false
        )
    );
$$;

CREATE OR REPLACE FUNCTION public.abk_current_user_has_permission(p_permission_code TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_override BOOLEAN;
BEGIN
    IF v_user_id IS NULL THEN
        RETURN false;
    END IF;

    IF public.abk_is_superuser(v_user_id) THEN
        RETURN true;
    END IF;

    SELECT up.is_granted
      INTO v_override
      FROM public.user_permissions up
      JOIN public.permissions p ON p.id = up.permission_id
     WHERE up.user_id = v_user_id
       AND p.code = p_permission_code
     ORDER BY up.created_at DESC
     LIMIT 1;

    IF FOUND THEN
        RETURN v_override;
    END IF;

    RETURN EXISTS (
        SELECT 1
          FROM public.user_roles ur
          JOIN public.role_permissions rp ON rp.role_id = ur.role_id
          JOIN public.permissions p ON p.id = rp.permission_id
         WHERE ur.user_id = v_user_id
           AND ur.is_active = true
           AND p.code = p_permission_code
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.abk_current_user_has_role(p_role_code TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT auth.uid() IS NOT NULL AND EXISTS (
        SELECT 1
          FROM public.user_roles ur
          JOIN public.roles r ON r.id = ur.role_id
         WHERE ur.user_id = auth.uid()
           AND ur.is_active = true
           AND r.code = p_role_code
    );
$$;

CREATE OR REPLACE FUNCTION public.abk_has_general_staff_access(p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT p_user_id IS NOT NULL AND (
        public.abk_is_superuser(p_user_id)
        OR EXISTS (
            SELECT 1
              FROM public.vaishnavas v
             WHERE v.user_id = p_user_id
               AND v.user_type = 'staff'
               AND v.is_active = true
               AND v.is_deleted = false
               AND v.approval_status = 'approved'
        )
        OR EXISTS (
            SELECT 1
              FROM public.user_roles ur
              JOIN public.roles r ON r.id = ur.role_id
             WHERE ur.user_id = p_user_id
               AND ur.is_active = true
               AND r.code NOT IN ('guest', 'ab_kitchen_admin')
        )
    );
$$;

CREATE OR REPLACE FUNCTION public.has_ab_kitchen_access()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT auth.uid() IS NOT NULL AND (
        public.abk_is_superuser(auth.uid())
        OR (
            EXISTS (
                SELECT 1
                  FROM public.vaishnavas v
                 WHERE v.user_id = auth.uid()
                   AND v.is_active = true
                   AND v.is_deleted = false
                   AND v.approval_status = 'approved'
            )
            AND public.abk_current_user_has_role('ab_kitchen_admin')
            AND EXISTS (
                SELECT 1
                  FROM public.user_locations ul
                  JOIN public.locations l ON l.id = ul.location_id
                 WHERE ul.user_id = auth.uid()
                   AND ul.is_active = true
                   AND l.slug = 'ab-kitchen'
            )
        )
    );
$$;

CREATE OR REPLACE FUNCTION public.has_main_backoffice_access()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT public.abk_has_general_staff_access(auth.uid());
$$;

CREATE OR REPLACE FUNCTION public.abk_current_user_can_access_location(p_location_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_slug TEXT;
BEGIN
    IF v_user_id IS NULL OR p_location_id IS NULL THEN
        RETURN false;
    END IF;

    IF public.abk_is_superuser(v_user_id) THEN
        RETURN true;
    END IF;

    SELECT l.slug INTO v_slug
      FROM public.locations l
     WHERE l.id = p_location_id;

    IF v_slug IS NULL THEN
        RETURN false;
    END IF;

    IF v_slug = 'ab-kitchen' THEN
        RETURN public.has_ab_kitchen_access();
    END IF;

    -- Пользователь только с ролью AB Kitchen не получает доступ к основной кухне.
    RETURN public.abk_has_general_staff_access(v_user_id);
END;
$$;

REVOKE ALL ON FUNCTION public.abk_is_superuser(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.abk_current_user_has_permission(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.abk_current_user_has_role(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.abk_has_general_staff_access(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.has_ab_kitchen_access() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.has_main_backoffice_access() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.abk_current_user_can_access_location(UUID) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.abk_is_superuser(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.abk_current_user_has_permission(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.abk_current_user_has_role(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.abk_has_general_staff_access(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.has_ab_kitchen_access() TO authenticated;
GRANT EXECUTE ON FUNCTION public.has_main_backoffice_access() TO authenticated;
GRANT EXECUTE ON FUNCTION public.abk_current_user_can_access_location(UUID) TO authenticated;

DROP POLICY IF EXISTS "Users read own locations" ON public.user_locations;
DROP POLICY IF EXISTS "Superusers manage user locations" ON public.user_locations;
CREATE POLICY "Users read own locations"
    ON public.user_locations FOR SELECT TO authenticated
    USING (user_id = (SELECT auth.uid()) OR public.abk_is_superuser((SELECT auth.uid())));
CREATE POLICY "Superusers manage user locations"
    ON public.user_locations FOR ALL TO authenticated
    USING (public.abk_is_superuser((SELECT auth.uid())))
    WITH CHECK (public.abk_is_superuser((SELECT auth.uid())));

-- -----------------------------------------------------------------------------
-- 3. Отдельная роль администратора AB Kitchen и два первых администратора
-- -----------------------------------------------------------------------------

INSERT INTO public.roles (
    module_id, code, name_ru, name_en, name_hi,
    description_ru, description_en, color, is_system, sort_order
)
SELECT
    m.id,
    'ab_kitchen_admin',
    'Администратор AB Kitchen',
    'AB Kitchen Administrator',
    'AB Kitchen व्यवस्थापक',
    'Полный доступ только к изолированной кухне AB Kitchen',
    'Full access to the isolated AB Kitchen location only',
    '#f59e0b',
    true,
    65
FROM public.modules m
WHERE m.code = 'kitchen'
ON CONFLICT (code) DO UPDATE SET
    module_id = EXCLUDED.module_id,
    name_ru = EXCLUDED.name_ru,
    name_en = EXCLUDED.name_en,
    name_hi = EXCLUDED.name_hi,
    description_ru = EXCLUDED.description_ru,
    description_en = EXCLUDED.description_en,
    color = EXCLUDED.color,
    is_system = EXCLUDED.is_system,
    sort_order = EXCLUDED.sort_order;

DELETE FROM public.role_permissions rp
USING public.roles r, public.permissions p
WHERE rp.role_id = r.id
  AND rp.permission_id = p.id
  AND r.code = 'ab_kitchen_admin'
  AND p.code NOT IN (
    'view_menu', 'edit_menu',
    'view_menu_templates', 'edit_menu_templates',
    'view_recipes', 'create_recipe', 'edit_recipe', 'delete_recipe',
    'view_products', 'edit_products',
    'view_kitchen_dictionaries', 'edit_kitchen_dictionaries',
    'view_stock',
    'view_requests', 'create_request', 'edit_request', 'delete_request',
    'receive_stock', 'issue_stock', 'conduct_inventory',
    'view_stock_settings', 'edit_stock_settings',
    'view_vaishnavas'
  );

INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM public.roles r
 CROSS JOIN public.permissions p
 WHERE r.code = 'ab_kitchen_admin'
   AND p.code IN (
    'view_menu', 'edit_menu',
    'view_menu_templates', 'edit_menu_templates',
    'view_recipes', 'create_recipe', 'edit_recipe', 'delete_recipe',
    'view_products', 'edit_products',
    'view_kitchen_dictionaries', 'edit_kitchen_dictionaries',
    'view_stock',
    'view_requests', 'create_request', 'edit_request', 'delete_request',
    'receive_stock', 'issue_stock', 'conduct_inventory',
    'view_stock_settings', 'edit_stock_settings',
    'view_vaishnavas'
   )
ON CONFLICT (role_id, permission_id) DO NOTHING;

INSERT INTO public.user_roles (user_id, role_id, is_active, assigned_at)
SELECT v.user_id, r.id, true, now()
  FROM public.vaishnavas v
 CROSS JOIN public.roles r
 WHERE lower(v.email) IN ('sasha.kostromin.200@gmail.com', 'a.caytanya@gmail.com')
   AND v.user_id IS NOT NULL
   AND r.code = 'ab_kitchen_admin'
ON CONFLICT (user_id, role_id) DO UPDATE SET
    is_active = true,
    assigned_at = now();

INSERT INTO public.user_locations (user_id, location_id, is_default, is_active, granted_at)
SELECT v.user_id, l.id, true, true, now()
  FROM public.vaishnavas v
 CROSS JOIN public.locations l
 WHERE lower(v.email) IN ('sasha.kostromin.200@gmail.com', 'a.caytanya@gmail.com')
   AND v.user_id IS NOT NULL
   AND l.slug = 'ab-kitchen'
ON CONFLICT (user_id, location_id) DO UPDATE SET
    is_default = true,
    is_active = true,
    granted_at = now();

-- -----------------------------------------------------------------------------
-- 4. RLS: location-scoped kitchen and stock tables
-- -----------------------------------------------------------------------------

DO $$
DECLARE
    v_policy RECORD;
BEGIN
    FOR v_policy IN
        SELECT schemaname, tablename, policyname
          FROM pg_policies
         WHERE schemaname = 'public'
           AND tablename = ANY (ARRAY[
             'locations',
             'recipes', 'recipe_ingredients',
             'menu_meals', 'menu_dishes',
             'menu_templates', 'menu_template_meals', 'menu_template_dishes',
             'stock',
             'purchase_requests', 'purchase_request_items',
             'stock_receipts', 'stock_receipt_items',
             'stock_issuances', 'stock_issuance_items',
             'stock_inventories', 'stock_inventory_items',
             'products', 'product_categories', 'recipe_categories',
             'product_densities', 'units', 'buyers'
           ])
    LOOP
        EXECUTE format('DROP POLICY IF EXISTS %I ON %I.%I', v_policy.policyname, v_policy.schemaname, v_policy.tablename);
    END LOOP;
END;
$$;

ALTER TABLE public.locations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Kitchen users read accessible locations"
    ON public.locations FOR SELECT TO authenticated
    USING (public.abk_current_user_can_access_location(id));
CREATE POLICY "Superusers manage locations"
    ON public.locations FOR ALL TO authenticated
    USING (public.abk_is_superuser((SELECT auth.uid())))
    WITH CHECK (public.abk_is_superuser((SELECT auth.uid())));

ALTER TABLE public.recipes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Kitchen users read recipes in location"
    ON public.recipes FOR SELECT TO authenticated
    USING ((
        public.abk_current_user_has_permission('view_recipes')
        OR public.abk_current_user_has_permission('view_menu')
        OR public.abk_current_user_has_permission('view_requests')
        OR public.abk_current_user_has_permission('receive_stock')
        OR public.abk_current_user_has_permission('issue_stock')
    ) AND public.abk_current_user_can_access_location(location_id));
CREATE POLICY "Kitchen users create recipes in location"
    ON public.recipes FOR INSERT TO authenticated
    WITH CHECK (public.abk_current_user_has_permission('create_recipe') AND public.abk_current_user_can_access_location(location_id));
CREATE POLICY "Kitchen users update recipes in location"
    ON public.recipes FOR UPDATE TO authenticated
    USING (public.abk_current_user_has_permission('edit_recipe') AND public.abk_current_user_can_access_location(location_id))
    WITH CHECK (public.abk_current_user_has_permission('edit_recipe') AND public.abk_current_user_can_access_location(location_id));
CREATE POLICY "Kitchen users delete recipes in location"
    ON public.recipes FOR DELETE TO authenticated
    USING (public.abk_current_user_has_permission('delete_recipe') AND public.abk_current_user_can_access_location(location_id));

ALTER TABLE public.recipe_ingredients ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Kitchen users read recipe ingredients in location"
    ON public.recipe_ingredients FOR SELECT TO authenticated
    USING ((
        public.abk_current_user_has_permission('view_recipes')
        OR public.abk_current_user_has_permission('view_menu')
        OR public.abk_current_user_has_permission('view_requests')
        OR public.abk_current_user_has_permission('receive_stock')
        OR public.abk_current_user_has_permission('issue_stock')
    ) AND EXISTS (
        SELECT 1 FROM public.recipes r
         WHERE r.id = recipe_ingredients.recipe_id
           AND public.abk_current_user_can_access_location(r.location_id)
    ));
CREATE POLICY "Kitchen users manage recipe ingredients in location"
    ON public.recipe_ingredients FOR ALL TO authenticated
    USING ((public.abk_current_user_has_permission('edit_recipe') OR public.abk_current_user_has_permission('delete_recipe')) AND EXISTS (
        SELECT 1 FROM public.recipes r
         WHERE r.id = recipe_ingredients.recipe_id
           AND public.abk_current_user_can_access_location(r.location_id)
    ))
    WITH CHECK ((public.abk_current_user_has_permission('create_recipe') OR public.abk_current_user_has_permission('edit_recipe')) AND EXISTS (
        SELECT 1 FROM public.recipes r
         WHERE r.id = recipe_ingredients.recipe_id
           AND public.abk_current_user_can_access_location(r.location_id)
    ));

ALTER TABLE public.menu_meals ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Kitchen users read menu meals in location"
    ON public.menu_meals FOR SELECT TO authenticated
    USING (public.abk_current_user_has_permission('view_menu') AND public.abk_current_user_can_access_location(location_id));
CREATE POLICY "Kitchen users manage menu meals in location"
    ON public.menu_meals FOR ALL TO authenticated
    USING (public.abk_current_user_has_permission('edit_menu') AND public.abk_current_user_can_access_location(location_id))
    WITH CHECK (public.abk_current_user_has_permission('edit_menu') AND public.abk_current_user_can_access_location(location_id));

ALTER TABLE public.menu_dishes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Kitchen users read menu dishes in location"
    ON public.menu_dishes FOR SELECT TO authenticated
    USING (public.abk_current_user_has_permission('view_menu') AND EXISTS (
        SELECT 1 FROM public.menu_meals mm
         WHERE mm.id = menu_dishes.meal_id
           AND public.abk_current_user_can_access_location(mm.location_id)
    ));
CREATE POLICY "Kitchen users manage menu dishes in location"
    ON public.menu_dishes FOR ALL TO authenticated
    USING (public.abk_current_user_has_permission('edit_menu') AND EXISTS (
        SELECT 1 FROM public.menu_meals mm
         WHERE mm.id = menu_dishes.meal_id
           AND public.abk_current_user_can_access_location(mm.location_id)
    ))
    WITH CHECK (public.abk_current_user_has_permission('edit_menu') AND EXISTS (
        SELECT 1 FROM public.menu_meals mm
         WHERE mm.id = menu_dishes.meal_id
           AND public.abk_current_user_can_access_location(mm.location_id)
    ));

ALTER TABLE public.menu_templates ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Kitchen users read menu templates in location"
    ON public.menu_templates FOR SELECT TO authenticated
    USING ((public.abk_current_user_has_permission('view_menu_templates') OR public.abk_current_user_has_permission('view_menu'))
        AND public.abk_current_user_can_access_location(location_id));
CREATE POLICY "Kitchen users manage menu templates in location"
    ON public.menu_templates FOR ALL TO authenticated
    USING (public.abk_current_user_has_permission('edit_menu_templates') AND public.abk_current_user_can_access_location(location_id))
    WITH CHECK (public.abk_current_user_has_permission('edit_menu_templates') AND public.abk_current_user_can_access_location(location_id));

ALTER TABLE public.menu_template_meals ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Kitchen users read template meals in location"
    ON public.menu_template_meals FOR SELECT TO authenticated
    USING ((public.abk_current_user_has_permission('view_menu_templates') OR public.abk_current_user_has_permission('view_menu')) AND EXISTS (
        SELECT 1 FROM public.menu_templates mt
         WHERE mt.id = menu_template_meals.template_id
           AND public.abk_current_user_can_access_location(mt.location_id)
    ));
CREATE POLICY "Kitchen users manage template meals in location"
    ON public.menu_template_meals FOR ALL TO authenticated
    USING (public.abk_current_user_has_permission('edit_menu_templates') AND EXISTS (
        SELECT 1 FROM public.menu_templates mt
         WHERE mt.id = menu_template_meals.template_id
           AND public.abk_current_user_can_access_location(mt.location_id)
    ))
    WITH CHECK (public.abk_current_user_has_permission('edit_menu_templates') AND EXISTS (
        SELECT 1 FROM public.menu_templates mt
         WHERE mt.id = menu_template_meals.template_id
           AND public.abk_current_user_can_access_location(mt.location_id)
    ));

ALTER TABLE public.menu_template_dishes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Kitchen users read template dishes in location"
    ON public.menu_template_dishes FOR SELECT TO authenticated
    USING ((public.abk_current_user_has_permission('view_menu_templates') OR public.abk_current_user_has_permission('view_menu')) AND EXISTS (
        SELECT 1
          FROM public.menu_template_meals mtm
          JOIN public.menu_templates mt ON mt.id = mtm.template_id
         WHERE mtm.id = menu_template_dishes.template_meal_id
           AND public.abk_current_user_can_access_location(mt.location_id)
    ));
CREATE POLICY "Kitchen users manage template dishes in location"
    ON public.menu_template_dishes FOR ALL TO authenticated
    USING (public.abk_current_user_has_permission('edit_menu_templates') AND EXISTS (
        SELECT 1
          FROM public.menu_template_meals mtm
          JOIN public.menu_templates mt ON mt.id = mtm.template_id
         WHERE mtm.id = menu_template_dishes.template_meal_id
           AND public.abk_current_user_can_access_location(mt.location_id)
    ))
    WITH CHECK (public.abk_current_user_has_permission('edit_menu_templates') AND EXISTS (
        SELECT 1
          FROM public.menu_template_meals mtm
          JOIN public.menu_templates mt ON mt.id = mtm.template_id
         WHERE mtm.id = menu_template_dishes.template_meal_id
           AND public.abk_current_user_can_access_location(mt.location_id)
    ));

ALTER TABLE public.stock ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Kitchen users read stock in location"
    ON public.stock FOR SELECT TO authenticated
    USING ((
        public.abk_current_user_has_permission('view_stock')
        OR public.abk_current_user_has_permission('receive_stock')
        OR public.abk_current_user_has_permission('issue_stock')
        OR public.abk_current_user_has_permission('conduct_inventory')
        OR public.abk_current_user_has_permission('view_stock_settings')
    ) AND public.abk_current_user_can_access_location(location_id));
CREATE POLICY "Kitchen users manage stock in location"
    ON public.stock FOR ALL TO authenticated
    USING ((
        public.abk_current_user_has_permission('edit_stock_settings')
        OR public.abk_current_user_has_permission('conduct_inventory')
        OR public.abk_current_user_has_permission('receive_stock')
        OR public.abk_current_user_has_permission('issue_stock')
    ) AND public.abk_current_user_can_access_location(location_id))
    WITH CHECK ((
        public.abk_current_user_has_permission('edit_stock_settings')
        OR public.abk_current_user_has_permission('conduct_inventory')
        OR public.abk_current_user_has_permission('receive_stock')
        OR public.abk_current_user_has_permission('issue_stock')
    ) AND public.abk_current_user_can_access_location(location_id));

ALTER TABLE public.purchase_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Kitchen users read requests in location"
    ON public.purchase_requests FOR SELECT TO authenticated
    USING (public.abk_current_user_has_permission('view_requests') AND public.abk_current_user_can_access_location(location_id));
CREATE POLICY "Kitchen users create requests in location"
    ON public.purchase_requests FOR INSERT TO authenticated
    WITH CHECK (public.abk_current_user_has_permission('create_request') AND public.abk_current_user_can_access_location(location_id));
CREATE POLICY "Kitchen users update requests in location"
    ON public.purchase_requests FOR UPDATE TO authenticated
    USING (public.abk_current_user_has_permission('edit_request') AND public.abk_current_user_can_access_location(location_id))
    WITH CHECK (public.abk_current_user_has_permission('edit_request') AND public.abk_current_user_can_access_location(location_id));
CREATE POLICY "Kitchen users delete requests in location"
    ON public.purchase_requests FOR DELETE TO authenticated
    USING (public.abk_current_user_has_permission('delete_request') AND public.abk_current_user_can_access_location(location_id));

ALTER TABLE public.purchase_request_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Kitchen users read request items in location"
    ON public.purchase_request_items FOR SELECT TO authenticated
    USING (public.abk_current_user_has_permission('view_requests') AND EXISTS (
        SELECT 1 FROM public.purchase_requests pr
         WHERE pr.id = purchase_request_items.request_id
           AND public.abk_current_user_can_access_location(pr.location_id)
    ));
CREATE POLICY "Kitchen users manage request items in location"
    ON public.purchase_request_items FOR ALL TO authenticated
    USING ((public.abk_current_user_has_permission('edit_request') OR public.abk_current_user_has_permission('delete_request')) AND EXISTS (
        SELECT 1 FROM public.purchase_requests pr
         WHERE pr.id = purchase_request_items.request_id
           AND public.abk_current_user_can_access_location(pr.location_id)
    ))
    WITH CHECK ((public.abk_current_user_has_permission('create_request') OR public.abk_current_user_has_permission('edit_request')) AND EXISTS (
        SELECT 1 FROM public.purchase_requests pr
         WHERE pr.id = purchase_request_items.request_id
           AND public.abk_current_user_can_access_location(pr.location_id)
    ));

ALTER TABLE public.stock_receipts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Kitchen users manage receipts in location"
    ON public.stock_receipts FOR ALL TO authenticated
    USING (public.abk_current_user_has_permission('receive_stock') AND public.abk_current_user_can_access_location(location_id))
    WITH CHECK (public.abk_current_user_has_permission('receive_stock') AND public.abk_current_user_can_access_location(location_id));

ALTER TABLE public.stock_receipt_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Kitchen users manage receipt items in location"
    ON public.stock_receipt_items FOR ALL TO authenticated
    USING (public.abk_current_user_has_permission('receive_stock') AND EXISTS (
        SELECT 1 FROM public.stock_receipts sr
         WHERE sr.id = stock_receipt_items.receipt_id
           AND public.abk_current_user_can_access_location(sr.location_id)
    ))
    WITH CHECK (public.abk_current_user_has_permission('receive_stock') AND EXISTS (
        SELECT 1 FROM public.stock_receipts sr
         WHERE sr.id = stock_receipt_items.receipt_id
           AND public.abk_current_user_can_access_location(sr.location_id)
    ));

ALTER TABLE public.stock_issuances ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Kitchen users manage issuances in location"
    ON public.stock_issuances FOR ALL TO authenticated
    USING (public.abk_current_user_has_permission('issue_stock') AND public.abk_current_user_can_access_location(location_id))
    WITH CHECK (public.abk_current_user_has_permission('issue_stock') AND public.abk_current_user_can_access_location(location_id));

ALTER TABLE public.stock_issuance_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Kitchen users manage issuance items in location"
    ON public.stock_issuance_items FOR ALL TO authenticated
    USING (public.abk_current_user_has_permission('issue_stock') AND EXISTS (
        SELECT 1 FROM public.stock_issuances si
         WHERE si.id = stock_issuance_items.issuance_id
           AND public.abk_current_user_can_access_location(si.location_id)
    ))
    WITH CHECK (public.abk_current_user_has_permission('issue_stock') AND EXISTS (
        SELECT 1 FROM public.stock_issuances si
         WHERE si.id = stock_issuance_items.issuance_id
           AND public.abk_current_user_can_access_location(si.location_id)
    ));

ALTER TABLE public.stock_inventories ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Kitchen users manage inventories in location"
    ON public.stock_inventories FOR ALL TO authenticated
    USING (public.abk_current_user_has_permission('conduct_inventory') AND public.abk_current_user_can_access_location(location_id))
    WITH CHECK (public.abk_current_user_has_permission('conduct_inventory') AND public.abk_current_user_can_access_location(location_id));

ALTER TABLE public.stock_inventory_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Kitchen users manage inventory items in location"
    ON public.stock_inventory_items FOR ALL TO authenticated
    USING (public.abk_current_user_has_permission('conduct_inventory') AND EXISTS (
        SELECT 1 FROM public.stock_inventories si
         WHERE si.id = stock_inventory_items.inventory_id
           AND public.abk_current_user_can_access_location(si.location_id)
    ))
    WITH CHECK (public.abk_current_user_has_permission('conduct_inventory') AND EXISTS (
        SELECT 1 FROM public.stock_inventories si
         WHERE si.id = stock_inventory_items.inventory_id
           AND public.abk_current_user_can_access_location(si.location_id)
    ));

-- Общие справочники остаются общими для двух кухонь, но запись теперь проверяет
-- реальные permissions вместо любого признака staff.
ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Kitchen users read products" ON public.products FOR SELECT TO authenticated USING (true);
CREATE POLICY "Kitchen editors manage products" ON public.products FOR ALL TO authenticated
    USING (public.abk_current_user_has_permission('edit_products'))
    WITH CHECK (public.abk_current_user_has_permission('edit_products'));

ALTER TABLE public.product_categories ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Kitchen users read product categories" ON public.product_categories FOR SELECT TO authenticated USING (true);
CREATE POLICY "Kitchen editors manage product categories" ON public.product_categories FOR ALL TO authenticated
    USING (public.abk_current_user_has_permission('edit_kitchen_dictionaries'))
    WITH CHECK (public.abk_current_user_has_permission('edit_kitchen_dictionaries'));

ALTER TABLE public.recipe_categories ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Kitchen users read recipe categories" ON public.recipe_categories FOR SELECT TO authenticated USING (true);
CREATE POLICY "Kitchen editors manage recipe categories" ON public.recipe_categories FOR ALL TO authenticated
    USING (public.abk_current_user_has_permission('edit_kitchen_dictionaries'))
    WITH CHECK (public.abk_current_user_has_permission('edit_kitchen_dictionaries'));

ALTER TABLE public.product_densities ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Kitchen users read product densities" ON public.product_densities FOR SELECT TO authenticated USING (true);
CREATE POLICY "Kitchen editors manage product densities" ON public.product_densities FOR ALL TO authenticated
    USING (public.abk_current_user_has_permission('edit_kitchen_dictionaries'))
    WITH CHECK (public.abk_current_user_has_permission('edit_kitchen_dictionaries'));

ALTER TABLE public.units ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Kitchen users read units" ON public.units FOR SELECT TO authenticated USING (true);
CREATE POLICY "Kitchen editors manage units" ON public.units FOR ALL TO authenticated
    USING (public.abk_current_user_has_permission('edit_kitchen_dictionaries'))
    WITH CHECK (public.abk_current_user_has_permission('edit_kitchen_dictionaries'));

ALTER TABLE public.buyers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Kitchen users read buyers" ON public.buyers FOR SELECT TO authenticated
    USING (
        public.abk_current_user_has_permission('view_requests')
        OR public.abk_current_user_has_permission('receive_stock')
        OR public.abk_current_user_has_permission('edit_stock_settings')
    );
CREATE POLICY "Kitchen editors manage buyers" ON public.buyers FOR ALL TO authenticated
    USING (public.abk_current_user_has_permission('edit_stock_settings'))
    WITH CHECK (public.abk_current_user_has_permission('edit_stock_settings'));

-- Фотографии рецептов привязаны к UUID рецепта в начале имени файла.
-- Запись/удаление разрешены только редактору доступной локации.
DO $$
DECLARE
    v_policy RECORD;
BEGIN
    FOR v_policy IN
        SELECT policyname
          FROM pg_policies
         WHERE schemaname = 'storage'
           AND tablename = 'objects'
           AND (COALESCE(qual, '') LIKE '%recipe-photos%'
                OR COALESCE(with_check, '') LIKE '%recipe-photos%')
    LOOP
        EXECUTE format('DROP POLICY IF EXISTS %I ON storage.objects', v_policy.policyname);
    END LOOP;
END;
$$;

CREATE POLICY "Kitchen editors upload recipe photos"
    ON storage.objects FOR INSERT TO authenticated
    WITH CHECK (
        bucket_id = 'recipe-photos'
        AND name ~ '^[0-9a-fA-F-]{36}_'
        AND public.abk_current_user_has_permission('edit_recipe')
        AND EXISTS (
            SELECT 1 FROM public.recipes r
             WHERE r.id = split_part(name, '_', 1)::UUID
               AND public.abk_current_user_can_access_location(r.location_id)
        )
    );
CREATE POLICY "Kitchen editors update recipe photos"
    ON storage.objects FOR UPDATE TO authenticated
    USING (
        bucket_id = 'recipe-photos'
        AND name ~ '^[0-9a-fA-F-]{36}_'
        AND public.abk_current_user_has_permission('edit_recipe')
        AND EXISTS (
            SELECT 1 FROM public.recipes r
             WHERE r.id = split_part(name, '_', 1)::UUID
               AND public.abk_current_user_can_access_location(r.location_id)
        )
    )
    WITH CHECK (
        bucket_id = 'recipe-photos'
        AND name ~ '^[0-9a-fA-F-]{36}_'
        AND public.abk_current_user_has_permission('edit_recipe')
        AND EXISTS (
            SELECT 1 FROM public.recipes r
             WHERE r.id = split_part(name, '_', 1)::UUID
               AND public.abk_current_user_can_access_location(r.location_id)
        )
    );
CREATE POLICY "Kitchen editors delete recipe photos"
    ON storage.objects FOR DELETE TO authenticated
    USING (
        bucket_id = 'recipe-photos'
        AND name ~ '^[0-9a-fA-F-]{36}_'
        AND public.abk_current_user_has_permission('edit_recipe')
        AND EXISTS (
            SELECT 1 FROM public.recipes r
             WHERE r.id = split_part(name, '_', 1)::UUID
               AND public.abk_current_user_can_access_location(r.location_id)
        )
    );

-- -----------------------------------------------------------------------------
-- 5. SECURITY DEFINER складские RPC обязательно проверяют permission/location
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.save_stock_receipt(
    p_location_id UUID,
    p_date DATE,
    p_buyer_id UUID,
    p_notes TEXT,
    p_items JSONB
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_receipt_id UUID;
    v_item JSONB;
    v_price NUMERIC;
BEGIN
    IF NOT public.abk_current_user_has_permission('receive_stock')
       OR NOT public.abk_current_user_can_access_location(p_location_id) THEN
        RAISE EXCEPTION 'ABK_ACCESS_DENIED' USING ERRCODE = '42501';
    END IF;

    IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' OR jsonb_array_length(p_items) = 0 THEN
        RAISE EXCEPTION 'RECEIPT_ITEMS_REQUIRED' USING ERRCODE = '22023';
    END IF;

    IF EXISTS (
        SELECT 1 FROM jsonb_array_elements(p_items) item
         WHERE COALESCE((item->>'quantity')::NUMERIC, 0) <= 0
            OR NULLIF(item->>'product_id', '') IS NULL
    ) THEN
        RAISE EXCEPTION 'INVALID_RECEIPT_ITEM' USING ERRCODE = '22023';
    END IF;

    INSERT INTO public.stock_receipts (location_id, buyer_id, receipt_date, notes)
    VALUES (p_location_id, p_buyer_id, p_date, p_notes)
    RETURNING id INTO v_receipt_id;

    FOR v_item IN SELECT value FROM jsonb_array_elements(p_items)
    LOOP
        v_price := CASE
            WHEN (v_item->>'quantity')::NUMERIC > 0
            THEN COALESCE((v_item->>'spent')::NUMERIC, 0) / (v_item->>'quantity')::NUMERIC
            ELSE 0
        END;

        INSERT INTO public.stock_receipt_items (receipt_id, product_id, quantity, price)
        VALUES (v_receipt_id, (v_item->>'product_id')::UUID, (v_item->>'quantity')::NUMERIC, NULLIF(v_price, 0));

        INSERT INTO public.stock (location_id, product_id, current_quantity, min_quantity, last_price)
        VALUES (p_location_id, (v_item->>'product_id')::UUID, (v_item->>'quantity')::NUMERIC, 0, NULLIF(v_price, 0))
        ON CONFLICT (location_id, product_id) DO UPDATE SET
            current_quantity = public.stock.current_quantity + EXCLUDED.current_quantity,
            last_price = COALESCE(EXCLUDED.last_price, public.stock.last_price),
            updated_at = now();
    END LOOP;

    RETURN v_receipt_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.save_stock_issuance(
    p_location_id UUID,
    p_date DATE,
    p_receiver_id UUID,
    p_notes TEXT,
    p_items JSONB
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_issuance_id UUID;
    v_item JSONB;
    v_available NUMERIC;
BEGIN
    IF NOT public.abk_current_user_has_permission('issue_stock')
       OR NOT public.abk_current_user_can_access_location(p_location_id) THEN
        RAISE EXCEPTION 'ABK_ACCESS_DENIED' USING ERRCODE = '42501';
    END IF;

    IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' OR jsonb_array_length(p_items) = 0 THEN
        RAISE EXCEPTION 'ISSUANCE_ITEMS_REQUIRED' USING ERRCODE = '22023';
    END IF;

    IF EXISTS (
        SELECT 1 FROM jsonb_array_elements(p_items) item
         WHERE COALESCE((item->>'quantity')::NUMERIC, 0) <= 0
            OR NULLIF(item->>'product_id', '') IS NULL
    ) THEN
        RAISE EXCEPTION 'INVALID_ISSUANCE_ITEM' USING ERRCODE = '22023';
    END IF;

    -- Проверка выполняется на сервере и блокирует соответствующие остатки.
    FOR v_item IN SELECT value FROM jsonb_array_elements(p_items)
    LOOP
        SELECT s.current_quantity
          INTO v_available
          FROM public.stock s
         WHERE s.location_id = p_location_id
           AND s.product_id = (v_item->>'product_id')::UUID
         FOR UPDATE;

        IF v_available IS NULL OR v_available < (v_item->>'quantity')::NUMERIC THEN
            RAISE EXCEPTION 'INSUFFICIENT_STOCK:%', v_item->>'product_id' USING ERRCODE = '22023';
        END IF;
    END LOOP;

    INSERT INTO public.stock_issuances (location_id, issuance_date, receiver_id, notes)
    VALUES (p_location_id, p_date, p_receiver_id, p_notes)
    RETURNING id INTO v_issuance_id;

    FOR v_item IN SELECT value FROM jsonb_array_elements(p_items)
    LOOP
        INSERT INTO public.stock_issuance_items (issuance_id, product_id, quantity)
        VALUES (v_issuance_id, (v_item->>'product_id')::UUID, (v_item->>'quantity')::NUMERIC);

        UPDATE public.stock
           SET current_quantity = current_quantity - (v_item->>'quantity')::NUMERIC,
               updated_at = now()
         WHERE location_id = p_location_id
           AND product_id = (v_item->>'product_id')::UUID;
    END LOOP;

    RETURN v_issuance_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.update_stock_receipt_items(p_receipt_id UUID, p_items JSONB)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_location_id UUID;
    v_delta RECORD;
    v_item JSONB;
    v_price NUMERIC;
    v_available NUMERIC;
BEGIN
    SELECT sr.location_id INTO v_location_id
      FROM public.stock_receipts sr
     WHERE sr.id = p_receipt_id
     FOR UPDATE;

    IF v_location_id IS NULL
       OR NOT public.abk_current_user_has_permission('receive_stock')
       OR NOT public.abk_current_user_can_access_location(v_location_id) THEN
        RAISE EXCEPTION 'ABK_ACCESS_DENIED' USING ERRCODE = '42501';
    END IF;

    IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' THEN
        RAISE EXCEPTION 'INVALID_RECEIPT_ITEMS' USING ERRCODE = '22023';
    END IF;

    IF EXISTS (
        SELECT 1 FROM jsonb_array_elements(p_items) item
         WHERE COALESCE((item->>'quantity')::NUMERIC, 0) <= 0
            OR NULLIF(item->>'product_id', '') IS NULL
    ) THEN
        RAISE EXCEPTION 'INVALID_RECEIPT_ITEM' USING ERRCODE = '22023';
    END IF;

    FOR v_delta IN
        WITH old_items AS (
            SELECT sri.product_id, SUM(sri.quantity) qty
              FROM public.stock_receipt_items sri
             WHERE sri.receipt_id = p_receipt_id
             GROUP BY sri.product_id
        ),
        new_items AS (
            SELECT (item->>'product_id')::UUID product_id,
                   SUM((item->>'quantity')::NUMERIC) qty
              FROM jsonb_array_elements(p_items) item
             GROUP BY (item->>'product_id')::UUID
        )
        SELECT COALESCE(n.product_id, o.product_id) product_id,
               COALESCE(n.qty, 0) - COALESCE(o.qty, 0) qty_delta
          FROM old_items o
          FULL JOIN new_items n ON n.product_id = o.product_id
    LOOP
        SELECT s.current_quantity INTO v_available
          FROM public.stock s
         WHERE s.location_id = v_location_id AND s.product_id = v_delta.product_id
         FOR UPDATE;

        IF COALESCE(v_available, 0) + v_delta.qty_delta < 0 THEN
            RAISE EXCEPTION 'INSUFFICIENT_STOCK_TO_REVISE_RECEIPT:%', v_delta.product_id USING ERRCODE = '22023';
        END IF;

        INSERT INTO public.stock (location_id, product_id, current_quantity, min_quantity)
        VALUES (v_location_id, v_delta.product_id, GREATEST(v_delta.qty_delta, 0), 0)
        ON CONFLICT (location_id, product_id) DO UPDATE SET
            current_quantity = public.stock.current_quantity + v_delta.qty_delta,
            updated_at = now();
    END LOOP;

    DELETE FROM public.stock_receipt_items WHERE receipt_id = p_receipt_id;
    FOR v_item IN SELECT value FROM jsonb_array_elements(p_items)
    LOOP
        v_price := COALESCE((v_item->>'spent')::NUMERIC, 0) / (v_item->>'quantity')::NUMERIC;
        INSERT INTO public.stock_receipt_items (receipt_id, product_id, quantity, price)
        VALUES (p_receipt_id, (v_item->>'product_id')::UUID, (v_item->>'quantity')::NUMERIC, NULLIF(v_price, 0));

        UPDATE public.stock
           SET last_price = COALESCE(NULLIF(v_price, 0), last_price), updated_at = now()
         WHERE location_id = v_location_id
           AND product_id = (v_item->>'product_id')::UUID;
    END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.update_stock_issuance_items(p_issuance_id UUID, p_items JSONB)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_location_id UUID;
    v_delta RECORD;
    v_item JSONB;
    v_available NUMERIC;
BEGIN
    SELECT si.location_id INTO v_location_id
      FROM public.stock_issuances si
     WHERE si.id = p_issuance_id
     FOR UPDATE;

    IF v_location_id IS NULL
       OR NOT public.abk_current_user_has_permission('issue_stock')
       OR NOT public.abk_current_user_can_access_location(v_location_id) THEN
        RAISE EXCEPTION 'ABK_ACCESS_DENIED' USING ERRCODE = '42501';
    END IF;

    IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' THEN
        RAISE EXCEPTION 'INVALID_ISSUANCE_ITEMS' USING ERRCODE = '22023';
    END IF;

    IF EXISTS (
        SELECT 1 FROM jsonb_array_elements(p_items) item
         WHERE COALESCE((item->>'quantity')::NUMERIC, 0) <= 0
            OR NULLIF(item->>'product_id', '') IS NULL
    ) THEN
        RAISE EXCEPTION 'INVALID_ISSUANCE_ITEM' USING ERRCODE = '22023';
    END IF;

    FOR v_delta IN
        WITH old_items AS (
            SELECT sii.product_id, SUM(sii.quantity) qty
              FROM public.stock_issuance_items sii
             WHERE sii.issuance_id = p_issuance_id
             GROUP BY sii.product_id
        ),
        new_items AS (
            SELECT (item->>'product_id')::UUID product_id,
                   SUM((item->>'quantity')::NUMERIC) qty
              FROM jsonb_array_elements(p_items) item
             GROUP BY (item->>'product_id')::UUID
        )
        SELECT COALESCE(n.product_id, o.product_id) product_id,
               COALESCE(n.qty, 0) - COALESCE(o.qty, 0) qty_delta
          FROM old_items o
          FULL JOIN new_items n ON n.product_id = o.product_id
    LOOP
        SELECT s.current_quantity INTO v_available
          FROM public.stock s
         WHERE s.location_id = v_location_id AND s.product_id = v_delta.product_id
         FOR UPDATE;

        IF v_available IS NULL OR v_available - v_delta.qty_delta < 0 THEN
            RAISE EXCEPTION 'INSUFFICIENT_STOCK_TO_REVISE_ISSUANCE:%', v_delta.product_id USING ERRCODE = '22023';
        END IF;

        UPDATE public.stock
           SET current_quantity = current_quantity - v_delta.qty_delta,
               updated_at = now()
         WHERE location_id = v_location_id
           AND product_id = v_delta.product_id;
    END LOOP;

    DELETE FROM public.stock_issuance_items WHERE issuance_id = p_issuance_id;
    FOR v_item IN SELECT value FROM jsonb_array_elements(p_items)
    LOOP
        INSERT INTO public.stock_issuance_items (issuance_id, product_id, quantity)
        VALUES (p_issuance_id, (v_item->>'product_id')::UUID, (v_item->>'quantity')::NUMERIC);
    END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.save_stock_receipt(UUID, DATE, UUID, TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.save_stock_issuance(UUID, DATE, UUID, TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.update_stock_receipt_items(UUID, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.update_stock_issuance_items(UUID, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.save_stock_receipt(UUID, DATE, UUID, TEXT, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.save_stock_issuance(UUID, DATE, UUID, TEXT, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_stock_receipt_items(UUID, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_stock_issuance_items(UUID, JSONB) TO authenticated;

COMMIT;
