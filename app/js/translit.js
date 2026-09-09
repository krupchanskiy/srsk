// ==================== TRANSLIT.JS ====================
// Транслитерация кириллицы в латиницу и деванагари в IAST

(function() {
'use strict';

/** Таблица транслитерации кириллицы в латиницу */
const TRANSLIT_MAP = {
    'а':'a','б':'b','в':'v','г':'g','д':'d','е':'e','ё':'yo','ж':'zh','з':'z','и':'i','й':'y',
    'к':'k','л':'l','м':'m','н':'n','о':'o','п':'p','р':'r','с':'s','т':'t','у':'u','ф':'f',
    'х':'h','ц':'ts','ч':'ch','ш':'sh','щ':'shch','ъ':'','ы':'y','ь':'','э':'e','ю':'yu','я':'ya',
    'А':'A','Б':'B','В':'V','Г':'G','Д':'D','Е':'E','Ё':'Yo','Ж':'Zh','З':'Z','И':'I','Й':'Y',
    'К':'K','Л':'L','М':'M','Н':'N','О':'O','П':'P','Р':'R','С':'S','Т':'T','У':'U','Ф':'F',
    'Х':'H','Ц':'Ts','Ч':'Ch','Ш':'Sh','Щ':'Shch','Ъ':'','Ы':'Y','Ь':'','Э':'E','Ю':'Yu','Я':'Ya'
};

/** Транслитерация кириллицы в латиницу */
function ru(text) {
    if (!text) return '';
    return text.split('').map(c => TRANSLIT_MAP[c] || c).join('');
}

/** Транслитерация хинди (деванагари) в IAST */
function hi(hindi) {
    if (!hindi) return '';

    const CONSONANTS = {
        'क': 'k', 'ख': 'kh', 'ग': 'g', 'घ': 'gh', 'ङ': 'ṅ',
        'च': 'c', 'छ': 'ch', 'ज': 'j', 'झ': 'jh', 'ञ': 'ñ',
        'ट': 'ṭ', 'ठ': 'ṭh', 'ड': 'ḍ', 'ढ': 'ḍh', 'ण': 'ṇ',
        'त': 't', 'थ': 'th', 'द': 'd', 'ध': 'dh', 'न': 'n',
        'प': 'p', 'फ': 'ph', 'ब': 'b', 'भ': 'bh', 'म': 'm',
        'य': 'y', 'र': 'r', 'ल': 'l', 'व': 'v',
        'श': 'ś', 'ष': 'ṣ', 'स': 's', 'ह': 'h'
    };
    const VOWELS = { 'अ': 'a', 'आ': 'ā', 'इ': 'i', 'ई': 'ī', 'उ': 'u', 'ऊ': 'ū', 'ऋ': 'ṛ', 'ए': 'e', 'ऐ': 'ai', 'ओ': 'o', 'औ': 'au' };
    const MATRAS = { 'ा': 'ā', 'ि': 'i', 'ी': 'ī', 'ु': 'u', 'ू': 'ū', 'ृ': 'ṛ', 'े': 'e', 'ै': 'ai', 'ो': 'o', 'ौ': 'au' };
    const NUKTA_MAP = { 'क': 'q', 'ख': 'kh', 'ग': 'ġ', 'ज': 'z', 'फ': 'f', 'ड': 'ṛ', 'ढ': 'ṛh' };
    const ANUSVARA_MAP = {
        'क': 'ṅ', 'ख': 'ṅ', 'ग': 'ṅ', 'घ': 'ṅ', 'ङ': 'ṅ',
        'च': 'ñ', 'छ': 'ñ', 'ज': 'ñ', 'झ': 'ñ', 'ञ': 'ñ',
        'ट': 'ṇ', 'ठ': 'ṇ', 'ड': 'ṇ', 'ढ': 'ṇ', 'ण': 'ṇ',
        'त': 'n', 'थ': 'n', 'द': 'n', 'ध': 'n', 'न': 'n',
        'प': 'm', 'फ': 'm', 'ब': 'm', 'भ': 'm', 'म': 'm'
    };

    const text = hindi.normalize('NFC');
    let result = '';
    let i = 0;

    while (i < text.length) {
        const char = text[i];
        const next = text[i + 1];

        if (VOWELS[char]) {
            result += VOWELS[char];
            i++;
            continue;
        }

        if (CONSONANTS[char]) {
            if (next === '़') {
                result += NUKTA_MAP[char] || CONSONANTS[char];
                i += 2;
            } else {
                result += CONSONANTS[char];
                i++;
            }

            const after = text[i];
            if (after === '्') {
                i++;
            } else if (MATRAS[after]) {
                result += MATRAS[after];
                i++;
            } else if (after === 'ं') {
                result += 'a';
            } else if (after === 'ः') {
                result += 'aḥ';
                i++;
            } else if (after === 'ँ') {
                result += 'am̐';
                i++;
            } else if (!CONSONANTS[after] && !VOWELS[after] && after !== undefined) {
                result += 'a';
            } else if (after === undefined) {
                // Конец слова — НЕ добавляем 'a' (schwa deletion в хинди)
            } else {
                result += 'a';
            }
            continue;
        }

        if (char === 'ं') {
            const nextCons = text[i + 1];
            result += ANUSVARA_MAP[nextCons] || 'ṃ';
            i++;
            continue;
        }

        if (char === 'ः') { result += 'ḥ'; i++; continue; }
        if (char === 'ँ') { result += 'm̐'; i++; continue; }
        if (MATRAS[char]) { result += MATRAS[char]; i++; continue; }
        if (char === '्' || char === '़') { i++; continue; }

        result += char;
        i++;
    }
    return result;
}

window.Translit = { ru, hi };

})();
