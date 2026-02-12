// ==================== CONFIG.JS ====================
// Централизованная конфигурация Supabase
// ВАЖНО: Этот файл должен быть подключен ПЕРВЫМ в HTML

(function() {
'use strict';

// Определяем окружение по домену
// ВАЖНО: localhost использует production, чтобы совпадать с portal-config.js
const hostname = window.location.hostname;
const isDev = hostname.includes('dev.') || hostname.includes('-dev');

// Конфигурации для разных окружений
const ENVIRONMENTS = {
    production: {
        SUPABASE_URL: 'https://llttmftapmwebidgevmg.supabase.co',
        SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxsdHRtZnRhcG13ZWJpZGdldm1nIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njg4NzQ3MTksImV4cCI6MjA4NDQ1MDcxOX0.V0J4_5AFDxHH6GsD-eh4N7fTBMjexSxAkVp2LSfgHh0'
    },
    development: {
        SUPABASE_URL: 'https://vzuiwpeovnzfokekdetq.supabase.co',
        SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZ6dWl3cGVvdm56Zm9rZWtkZXRxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njk4NDQwMzQsImV4cCI6MjA4NTQyMDAzNH0.PSf0VxkSO0nF26sSqXCsG5fu-79IqYA5zyzok_ekxJ8'
    }
};

const env = isDev ? ENVIRONMENTS.development : ENVIRONMENTS.production;

window.CONFIG = {
    ...env,
    ENV: isDev ? 'development' : 'production',
    IS_DEV: isDev,
    // SERVICE_ROLE_KEY используется только для users.html (управление пользователями)
    SUPABASE_SERVICE_ROLE_KEY: null // TODO: Вставить service role key если нужен
};

// Создаём ЕДИНСТВЕННЫЙ экземпляр Supabase клиента
// Все модули должны использовать window.supabaseClient вместо создания нового
if (typeof window.supabase !== 'undefined') {
    window.supabaseClient = window.supabase.createClient(
        window.CONFIG.SUPABASE_URL,
        window.CONFIG.SUPABASE_ANON_KEY
    );
}

})();
