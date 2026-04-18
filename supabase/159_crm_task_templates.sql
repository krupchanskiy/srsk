-- ============================================
-- Миграция 159: Редактор шаблонов автозадач CRM
-- ============================================
-- Таблица crm_task_templates заменяет хардкод в crm_auto_tasks().
-- Логика: при входе сделки в стадию X (INSERT со status=X ИЛИ UPDATE old.status≠new.status=X)
-- триггер создаёт задачи по шаблонам. Если у ретрита есть шаблоны для стадии X — берутся
-- только они (полное переопределение), иначе — дефолтные (retreat_id IS NULL).

-- 1. Таблица шаблонов
CREATE TABLE IF NOT EXISTS crm_task_templates (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    retreat_id      UUID REFERENCES retreats(id) ON DELETE CASCADE, -- NULL = дефолт
    trigger_status  TEXT NOT NULL CHECK (trigger_status IN (
        'lead','working','invoiced','booked','checklist','ready','completed','cancelled'
    )),
    title           TEXT NOT NULL,
    days_offset     INT  NOT NULL DEFAULT 1 CHECK (days_offset >= 0 AND days_offset <= 365),
    priority        TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order      INT  NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS crm_task_templates_lookup_idx
    ON crm_task_templates (trigger_status, is_active, retreat_id);

-- 2. RLS — персонал управляет, гости не видят
ALTER TABLE crm_task_templates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Staff manage crm_task_templates" ON crm_task_templates;
CREATE POLICY "Staff manage crm_task_templates" ON crm_task_templates
    FOR ALL USING (is_staff((SELECT auth.uid())));

-- 3. Сид дефолтных шаблонов — текущие хардкод-правила из миграции 150
INSERT INTO crm_task_templates (retreat_id, trigger_status, title, days_offset, priority, sort_order) VALUES
    (NULL, 'lead',      'Связаться с {guest}',                             1,  'high',   10),
    (NULL, 'working',   'Уточнить детали у {guest}',                       2,  'normal', 10),
    (NULL, 'booked',    'Подготовить к заезду {guest}',                    3,  'normal', 10),
    (NULL, 'cancelled', 'Follow-up: предложить {guest} следующий ретрит', 30,  'low',    10)
ON CONFLICT DO NOTHING;

-- 4. Новая функция триггера — читает шаблоны
CREATE OR REPLACE FUNCTION crm_auto_tasks()
RETURNS TRIGGER LANGUAGE plpgsql AS $func$
DECLARE
    tmpl                    RECORD;
    guest_name              TEXT;
    task_title              TEXT;
    has_retreat_templates   BOOLEAN;
BEGIN
    -- Срабатываем только при ВХОДЕ в стадию:
    -- INSERT в любом статусе ИЛИ UPDATE со сменой статуса.
    IF TG_OP = 'UPDATE' AND NEW.status = OLD.status THEN
        RETURN NEW;
    END IF;

    -- Имя гостя для подстановки в {guest}
    SELECT COALESCE(NULLIF(spiritual_name,''), NULLIF(TRIM(COALESCE(first_name,'') || ' ' || COALESCE(last_name,'')), ''))
      INTO guest_name
      FROM vaishnavas WHERE id = NEW.vaishnava_id;

    -- Есть ли у ретрита свои шаблоны для этой стадии?
    SELECT EXISTS(
        SELECT 1 FROM crm_task_templates
         WHERE retreat_id = NEW.retreat_id
           AND trigger_status = NEW.status
           AND is_active = TRUE
    ) INTO has_retreat_templates;

    FOR tmpl IN
        SELECT id, title, days_offset, priority FROM crm_task_templates
         WHERE trigger_status = NEW.status
           AND is_active = TRUE
           AND (
               (has_retreat_templates AND retreat_id = NEW.retreat_id) OR
               (NOT has_retreat_templates AND retreat_id IS NULL)
           )
         ORDER BY sort_order, created_at
    LOOP
        task_title := CASE
            WHEN POSITION('{guest}' IN tmpl.title) > 0
                THEN REPLACE(tmpl.title, '{guest}', COALESCE(guest_name, ''))
            ELSE tmpl.title
        END;

        INSERT INTO crm_tasks (deal_id, title, due_date, priority, assignee_id, is_auto_created)
        VALUES (
            NEW.id,
            task_title,
            (CURRENT_DATE + (tmpl.days_offset || ' days')::INTERVAL)::DATE,
            tmpl.priority,
            NEW.manager_id,
            TRUE
        );
    END LOOP;

    RETURN NEW;
END;
$func$;

-- Триггер уже установлен в миграции 145 — функция просто переопределена выше.
