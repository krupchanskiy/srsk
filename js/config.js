// ==================== CONFIG.JS ====================
// Централизованная конфигурация Supabase
// ВАЖНО: Этот файл должен быть подключен ПЕРВЫМ в HTML

(function() {
'use strict';

// Определяем окружение по домену
// ВАЖНО: localhost / file:// / vercel preview / dev-* домены считаем DEV
const hostname = window.location.hostname;

const isFileProtocol = window.location.protocol === 'file:';
const isLocalhost =
  hostname === 'localhost' ||
  hostname === '127.0.0.1' ||
  hostname.startsWith('192.168.') ||
  hostname.startsWith('10.') ||
  hostname.startsWith('172.');

const isDev =
  isFileProtocol ||
  isLocalhost ||
  hostname.includes('vercel.app') ||
  hostname.includes('dev-srsk') ||
  hostname.includes('dev.') ||
  hostname.includes('-dev');


// Конфигурации для разных окружений
const ENVIRONMENTS = {
    production: {
        SUPABASE_URL: 'https://mymrijdfqeevoaocbzfy.supabase.co',
        SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im15bXJpamRmcWVldm9hb2NiemZ5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzIwNzI3MzAsImV4cCI6MjA4NzY0ODczMH0.CWTCnvY8osSO5Hb43NmtlugahPuE3nUaSE0Iy3gQtvs'
    },
    development: {
        SUPABASE_URL: 'https://vzuiwpeovnzfokekdetq.supabase.co',
        SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZ6dWl3cGVvdm56Zm9rZWtkZXRxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njk4NDQwMzQsImV4cCI6MjA4NTQyMDAzNH0.PSf0VxkSO0nF26sSqXCsG5fu-79IqYA5zyzok_ekxJ8'
    }
};

// DEV тоже использует prod БД (в dev-БД нет данных)
const env = ENVIRONMENTS.production;

window.CONFIG = {
    ...env,
    ENV: isDev ? 'development' : 'production',
    IS_DEV: isDev,
    // SERVICE_ROLE_KEY используется только для users.html (управление пользователями)
    SUPABASE_SERVICE_ROLE_KEY: null // TODO: Вставить service role key если нужен
};

debug('[ENV]', window.CONFIG.ENV + ':', location.hostname || 'file://', '→', window.CONFIG.SUPABASE_URL);


// Создаём ЕДИНСТВЕННЫЙ экземпляр Supabase клиента
// Все модули должны использовать window.supabaseClient вместо создания нового
if (typeof window.supabase !== 'undefined') {
    window.supabaseClient = window.supabase.createClient(
        window.CONFIG.SUPABASE_URL,
        window.CONFIG.SUPABASE_ANON_KEY
    );
}

})();
