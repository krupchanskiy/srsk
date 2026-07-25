// @ts-check
// Тесты финансового контура. До 25.07.2026 их не было вообще — при том, что
// на кухню, жильё и склад тесты есть. Самый дорогой модуль был без покрытия.
//
// Логин здесь намеренно не делается: пароли в тестах не хранятся. Поэтому
// проверяем две вещи, которые от авторизации не зависят и при этом ловят
// настоящие поломки:
//   1) ни одна страница финмодуля не открывается без входа — это и есть
//      периметр, и он должен держаться;
//   2) утилиты форматирования денег и дат ведут себя по контракту —
//      скрипты подгружаются напрямую, без страницы.
//
// Первая версия этих тестов падала целиком: я проверял window.Layout на
// странице ДДС, не заметив, что она редиректит на вход. Тесты «краснели»
// правильно, но проверяли не то, что заявляли.
import { test, expect } from '@playwright/test';

const financePages = [
    ['Обзор',       '/finance/index.html'],
    ['ДДС',         '/finance/dds.html'],
    ['Счета',       '/finance/accounts.html'],
    ['Участники',   '/finance/participants.html'],
    ['Входящие',    '/finance/inbox.html'],
    ['Сверка',      '/finance/reconciliation.html'],
    ['Справочники', '/finance/dictionaries.html'],
    ['Аналитика',   '/finance/analytics.html'],
];

test.describe('Финмодуль закрыт без авторизации', () => {
    for (const [name, url] of financePages) {
        test(`${name} — гостя уводит со страницы`, async ({ page }) => {
            await page.goto(url, { waitUntil: 'domcontentloaded' });
            await page.waitForURL(u => !u.pathname.endsWith(url), { timeout: 10000 })
                .catch(() => {});
            expect(page.url(), `${url} осталась открытой без входа`).not.toContain(url);
        });
    }
});

// Утилиты грузим напрямую: страницы за авторизацией, а контракт проверить надо.
async function loadUtils(page) {
    await page.goto('/404.html', { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.addScriptTag({ url: '/js/date-utils.js' });
    await page.addScriptTag({ url: '/js/fin-utils.js' });
}

test.describe('Деньги форматируются предсказуемо', () => {
    test.beforeEach(async ({ page }) => { await loadUtils(page); });

    test('разряды отделяются, символ валюты на месте', async ({ page }) => {
        const out = await page.evaluate(() => ({
            тысяча:  window.FinUtils.fmtMoney(1500, 'INR'),
            миллион: window.FinUtils.fmtMoney(1234567, 'INR'),
            рубли:   window.FinUtils.fmtMoney(1500, 'RUB'),
            доллары: window.FinUtils.fmtMoney(1500, 'USD'),
            евро:    window.FinUtils.fmtMoney(1500, 'EUR'),
        }));
        expect(out.тысяча).toMatch(/1\s?500/);
        expect(out.миллион).toMatch(/1\s?234\s?567/);
        expect(out.тысяча).toContain('₹');
        expect(out.рубли).toContain('₽');
        expect(out.доллары).toContain('$');
        expect(out.евро).toContain('€');
    });

    test('копейки показываются только когда они есть', async ({ page }) => {
        const out = await page.evaluate(() => ({
            целое:  window.FinUtils.fmtMoney(1500, 'INR'),
            дробь:  window.FinUtils.fmtMoney(1500.5, 'INR'),
            дробь2: window.FinUtils.fmtMoney(1500.55, 'INR'),
        }));
        expect(out.целое).not.toMatch(/[.,]\d/);
        expect(out.дробь).toMatch(/[.,]5/);
        expect(out.дробь2).toMatch(/[.,]55/);
    });

    test('ноль, минус и мусор не дают NaN', async ({ page }) => {
        const out = await page.evaluate(() => ({
            ноль:  window.FinUtils.fmtMoney(0, 'INR'),
            минус: window.FinUtils.fmtMoney(-1500, 'INR'),
            пусто: window.FinUtils.fmtMoney(null, 'INR'),
            текст: window.FinUtils.fmtMoney('не число', 'INR'),
        }));
        expect(out.ноль).toContain('0');
        expect(out.минус).toMatch(/[-−]\s?1\s?500/);
        expect(JSON.stringify(out), 'где-то вылез NaN').not.toContain('NaN');
    });
});

test.describe('Даты — местное время, не UTC', () => {
    // Классическая ловушка проекта: new Date('2026-02-09') разбирается как UTC
    // и в минусовых поясах уезжает на день назад. parseDate обязан давать
    // ровно ту дату, которая написана.
    test.beforeEach(async ({ page }) => { await loadUtils(page); });

    test('parseDate не сдвигает день', async ({ page }) => {
        const out = await page.evaluate(() => {
            const d = window.DateUtils.parseDate('2026-02-09');
            return { год: d.getFullYear(), месяц: d.getMonth() + 1, день: d.getDate() };
        });
        expect(out).toEqual({ год: 2026, месяц: 2, день: 9 });
    });

    test('toISO возвращает ту же дату, что принял parseDate', async ({ page }) => {
        const same = await page.evaluate(() => {
            const iso = '2026-12-31';
            return window.DateUtils.toISO(window.DateUtils.parseDate(iso)) === iso;
        });
        expect(same, 'parseDate → toISO меняет дату').toBe(true);
    });

    test('конец года и високосный день не уезжают', async ({ page }) => {
        const out = await page.evaluate(() => ['2026-01-01', '2028-02-29', '2026-12-31']
            .map(iso => window.DateUtils.toISO(window.DateUtils.parseDate(iso))));
        expect(out).toEqual(['2026-01-01', '2028-02-29', '2026-12-31']);
    });
});

test.describe('Гостевой портал', () => {
    // Настоящая страница входа — /guest-portal/login/ (корневой login.html
    // только перекидывает на неё). Первая версия теста била в
    // /guest-portal/login.html, которого нет, и зеленела на пустой 404 —
    // поэтому здесь проверяется ещё и что страница действительно живая.
    test('страница входа живая и без ошибок JS', async ({ page }) => {
        const errors = [];
        page.on('pageerror', err => errors.push(err.message));

        // Файл указан явно: локальный `npx serve` для каталога отдаёт список
        // файлов вместо index.html. На GitHub Pages каталог открывается штатно,
        // так что это особенность дев-сервера, а не приложения.
        const resp = await page.goto('/guest-portal/login/index.html', { waitUntil: 'domcontentloaded' });
        expect(resp?.status(), 'страница входа недоступна').toBeLessThan(400);

        // форма появляется после отрисовки — ждём, а не смотрим сразу
        const form = await page.waitForSelector('#login-form, form', { timeout: 10000 })
            .catch(() => null);
        expect(form, 'на странице входа нет формы — проверь, туда ли ведёт редирект').not.toBeNull();

        const critical = errors.filter(e => !/Failed to fetch|NetworkError|ERR_|Load failed/.test(e));
        expect(critical, `ошибки JS: ${critical.join(' | ')}`).toHaveLength(0);
    });

    test('корневой /login.html ведёт на портал входа', async ({ page }) => {
        await page.goto('/login.html', { waitUntil: 'domcontentloaded' });
        await page.waitForURL(/guest-portal\/login/, { timeout: 10000 }).catch(() => {});
        expect(page.url()).toContain('guest-portal/login');
    });
});
