-- =============================================================
-- Финансовый модуль, Этап 0: базовые справочники
-- fin_currencies, fin_cost_centers, fin_categories, fin_contractors
-- Контракт «contacts = vaishnavas»: все ссылки на людей в финмодуле
-- ведут на public.vaishnavas(id).
-- =============================================================

CREATE TABLE fin_currencies (
  code        text PRIMARY KEY,
  symbol      text NOT NULL,
  name        text NOT NULL,
  minor_units int  NOT NULL DEFAULT 2 CHECK (minor_units = 2),
  is_active   boolean NOT NULL DEFAULT true
);

CREATE TABLE fin_cost_centers (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code       text UNIQUE NOT NULL,
  name       text NOT NULL,
  is_active  boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE fin_categories (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code                   text UNIQUE NOT NULL,
  name                   text NOT NULL,
  direction              fin_direction NOT NULL,
  visible_to_departments boolean NOT NULL DEFAULT false,
  is_active              boolean NOT NULL DEFAULT true,
  created_at             timestamptz NOT NULL DEFAULT now()
);

-- Справочник разовых внешних контрагентов (постоянные подотчётники —
-- это custodial-счета в fin_accounts, не записи здесь)
CREATE TABLE fin_contractors (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL,
  type         fin_contractor_type NOT NULL,
  contact_id   uuid REFERENCES vaishnavas(id),
  contact_info text,
  note         text,
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now()
);

INSERT INTO fin_currencies (code, symbol, name) VALUES
  ('INR', '₹', 'Индийская рупия'),
  ('RUB', '₽', 'Российский рубль'),
  ('USD', '$', 'Доллар США'),
  ('EUR', '€', 'Евро');
