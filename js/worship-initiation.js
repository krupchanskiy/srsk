/**
 * Посвящение участника «Поклонения» — значок рядом с именем и подписи.
 * none — нет инициации, first — первая (харинама), second — вторая (дикша),
 * null — не указано (значка нет). Ставит старший в карточке человека.
 *
 * Значок — кружок с римской цифрой: вторая — залит цветом модуля, первая —
 * обведена, «нет» — серый пунктир. Без эмодзи, читается и в ночной теме.
 */
window.WorshipInitiation = (() => {
    const ПОДПИСЬ = {
        none: 'нет инициации',
        first: 'первая инициация (харинама)',
        second: 'вторая инициация (дикша)',
    };
    const КОРОТКО = { none: 'Нет', first: 'Первая', second: 'Вторая' };

    function значок(код) {
        if (!ПОДПИСЬ[код]) return '';
        const цвет = код === 'second'
            ? 'background: var(--current-color); color: #fff; border: 1.5px solid var(--current-color);'
            : код === 'first'
                ? 'color: var(--current-color-text, var(--current-color)); border: 1.5px solid var(--current-color);'
                : 'border: 1.5px dashed currentColor; opacity: .5;';
        return `<span title="${ПОДПИСЬ[код]}" aria-label="${ПОДПИСЬ[код]}" role="img"
            style="display:inline-flex; align-items:center; justify-content:center; width:1.4rem; height:1.4rem;
                   border-radius:9999px; font-size:.68rem; font-weight:700; line-height:1; vertical-align:middle;
                   margin-left:.3rem; flex:none; ${цвет}">${код === 'second' ? 'II' : код === 'first' ? 'I' : ''}</span>`;
    }

    return { значок, ПОДПИСЬ, КОРОТКО };
})();
