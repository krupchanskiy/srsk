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
})();
