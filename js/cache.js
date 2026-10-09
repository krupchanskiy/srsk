// ==================== CACHE.JS ====================
// Кэширование справочников в localStorage с TTL

(function() {
'use strict';

const PREFIX = 'srsk_cache_';
const DEFAULT_TTL = 60 * 60 * 1000; // 1 час

/** Получить данные из кэша (null если нет или истёк TTL) */
function get(key) {
    try {
        const raw = localStorage.getItem(PREFIX + key);
        if (!raw) return null;
        const entry = JSON.parse(raw);
        if (Date.now() > entry.expires) {
            localStorage.removeItem(PREFIX + key);
            return null;
        }
        return entry.data;
    } catch (e) {
        localStorage.removeItem(PREFIX + key);
        return null;
    }
}

/** Сохранить данные в кэш с TTL */
function set(key, data, ttl = DEFAULT_TTL) {
    try {
        const entry = { data, expires: Date.now() + ttl };
        localStorage.setItem(PREFIX + key, JSON.stringify(entry));
    } catch (e) {
        console.warn('Cache.set error:', e);
    }
}

/** Удалить конкретные ключи из кэша */
function invalidate(...keys) {
    keys.forEach(key => localStorage.removeItem(PREFIX + key));
}

/** Удалить все ключи с префиксом srsk_cache_ */
function invalidateAll() {
    const toRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith(PREFIX)) {
            toRemove.push(key);
        }
    }
    toRemove.forEach(key => localStorage.removeItem(key));
}

/** Получить из кэша или загрузить через loaderFn */
async function getOrLoad(key, loaderFn, ttl = DEFAULT_TTL) {
    // Пустой список не кэшируем и из кэша не берём: запрос до входа (RLS) отдаёт [],
    // и шахматка час показывала бы «ни одного здания»
    const пусто = d => Array.isArray(d) && d.length === 0;
    const cached = get(key);
    if (cached !== null && !пусто(cached)) return cached;

    const data = await loaderFn();
    if (data != null && !пусто(data)) {
        set(key, data, ttl);
    }
    return data;
}

window.Cache = { get, set, invalidate, invalidateAll, getOrLoad };

})();
