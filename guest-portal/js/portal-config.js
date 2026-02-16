// ==================== PORTAL-CONFIG.JS ====================
// Конфигурация Supabase для Guest Portal
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
        SUPABASE_URL: 'https://llttmftapmwebidgevmg.supabase.co',
        SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxsdHRtZnRhcG13ZWJpZGdldm1nIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njg4NzQ3MTksImV4cCI6MjA4NDQ1MDcxOX0.V0J4_5AFDxHH6GsD-eh4N7fTBMjexSxAkVp2LSfgHh0'
    },
    development: {
        SUPABASE_URL: 'https://vzuiwpeovnzfokekdetq.supabase.co',
        SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZ6dWl3cGVvdm56Zm9rZWtkZXRxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njk4NDQwMzQsImV4cCI6MjA4NTQyMDAzNH0.PSf0VxkSO0nF26sSqXCsG5fu-79IqYA5zyzok_ekxJ8'
    }
};

const env = isDev ? ENVIRONMENTS.development : ENVIRONMENTS.production;

window.PORTAL_CONFIG = {
    ...env,
    ENV: isDev ? 'development' : 'production',
    IS_DEV: isDev,

    // Цвета портала
    COLORS: {
        GREEN: '#147D30',
        ORANGE: '#FFBA47',
        BG: '#F5F3EF'
    },

    // Storage bucket для фото
    PHOTO_BUCKET: 'vaishnava-photos',

    // Telegram бот
    TELEGRAM_BOT_NAME: 'rupaseva_bot'
};

// Лог для отладки
console.log('[ENV]', window.PORTAL_CONFIG.ENV + ':', location.hostname || 'file://', '→', window.PORTAL_CONFIG.SUPABASE_URL);

// Создаём ЕДИНСТВЕННЫЙ экземпляр Supabase клиента
if (typeof window.supabase !== 'undefined') {
    window.portalSupabase = window.supabase.createClient(
        window.PORTAL_CONFIG.SUPABASE_URL,
        window.PORTAL_CONFIG.SUPABASE_ANON_KEY
    );
}

})();
