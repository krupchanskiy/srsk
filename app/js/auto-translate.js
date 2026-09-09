// ==================== AUTO-TRANSLATE.JS ====================
// Автоперевод текста через MyMemory API и настройка автоперевода форм

(function() {
'use strict';

/**
 * Автоперевод текста через MyMemory API
 * @param {string} text - текст для перевода
 * @param {string} from - исходный язык (ru, en, hi)
 * @param {string} to - целевой язык (ru, en, hi)
 * @returns {Promise<string>} - переведённый текст
 */
async function translate(text, from = 'ru', to = 'en') {
    if (!text || !text.trim()) return '';

    try {
        const response = await fetch(
            `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${from}|${to}`
        );
        const data = await response.json();

        if (data.responseStatus === 200 && data.responseData?.translatedText) {
            // MyMemory иногда возвращает текст в верхнем регистре при ошибке
            const result = data.responseData.translatedText;
            if (result === text.toUpperCase()) {
                console.warn('Translation may have failed:', result);
                return text;
            }
            return result;
        }

        console.error('Translation error:', data);
        return text;
    } catch (error) {
        console.error('Translation fetch error:', error);
        return text;
    }
}

/**
 * Настройка автоперевода для полей формы
 * При вводе текста в поле _ru автоматически переводит в _en и _hi
 * @param {string} formSelector - селектор формы или контейнера
 * @param {string[]} fieldPrefixes - массив префиксов полей (например: ['name', 'description'])
 */
function setup(formSelector, fieldPrefixes = ['name']) {
    const form = document.querySelector(formSelector);
    if (!form) return;

    // Храним информацию о том, какие поля были автозаполнены
    const autoFilledFields = new Set();

    fieldPrefixes.forEach(prefix => {
        const ruField = form.querySelector(`[name="${prefix}_ru"]`);
        if (!ruField) return;

        const enField = form.querySelector(`[name="${prefix}_en"]`);
        const hiField = form.querySelector(`[name="${prefix}_hi"]`);

        // Отмечаем поля как вручную заполненные при фокусе и изменении
        [enField, hiField].forEach(field => {
            if (!field) return;
            field.addEventListener('input', () => {
                if (field.value.trim()) {
                    autoFilledFields.delete(field.name);
                }
            });
        });

        // Debounced автоперевод при вводе в русское поле
        const debouncedTranslate = Utils.debounce(async () => {
            const ruText = ruField.value.trim();
            if (!ruText) return;

            // Показываем индикатор загрузки
            const showLoading = (field) => {
                if (field && !field.value.trim()) {
                    field.classList.add('opacity-50');
                    field.placeholder = '...';
                }
            };
            const hideLoading = (field, placeholder = '') => {
                if (field) {
                    field.classList.remove('opacity-50');
                    field.placeholder = placeholder;
                }
            };

            // Переводим на английский если поле пустое или было автозаполнено
            if (enField && (!enField.value.trim() || autoFilledFields.has(enField.name))) {
                showLoading(enField);
                const enText = await translate(ruText, 'ru', 'en');
                if (enText && enText !== ruText) {
                    enField.value = enText;
                    autoFilledFields.add(enField.name);
                }
                hideLoading(enField);
            }

            // Переводим на хинди если поле пустое или было автозаполнено
            if (hiField && (!hiField.value.trim() || autoFilledFields.has(hiField.name))) {
                showLoading(hiField);
                const hiText = await translate(ruText, 'ru', 'hi');
                if (hiText && hiText !== ruText) {
                    hiField.value = hiText;
                    autoFilledFields.add(hiField.name);
                }
                hideLoading(hiField);
            }
        }, 800);

        ruField.addEventListener('input', debouncedTranslate);
    });
}

/**
 * Сбрасывает состояние автоперевода (вызывать при открытии модалки)
 */
function reset() {
    // Метод для внешнего вызова - сброс происходит автоматически при setup
}

window.AutoTranslate = { translate, setup, reset };

})();
