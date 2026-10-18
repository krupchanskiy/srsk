/**
 * Подборка: составление, выдача, печать.
 *
 * Стандарты в подборке всегда в действующей редакции — человек открывает её
 * через месяц и видит то, что действует сейчас, а не слепок на день выдачи.
 * Отменённый стандарт помечается «больше не действует», но не исчезает:
 * иначе дорожка рвётся, и непонятно, было там что-то или нет.
 *
 * Прогресс не отслеживается сознательно: подборка — это то, что дали почитать,
 * а не курс с отчётностью.
 */
const WorshipKit = (() => {
    const $ = s => document.querySelector(s);
    const e = str => Layout.escapeHtml(str ?? '');
    const можноПисать = () => !!window.hasPermission?.('worship_write');

    const id = new URLSearchParams(location.search).get('id');
    let подборка = null, пункты = [], выдачи = [], имена = {};

    /** confirm() во встроенном браузере всегда отвечает «нет» — спрашиваем своей модалкой. */
    function спросить(заголовок, текст) {
        return new Promise(готово => {
            $('#пдЗаголовок').textContent = заголовок;
            $('#пдТекст').textContent = текст || '';
            const окно = $('#подтверждение');
            const да = $('#пдДа');
            const обработчик = () => { окно.close(); готово(true); };
            да.addEventListener('click', обработчик, { once: true });
            окно.addEventListener('close', () => {
                да.removeEventListener('click', обработчик);
                готово(false);
            }, { once: true });
            окно.showModal();
        });
    }

    /**
     * RLS-отказ на UPDATE — это ноль строк, а не ошибка: без .select() человек
     * видит «сохранено», а в базе остаётся старое. Поэтому каждая запись
     * возвращает строку, и пустой ответ — тоже отказ.
     */
    async function записать(запрос, что) {
        const { data, error } = await запрос.select('id');
        if (error) { Layout.handleError(error, что); return false; }
        if (!data?.length) {
            Layout.showNotification('Не сохранилось: похоже, нет прав на эту запись', 'error');
            return false;
        }
        return true;
    }

    /** Свободный текст в фильтре PostgREST: запятая и скобка меняют смысл условия. */
    const вКавычках = s => '"' + String(s).replace(/["\\]/g, '\\$&') + '"';

    async function загрузить() {
        if (!id) return false;
        const [п, и, в] = await Promise.all([
            Layout.db.from('worship_kits').select('*').eq('id', id).maybeSingle(),
            Layout.db.from('worship_kit_items')
                .select('id, sort_order, article_id, album_id, note').eq('kit_id', id).order('sort_order'),
            можноПисать()
                ? Layout.db.from('worship_kit_grants')
                    .select('id, vaishnava_id, retreat_id, granted_at, revoked_at').eq('kit_id', id)
                    .order('granted_at', { ascending: false })
                : Promise.resolve({ data: [] }),
        ]);
        if (п.error || и.error) { Layout.handleError(п.error || и.error, 'Загрузка подборки'); return false; }
        if (!п.data) { Layout.showNotification('Подборка не найдена', 'warning'); return false; }

        подборка = п.data;
        пункты = и.data || [];
        выдачи = (в.data || []).filter(г => !г.revoked_at);

        // подтягиваем названия того, из чего собрана дорожка
        const статьи = пункты.map(п2 => п2.article_id).filter(Boolean);
        const наборы = пункты.map(п2 => п2.album_id).filter(Boolean);
        const люди = выдачи.map(г => г.vaishnava_id).filter(Boolean);
        const ретриты = выдачи.map(г => г.retreat_id).filter(Boolean);

        const [с, н, л, р] = await Promise.all([
            статьи.length ? Layout.db.from('worship_articles')
                .select('id, title, kind, status, summary').in('id', статьи) : Promise.resolve({ data: [] }),
            наборы.length ? Layout.db.from('worship_albums')
                .select('id, title, event_date, is_private, is_archived').in('id', наборы) : Promise.resolve({ data: [] }),
            люди.length ? Layout.db.from('vaishnavas')
                .select('id, spiritual_name, first_name, last_name').in('id', люди) : Promise.resolve({ data: [] }),
            ретриты.length ? Layout.db.from('retreats')
                .select('id, name_ru, name_en, name_hi, start_date').in('id', ретриты) : Promise.resolve({ data: [] }),
        ]);

        имена = { статьи: {}, наборы: {}, люди: {}, ретриты: {} };
        (с.data || []).forEach(а => { имена.статьи[а.id] = а; });
        (н.data || []).forEach(а => { имена.наборы[а.id] = а; });
        (л.data || []).forEach(ч => {
            имена.люди[ч.id] = ч.spiritual_name ||
                `${ч.first_name || ''} ${ч.last_name || ''}`.trim() || 'без имени';
        });
        (р.data || []).forEach(рт => { имена.ретриты[рт.id] = Layout.getName(рт); });
        return true;
    }

    // ---------- отрисовка ----------
    function рисоватьШапку() {
        $('#название').textContent = подборка.title;
        $('#описание').textContent = подборка.description || '';

        const кнопки = ['<button class="btn btn-sm btn-outline no-print" id="печать">Печать</button>'];
        if (можноПисать()) {
            кнопки.unshift('<button class="btn btn-sm btn-outline no-print" id="правка">Изменить</button>');
            кнопки.push(`<button class="btn btn-sm btn-ghost no-print" id="включение">${
                подборка.is_active ? 'Отключить' : 'Включить'}</button>`);
        }
        $('#actions').innerHTML = кнопки.join('');
    }

    function строкаПункта(п, номер) {
        if (п.note) {
            return `
            <li class="py-3 border-b border-base-200 last:border-0">
                <div class="text-[15px] leading-relaxed bg-base-200 rounded-lg px-4 py-3">${e(п.note)}</div>
                ${ручки(п)}
            </li>`;
        }

        if (п.article_id) {
            const а = имена.статьи[п.article_id];
            if (!а) return недоступен(номер, 'статья');
            const куда = а.kind === 'material' ? 'material' : 'article';
            return `
            <li class="py-3 border-b border-base-200 last:border-0">
                <div class="flex flex-wrap items-baseline gap-2">
                    <span class="opacity-40">${номер}.</span>
                    <a class="link font-semibold" href="${куда}.html?id=${а.id}">${e(а.title)}</a>
                    <span class="badge badge-sm">${а.kind === 'material' ? 'материал' : 'стандарт'}</span>
                    ${а.status === 'archived'
                        ? '<span class="badge badge-sm badge-warning">больше не действует</span>' : ''}
                </div>
                ${а.summary ? `<div class="text-sm opacity-70 mt-0.5">${e(а.summary)}</div>` : ''}
                ${ручки(п)}
            </li>`;
        }

        const н = имена.наборы[п.album_id];
        if (!н) return недоступен(номер, 'набор фотографий');
        return `
        <li class="py-3 border-b border-base-200 last:border-0">
            <div class="flex flex-wrap items-baseline gap-2">
                <span class="opacity-40">${номер}.</span>
                <a class="link font-semibold" href="album.html?id=${н.id}">${e(н.title)}</a>
                <span class="badge badge-sm">фото</span>
                ${н.is_private
                    ? '<span class="badge badge-sm badge-error">закрытый набор — выдать нельзя</span>' : ''}
                <span class="text-sm opacity-60">${
                    DateUtils.formatShort(DateUtils.parseDate(н.event_date))}</span>
            </div>
            ${ручки(п)}
        </li>`;
    }

    /**
     * Пункт, цель которого недоступна читателю (черновик, закрытый набор),
     * раньше просто пропадал — дорожка шла «1, 2, 4» и человек гадал,
     * что он пропустил.
     */
    function недоступен(номер, что) {
        return `
        <li class="py-3 border-b border-base-200 last:border-0 opacity-60">
            <span class="opacity-40">${номер}.</span>
            <span class="italic">этот пункт (${что}) сейчас недоступен</span>
        </li>`;
    }

    function ручки(п) {
        if (!можноПисать()) return '';
        return `
        <div class="flex flex-wrap gap-1 mt-1 no-print">
            <button class="btn btn-ghost btn-xs" data-двигать="-1" data-id="${п.id}">↑</button>
            <button class="btn btn-ghost btn-xs" data-двигать="1" data-id="${п.id}">↓</button>
            ${п.note ? `<button class="btn btn-ghost btn-xs" data-правитьТекст="${п.id}">Поправить</button>` : ''}
            <button class="btn btn-ghost btn-xs text-error" data-убрать="${п.id}">✕</button>
        </div>`;
    }

    function рисоватьПункты() {
        let номер = 0;
        $('#пункты').innerHTML = пункты.map(п => {
            if (!п.note) номер++;
            return строкаПункта(п, номер);
        }).join('') ||
            '<li class="py-4 text-sm opacity-60">Дорожка пока пуста. Добавьте первый пункт ниже.</li>';
    }

    function рисоватьВыдачи() {
        $('#выдачи').innerHTML = выдачи.map(г => `
            <li class="flex flex-wrap items-center gap-3 border-b border-base-200 last:border-0 py-2">
                <span class="flex-1 min-w-0">
                    <span class="font-semibold">${
                        г.vaishnava_id ? e(имена.люди[г.vaishnava_id] || 'человек')
                                       : e(имена.ретриты[г.retreat_id] || 'ретрит')}</span>
                    <span class="badge badge-sm ml-2">${г.vaishnava_id ? 'человек' : 'все волонтёры ретрита'}</span>
                    <span class="block text-sm opacity-60">выдана ${
                        DateUtils.formatShort(new Date(г.granted_at))}</span>
                </span>
                <button class="btn btn-sm btn-ghost text-error" data-отозвать="${г.id}">Отозвать</button>
            </li>`).join('') ||
            '<li class="py-2 text-sm opacity-60">Пока никому не выдана</li>';
    }

    // ---------- добавление пунктов ----------
    async function выбрать(вид) {
        const окно = $('#выборМодал');
        const заголовки = {
            standard: ['Какой стандарт добавить?', 'В подборке он всегда будет в действующей редакции.'],
            material: ['Какой материал добавить?', 'Книга, заметка или ссылка из библиотеки.'],
            album: ['Какой набор фотографий добавить?', 'Закрытый набор добавить нельзя: подборку читают снаружи отдела.'],
        };
        $('#выборЗаголовок').textContent = заголовки[вид][0];
        $('#выборПодсказка').textContent = заголовки[вид][1];
        $('#выборПоиск').value = '';

        let строки = [];
        if (вид === 'album') {
            const { data } = await Layout.db.from('worship_albums')
                .select('id, title, event_date, is_private, is_archived')
                .eq('is_archived', false).order('event_date', { ascending: false });
            строки = (data || []).map(н => ({
                id: н.id, имя: н.title,
                подпись: DateUtils.formatShort(DateUtils.parseDate(н.event_date)),
                нельзя: н.is_private ? 'закрытый набор' : null,
            }));
        } else {
            const { data } = await Layout.db.from('worship_articles')
                .select('id, title, summary, status')
                .eq('kind', вид === 'standard' ? 'standard' : 'material')
                .eq('status', 'published').order('title');
            строки = (data || []).map(а => ({ id: а.id, имя: а.title, подпись: а.summary || '' }));
        }

        const рисовать = () => {
            const q = $('#выборПоиск').value.trim().toLowerCase();
            const видимые = строки.filter(с => !q || с.имя.toLowerCase().includes(q));
            $('#выборСписок').innerHTML = видимые.map(с => `
                <li class="border-b border-base-200 last:border-0 py-2 flex items-center gap-3">
                    <span class="flex-1 min-w-0">
                        <span class="font-semibold">${e(с.имя)}</span>
                        ${с.подпись ? `<span class="block text-sm opacity-60">${e(с.подпись)}</span>` : ''}
                    </span>
                    ${с.нельзя
                        ? `<span class="badge badge-sm badge-error">${e(с.нельзя)}</span>`
                        : `<button class="btn btn-sm btn-outline" data-взять="${с.id}" data-вид="${вид}">Добавить</button>`}
                </li>`).join('') || '<li class="py-3 text-sm opacity-60">Ничего не нашлось</li>';
        };
        рисовать();
        $('#выборПоиск').oninput = рисовать;
        окно.showModal();
    }

    async function положить(вид, значение) {
        const строка = {
            kit_id: id,
            sort_order: Math.max(0, ...пункты.map(п => п.sort_order ?? 0)) + 1,
            created_by: window.currentUser?.id || null,
        };
        if (вид === 'album') строка.album_id = значение;
        else if (вид === 'note') строка.note = значение;
        else строка.article_id = значение;

        const { error } = await Layout.db.from('worship_kit_items').insert(строка);
        if (error) {
            // политика не пускает закрытый набор: сообщение понятнее сырого RLS
            if (/row-level security/i.test(error.message || '')) {
                return Layout.showNotification(
                    'Закрытый или убранный в архив набор в подборку не кладётся', 'warning');
            }
            return Layout.handleError(error, 'Пункт подборки');
        }
        $('#выборМодал').close();
        await перечитать();
    }

    // ---------- выдача ----------
    async function выдать(кому) {
        const окно = $('#выдачаМодал');
        const поиск = $('#вПоиск');

        if (кому === 'человек') {
            $('#вЗаголовок').textContent = 'Кому выдаём подборку?';
            $('#вПодсказка').textContent = 'Содержимое увидит человек вне отдела — в портале гостя, ещё до приезда.';
            поиск.hidden = false;
            поиск.value = '';
            $('#вСписок').innerHTML = '<li class="py-3 text-sm opacity-60">Впишите часть имени.</li>';
            поиск.oninput = Layout.debounce(async () => {
                const имя = поиск.value.trim();
                if (имя.length < 2) {
                    $('#вСписок').innerHTML = '<li class="py-3 text-sm opacity-60">Впишите хотя бы две буквы.</li>';
                    return;
                }
                const кав = вКавычках(`%${имя}%`);
                const { data, error } = await Layout.db.from('vaishnavas')
                    .select('id, spiritual_name, first_name, last_name')
                    .or(`spiritual_name.ilike.${кав},first_name.ilike.${кав},last_name.ilike.${кав}`)
                    .limit(20);
                if (error) return Layout.handleError(error, 'Поиск человека');
                $('#вСписок').innerHTML = (data || []).map(ч => {
                    const имя2 = ч.spiritual_name ||
                        `${ч.first_name || ''} ${ч.last_name || ''}`.trim() || 'без имени';
                    return `
                    <li class="border-b border-base-200 last:border-0 py-2 flex items-center gap-3">
                        <span class="flex-1 min-w-0 font-semibold">${e(имя2)}</span>
                        <button class="btn btn-sm btn-outline" data-выдать-человеку="${ч.id}"
                                data-имя="${e(имя2)}">Выдать</button>
                    </li>`;
                }).join('') || '<li class="py-3 text-sm opacity-60">Никого не нашлось</li>';
            }, 300);
        } else {
            $('#вЗаголовок').textContent = 'Какому ретриту?';
            $('#вПодсказка').textContent = 'Подборку получат волонтёры и команда ретрита — гости и важные гости нет.';
            поиск.hidden = true;
            const { data, error } = await Layout.db.from('retreats')
                .select('id, name_ru, name_en, name_hi, start_date')
                .order('start_date', { ascending: false }).limit(20);
            if (error) return Layout.handleError(error, 'Ретриты');
            $('#вСписок').innerHTML = (data || []).map(р => `
                <li class="border-b border-base-200 last:border-0 py-2 flex items-center gap-3">
                    <span class="flex-1 min-w-0">
                        <span class="font-semibold">${e(Layout.getName(р))}</span>
                        <span class="block text-sm opacity-60">${
                            DateUtils.formatShort(DateUtils.parseDate(р.start_date))}</span>
                    </span>
                    <button class="btn btn-sm btn-outline" data-выдать-ретриту="${р.id}"
                            data-имя="${e(Layout.getName(р))}">Выдать</button>
                </li>`).join('') || '<li class="py-3 text-sm opacity-60">Ретритов нет</li>';
        }
        окно.showModal();
    }

    async function выдачу(кому, значение, имя) {
        const согласен = await спросить(
            кому === 'человек' ? 'Выдать подборку?' : 'Выдать подборку всему ретриту?',
            кому === 'человек'
                ? `Содержимое подборки «${подборка.title}» увидит ${имя} — в портале гостя, ещё до приезда.`
                : `Подборку «${подборка.title}» получат волонтёры и команда ретрита «${имя}».`);
        if (!согласен) return;

        const { error } = await Layout.db.rpc('worship_kit_grant', {
            p_kit: id,
            p_vaishnava: кому === 'человек' ? значение : null,
            p_retreat: кому === 'человек' ? null : значение,
        });
        if (error) return Layout.handleError(error, 'Выдача подборки');
        $('#выдачаМодал').close();
        await перечитать();
        Layout.showNotification('Выдано', 'success');
    }

    function правитьПодборку() {
        $('#пНазвание').value = подборка.title || '';
        $('#пОписание').value = подборка.description || '';
        $('#пЯзык').value = подборка.lang || 'ru';
        $('#правкаМодал').showModal();
    }

    async function сохранитьПодборку() {
        const название = $('#пНазвание').value.trim();
        if (!название) return Layout.showNotification('Без названия подборку не найти', 'warning');
        const ок = await записать(Layout.db.from('worship_kits').update({
            title: название,
            description: $('#пОписание').value.trim() || null,
            lang: $('#пЯзык').value,
            updated_at: new Date().toISOString(),
            updated_by: window.currentUser?.id || null,
        }).eq('id', id), 'Подборка');
        if (!ок) return;
        $('#правкаМодал').close();
        await перечитать();
    }

    /** Свой текст между пунктами: новый, если пункт не передан. */
    let правимПункт = null;
    function правитьТекстПункта(п) {
        правимПункт = п || null;
        $('#тТекст').value = п?.note || '';
        $('#текстМодал').showModal();
    }

    async function сохранитьТекстПункта() {
        const текст = $('#тТекст').value.trim();
        if (!текст) return Layout.showNotification('Пустую связку добавлять незачем', 'warning');
        if (!правимПункт) {
            $('#текстМодал').close();
            return положить('note', текст);
        }
        const ок = await записать(Layout.db.from('worship_kit_items')
            .update({ note: текст }).eq('id', правимПункт.id), 'Пункт');
        if (!ок) return;
        $('#текстМодал').close();
        await перечитать();
    }

    async function перечитать() {
        if (await загрузить()) { рисоватьШапку(); рисоватьПункты(); рисоватьВыдачи(); window.applyPermissions?.(); }
    }

    function слушать() {
        document.addEventListener('click', async ev => {
            const взять = ev.target.closest('[data-взять]');
            if (взять) return положить(взять.dataset.вид, взять.dataset.взять);

            const добавить = ev.target.closest('[data-добавить]');
            if (добавить) {
                if (добавить.dataset.добавить === 'note') return правитьТекстПункта(null);
                return выбрать(добавить.dataset.добавить);
            }

            const двигать = ev.target.closest('[data-двигать]');
            if (двигать) {
                const i = пункты.findIndex(п => п.id === двигать.dataset.id);
                const j = i + Number(двигать.getAttribute('data-двигать'));
                if (i < 0 || j < 0 || j >= пункты.length) return;
                // переписываем номера подряд, а не меняем местами: после
                // удаления пункта из середины номера совпадают, и обмен
                // значениями тихо ничего не делает
                const порядок = пункты.map(п => п.id);
                [порядок[i], порядок[j]] = [порядок[j], порядок[i]];
                for (const [номер, пид] of порядок.entries()) {
                    if (пункты.find(п => п.id === пид)?.sort_order === номер) continue;
                    const ок = await записать(Layout.db.from('worship_kit_items')
                        .update({ sort_order: номер }).eq('id', пид), 'Порядок');
                    if (!ок) return;
                }
                return перечитать();
            }

            const правитьТекст = ev.target.closest('[data-правитьТекст]');
            if (правитьТекст) {
                const пид = правитьТекст.getAttribute('data-правитьТекст');
                return правитьТекстПункта(пункты.find(x => x.id === пид));
            }

            const выдатьЧ = ev.target.closest('[data-выдать-человеку]');
            if (выдатьЧ) return выдачу('человек',
                выдатьЧ.getAttribute('data-выдать-человеку'), выдатьЧ.dataset.имя);

            const выдатьР = ev.target.closest('[data-выдать-ретриту]');
            if (выдатьР) return выдачу('ретрит', выдатьР.getAttribute('data-выдать-ретриту'),
                выдатьР.dataset.имя);

            const убрать = ev.target.closest('[data-убрать]');
            if (убрать) {
                if (!await спросить('Убрать пункт из подборки?')) return;
                const { error } = await Layout.db.from('worship_kit_items')
                    .delete().eq('id', убрать.dataset.убрать);
                if (error) return Layout.handleError(error, 'Пункт');
                return перечитать();
            }

            const отозвать = ev.target.closest('[data-отозвать]');
            if (отозвать) {
                if (!await спросить('Отозвать выдачу?',
                    'Доступ к содержимому закроется сразу.')) return;
                const { error } = await Layout.db.rpc('worship_kit_revoke',
                    { p_grant: отозвать.dataset.отозвать });
                if (error) return Layout.handleError(error, 'Отзыв выдачи');
                return перечитать();
            }

            const b = ev.target.closest('button');
            if (!b) return;
            if (b.id === 'пСохранить') return сохранитьПодборку();
            if (b.id === 'тСохранить') return сохранитьТекстПункта();
            if (b.id === 'печать') return print();
            if (b.id === 'выдатьЧеловеку') return выдать('человек');
            if (b.id === 'выдатьРетриту') return выдать('ретрит');
            if (b.id === 'включение') {
                const ок = await записать(Layout.db.from('worship_kits')
                    .update({ is_active: !подборка.is_active, updated_at: new Date().toISOString(),
                              updated_by: window.currentUser?.id || null }).eq('id', id), 'Подборка');
                if (ок) return перечитать();
                return;
            }
            if (b.id === 'правка') return правитьПодборку();
        });
    }

    async function init() {
        слушать();
        if (!await загрузить()) {
            setTimeout(() => location.href = 'kits.html', 1500);
            return;
        }
        рисоватьШапку();
        рисоватьПункты();
        рисоватьВыдачи();
        window.applyPermissions?.();
    }

    return { init };
})();
