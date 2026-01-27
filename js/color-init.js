// Инициализация цвета модуля до рендера страницы (предотвращает FOUC)
(function(){
    var c = { kitchen: '#f49800', housing: '#8b5cf6' };
    var m = localStorage.getItem('srsk_module') || 'kitchen';
    document.documentElement.style.setProperty('--current-color', c[m] || c.kitchen);
})();
