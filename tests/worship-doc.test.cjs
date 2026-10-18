// Проверки формата документа стандартов.
//
// Главное, что здесь закрепляется: выполнить чужой скрипт через текст статьи
// невозможно по построению. Текст рисуется узлами (это проверяется в браузере),
// а единственная строка, которую браузер всё же разбирает, — адрес ссылки,
// и он проходит белый список схем. Его и проверяем в первую очередь.

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const исходник = fs.readFileSync(path.join(__dirname, '..', 'js', 'worship-doc.js'), 'utf8');
// const в vm не попадает в объект контекста, поэтому берём возвращённое значение
const песочница = vm.createContext({ document: undefined });
const Док = vm.runInContext(исходник + '\n;WorshipDoc', песочница);

// объекты приходят из другого контекста, и строгое сравнение спотыкается
// об их прототипы, а не об содержимое: сравниваем структурно
const равно = (что, чему, сообщение) =>
    assert.equal(JSON.stringify(что), JSON.stringify(чему), сообщение);

test('адрес ссылки: опасные схемы отбрасываются', () => {
    const опасные = [
        'javascript:alert(1)',
        'JaVaScRiPt:alert(1)',
        ' javascript:alert(1)',
        '\tjavascript:alert(1)',
        'java\nscript:alert(1)',
        'data:text/html,<script>alert(1)</script>',
        'vbscript:msgbox(1)',
        'file:///etc/passwd',
        'blob:https://example.org/x',
        '//evil.example/path',
        '/\\evil.example/path',
        'https:/\\evil.example',
        '\u0000javascript:alert(1)',
        'java\u00a0script:alert(1)',
    ];
    for (const адрес of опасные) {
        assert.equal(Док.адрес(адрес), null, `пропущен опасный адрес: ${адрес}`);
    }
});

test('адрес ссылки: обычные адреса проходят', () => {
    assert.equal(Док.адрес('https://ya.ru'), 'https://ya.ru');
    assert.equal(Док.адрес('http://a.b/c?d=1&e=2'), 'http://a.b/c?d=1&e=2');
    assert.equal(Док.адрес('mailto:a@b.ru'), 'mailto:a@b.ru');
    assert.equal(Док.адрес('tel:+79990000000'), 'tel:+79990000000');
    assert.equal(Док.адрес('article.html?id=1'), 'article.html?id=1');
    assert.equal(Док.адрес(''), null);
    assert.equal(Док.адрес(null), null);
});

test('разбор: незнакомые блоки и поля молча отбрасываются', () => {
    const разобран = Док.разобрать({ blocks: [
        { type: 'script', text: 'alert(1)' },
        { type: 'p', text: 'Обычный абзац', onclick: 'alert(1)' },
        { type: 'h2', spans: [{ t: 'Заголовок', b: 'да', класс: 'мусор' }] },
        null,
        'строка вместо блока',
        { type: 'img', caption: 'без пути' },
        { type: 'img', path: 'uid/файл.jpg', caption: 'со снимком' },
    ]});

    равно(разобран.blocks.map(б => б.type), ['p', 'h2', 'img']);
    равно(разобран.blocks[0], { type: 'p', spans: [{ t: 'Обычный абзац' }] });
    // b принимается только как настоящее true, иначе «жирный» ставился бы строкой
    равно(разобран.blocks[1].spans, [{ t: 'Заголовок' }]);
    assert.equal(разобран.blocks[2].path, 'uid/файл.jpg');
});

test('разбор: ссылка с опасным адресом теряет адрес, но сохраняет текст', () => {
    const { blocks } = Док.разобрать({ blocks: [
        { type: 'p', spans: [{ t: 'нажми', href: 'javascript:alert(1)' }] },
    ]});
    равно(blocks[0].spans, [{ t: 'нажми' }]);
});

test('разбор: мусор вместо документа даёт пустой документ', () => {
    for (const мусор of [null, undefined, 'строка', 42, {}, { blocks: 'не массив' }]) {
        равно(Док.разобрать(мусор), { blocks: [] });
    }
});

test('списки: пустые пункты выбрасываются, остальные становятся отрезками', () => {
    const { blocks } = Док.разобрать({ blocks: [
        { type: 'ul', items: ['раз', '', [{ t: 'два' }], [], null] },
        { type: 'ol', items: 'не массив' },
    ]});
    равно(blocks[0].items, [[{ t: 'раз' }], [{ t: 'два' }]]);
    равно(blocks[1].items, []);
});

test('простой текст собирается для поиска и сравнения версий', () => {
    const документ = { blocks: [
        { type: 'h2', text: 'Что приготовить' },
        { type: 'ul', items: ['Гхи', 'Вода'] },
        { type: 'p', spans: [{ t: 'Начало в ' }, { t: '4:30', b: true }] },
        { type: 'img', path: 'uid/a.jpg', caption: 'Алтарь' },
    ]};
    assert.equal(Док.текст(документ), 'Что приготовить\nГхи\nВода\nНачало в 4:30\nАлтарь');
});

test('оглавление: якоря совпадают с положением блока в документе', () => {
    const документ = { blocks: [
        { type: 'p', text: 'вступление' },
        { type: 'h2', text: 'Первый шаг' },
        { type: 'p', text: 'текст' },
        { type: 'h3', text: 'Подшаг' },
    ]};
    равно(Док.заголовки(документ), [
        { якорь: 'z1', текст: 'Первый шаг', уровень: 2 },
        { якорь: 'z3', текст: 'Подшаг', уровень: 3 },
    ]);
});

test('пути снимков собираются для ссылок ограниченного срока', () => {
    равно(Док.пути({ blocks: [
        { type: 'img', path: 'uid/a.jpg' },
        { type: 'p', text: 'между' },
        { type: 'img', path: 'uid/b.jpg' },
        { type: 'img' },
    ]}), ['uid/a.jpg', 'uid/b.jpg']);
});

test('пустой документ — один пустой абзац, чтобы было куда писать', () => {
    равно(Док.пустой(), { blocks: [{ type: 'p', text: '' }] });
});

test('ссылка на заголовок внутри статьи разрешена', () => {
    assert.equal(Док.адрес('#z3'), '#z3');
    assert.equal(Док.адрес('#шаг семь'), null);     // пробелы в якорь не кладём
});
