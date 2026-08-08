-- AB Kitchen: локальное скрытие общих продуктов.
--
-- products остаётся общим справочником двух кухонь. Поэтому физическое удаление
-- продукта из AB Kitchen небезопасно: оно либо ломает recipe_ingredients, либо
-- удаляет данные, которыми пользуется основной BackOffice. Эта таблица хранит
-- только видимость продукта для конкретной кухни и никак не меняет общий продукт.

CREATE TABLE IF NOT EXISTS public.ab_kitchen_hidden_products (
    location_id UUID NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
    product_id UUID NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
    hidden_by UUID DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (location_id, product_id)
);

CREATE INDEX IF NOT EXISTS idx_ab_kitchen_hidden_products_product
    ON public.ab_kitchen_hidden_products(product_id);

ALTER TABLE public.ab_kitchen_hidden_products ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "AB Kitchen users read hidden products" ON public.ab_kitchen_hidden_products;
CREATE POLICY "AB Kitchen users read hidden products"
    ON public.ab_kitchen_hidden_products FOR SELECT TO authenticated
    USING (
        public.abk_current_user_can_access_location(location_id)
        AND EXISTS (
            SELECT 1 FROM public.locations l
            WHERE l.id = location_id AND l.slug = 'ab-kitchen'
        )
    );

DROP POLICY IF EXISTS "AB Kitchen editors manage hidden products" ON public.ab_kitchen_hidden_products;
CREATE POLICY "AB Kitchen editors manage hidden products"
    ON public.ab_kitchen_hidden_products FOR ALL TO authenticated
    USING (
        public.abk_current_user_has_permission('edit_products')
        AND public.abk_current_user_can_access_location(location_id)
        AND EXISTS (
            SELECT 1 FROM public.locations l
            WHERE l.id = location_id AND l.slug = 'ab-kitchen'
        )
    )
    WITH CHECK (
        public.abk_current_user_has_permission('edit_products')
        AND public.abk_current_user_can_access_location(location_id)
        AND EXISTS (
            SELECT 1 FROM public.locations l
            WHERE l.id = location_id AND l.slug = 'ab-kitchen'
        )
    );

GRANT SELECT, INSERT, UPDATE, DELETE ON public.ab_kitchen_hidden_products TO authenticated;

COMMENT ON TABLE public.ab_kitchen_hidden_products IS
    'Продукты, скрытые только в интерфейсе конкретной кухни; общий справочник products не изменяется';
