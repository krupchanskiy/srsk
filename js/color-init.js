// Инициализация цвета модуля до рендера страницы (предотвращает FOUC)
(function(){
    var c = { kitchen: '#f49800', housing: '#8b5cf6', crm: '#10b981', finance: '#0d9488', admin: '#374151', shop: '#0284c7', worship: '#6b4226', departments: '#4f46e5' };
    var m = localStorage.getItem('srsk_module') || 'kitchen';
    document.documentElement.style.setProperty('--current-color', c[m] || c.kitchen);
    // цвет модуля как цвет БУКВ: светлые цвета (зелёный CRM, оранжевый кухни)
    // на белом давали 2–4:1 при норме 4.5 — для текста берём тёмный оттенок
    var t = { '#f49800': '#9a5500', '#8b5cf6': '#6d28d9', '#10b981': '#047857',
              '#0d9488': '#0f766e', '#0284c7': '#0369a1' };
    var цвет = c[m] || c.kitchen;
    document.documentElement.style.setProperty('--current-color-text', t[цвет] || цвет);

    // Ночной режим «Поклонения»: пуджари открывает модуль в 4 утра у алтаря,
    // и белый экран слепит и светит на всю алтарную. По умолчанию — как в
    // телефоне; можно закрепить «всегда ночь» или «всегда день».
    // Только в этом модуле: в остальных есть светлые цвета, заданные жёстко.
    var КЛЮЧ = 'srsk_worship_night';
    function режим() { try { return localStorage.getItem(КЛЮЧ) || 'auto'; } catch (e) { return 'auto'; } }
    function тёмная(р) {
        return р === 'on' || (р !== 'off' && window.matchMedia
            && window.matchMedia('(prefers-color-scheme: dark)').matches);
    }
    function применить() {
        // window.__модуль ставит сборщик тестовых копий страниц (tests/)
        if (location.pathname.indexOf('/worship/') === -1 && window.__модуль !== 'worship') return;
        var ночь = тёмная(режим());
        document.documentElement.setAttribute('data-theme', ночь ? 'dark' : 'light');
        // коричневый модуля на тёмном фоне не читается — буквы светлее
        if (ночь) document.documentElement.style.setProperty('--current-color-text', '#e2b98c');
        else document.documentElement.style.setProperty('--current-color-text', t[цвет] || цвет);
    }
    window.srskNight = {
        режим: режим,
        // как в телефоне → ночь → день → как в телефоне
        переключить: function () {
            var следующий = { auto: 'on', on: 'off', off: 'auto' }[режим()] || 'auto';
            try { localStorage.setItem(КЛЮЧ, следующий); } catch (e) { /* приватный режим */ }
            применить();
            return следующий;
        },
        подпись: function (р) {
            return { auto: 'Тема: как в телефоне', on: 'Тема: ночная', off: 'Тема: дневная' }[р || режим()];
        }
    };
    применить();
    // сменили тему телефона, пока страница открыта
    if (window.matchMedia) {
        var мм = window.matchMedia('(prefers-color-scheme: dark)');
        if (мм.addEventListener) мм.addEventListener('change', применить);
    }
})();
