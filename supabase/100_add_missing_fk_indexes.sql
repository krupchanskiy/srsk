-- ================================================
-- Миграция: Добавление индексов на FK без индексов
-- Улучшает производительность JOIN и каскадных операций
-- ================================================

-- guest_notes
CREATE INDEX IF NOT EXISTS idx_guest_notes_created_by ON guest_notes(created_by);

-- menu_items
CREATE INDEX IF NOT EXISTS idx_menu_items_menu_day_id ON menu_items(menu_day_id);
CREATE INDEX IF NOT EXISTS idx_menu_items_recipe_id ON menu_items(recipe_id);

-- menu_meals
CREATE INDEX IF NOT EXISTS idx_menu_meals_cook_id ON menu_meals(cook_id);

-- menu_template_dishes
CREATE INDEX IF NOT EXISTS idx_menu_template_dishes_recipe_id ON menu_template_dishes(recipe_id);

-- price_history
CREATE INDEX IF NOT EXISTS idx_price_history_location ON price_history(location_id);

-- purchase_request_items
CREATE INDEX IF NOT EXISTS idx_purchase_request_items_product_id ON purchase_request_items(product_id);
CREATE INDEX IF NOT EXISTS idx_purchase_request_items_request_id ON purchase_request_items(request_id);

-- purchase_requests
CREATE INDEX IF NOT EXISTS idx_purchase_requests_buyer_id ON purchase_requests(buyer_id);

-- recipe_ingredients
CREATE INDEX IF NOT EXISTS idx_recipe_ingredients_product ON recipe_ingredients(product_id);

-- residents
CREATE INDEX IF NOT EXISTS idx_residents_vaishnava ON residents(vaishnava_id);

-- retreats
CREATE INDEX IF NOT EXISTS idx_retreats_location ON retreats(location_id);

-- stock_issuance_items
CREATE INDEX IF NOT EXISTS idx_stock_issuance_items_product ON stock_issuance_items(product_id);

-- stock_issuances
CREATE INDEX IF NOT EXISTS idx_stock_issuances_receiver ON stock_issuances(receiver_id);

-- stock_issue_items
CREATE INDEX IF NOT EXISTS idx_stock_issue_items_issue_id ON stock_issue_items(issue_id);
CREATE INDEX IF NOT EXISTS idx_stock_issue_items_product_id ON stock_issue_items(product_id);

-- stock_receipt_items
CREATE INDEX IF NOT EXISTS idx_stock_receipt_items_product_id ON stock_receipt_items(product_id);
CREATE INDEX IF NOT EXISTS idx_stock_receipt_items_receipt_id ON stock_receipt_items(receipt_id);

-- stock_receipts
CREATE INDEX IF NOT EXISTS idx_stock_receipts_buyer_id ON stock_receipts(buyer_id);

-- stock_request_items
CREATE INDEX IF NOT EXISTS idx_stock_request_items_product_id ON stock_request_items(product_id);
CREATE INDEX IF NOT EXISTS idx_stock_request_items_request_id ON stock_request_items(request_id);

-- stock_requests
CREATE INDEX IF NOT EXISTS idx_stock_requests_location_id ON stock_requests(location_id);
CREATE INDEX IF NOT EXISTS idx_stock_requests_requested_by ON stock_requests(requested_by);

-- stock_transactions
CREATE INDEX IF NOT EXISTS idx_stock_transactions_location_id ON stock_transactions(location_id);
CREATE INDEX IF NOT EXISTS idx_stock_transactions_performed_by ON stock_transactions(performed_by);
CREATE INDEX IF NOT EXISTS idx_stock_transactions_product_id ON stock_transactions(product_id);

-- vaishnavas
CREATE INDEX IF NOT EXISTS idx_vaishnavas_senior_id ON vaishnavas(senior_id);
