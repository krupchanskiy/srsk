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
            if (!а) return '';
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
        if (!н) return '';
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
            sort_order: пункты.length,
            created_by: window.currentUser?.id || null,
        };
        if (вид === 'album') строка.album_id = значение;
        else if (вид === 'note') строка.note = значение;
        else строка.article_id = значение;

        const { error } = await Layout.db.from('worship_kit_items').insert(строка);
        if (error) return Layout.handleError(error, 'Пункт подборки');
        $('#выборМодал').close();
        await перечитать();
    }

    // ---------- выдача ----------
    async function выдать(кому) {
        if (кому === 'человек') {
            const имя = prompt('Кому выдаём? Впишите часть имени.');
            if (!имя || !имя.trim()) return;
            const { data } = await Layout.db.from('vaishnavas')
                .select('id, spiritual_name, first_name, last_name')
                .or(`spiritual_name.ilike.%${имя.trim()}%,first_name.ilike.%${имя.trim()}%,last_name.ilike.%${имя.trim()}%`)
                .limit(10);
            if (!data?.length) return Layout.showNotification('Никого не нашлось', 'warning');

            const список = data.map((ч, i) => `${i + 1}. ${
                ч.spiritual_name || `${ч.first_name || ''} ${ч.last_name || ''}`.trim()}`).join('\n');
            const выбор = prompt(`Кому именно?\n${список}\n\nВпишите номер:`);
            const ч = data[Number(выбор) - 1];
            if (!ч) return;

            if (!confirm(`Выдать подборку «${подборка.title}»? Её содержимое увидит ${
                ч.spiritual_name || ч.first_name} — в портале гостя, ещё до приезда.`)) return;

            const { error } = await Layout.db.rpc('worship_kit_grant',
                { p_kit: id, p_vaishnava: ч.id, p_retreat: null });
            if (error) return Layout.handleError(error, 'Выдача подборки');
        } else {
            const { data } = await Layout.db.from('retreats')
                .select('id, name_ru, start_date').order('start_date', { ascending: false }).limit(10);
            if (!data?.length) return Layout.showNotification('Ретритов нет', 'warning');
            const список = data.map((р, i) => `${i + 1}. ${р.name_ru} (${р.start_date})`).join('\n');
            const выбор = prompt(`Какому ретриту?\n${список}\n\nВпишите номер:`);
            const р = data[Number(выбор) - 1];
            if (!р) return;

            if (!confirm(`Выдать подборку всем участникам ретрита «${р.name_ru}»?`)) return;
            const { error } = await Layout.db.rpc('worship_kit_grant',
                { p_kit: id, p_vaishnava: null, p_retreat: р.id });
            if (error) return Layout.handleError(error, 'Выдача подборки');
        }
        await перечитать();
        Layout.showNotification('Выдано', 'success');
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
                if (добавить.dataset.добавить === 'note') {
                    const текст = prompt('Свой текст между пунктами: «сначала прочти это, потом посмотри, как выглядит»');
                    if (!текст || !текст.trim()) return;
                    return положить('note', текст.trim());
                }
                return выбрать(добавить.dataset.добавить);
            }

            const двигать = ev.target.closest('[data-двигать]');
            if (двигать) {
                const i = пункты.findIndex(п => п.id === двигать.dataset.id);
                const j = i + Number(двигать.dataset.двигать);
                if (i < 0 || j < 0 || j >= пункты.length) return;
                // порядок задаёт составитель: меняем местами двумя запросами,
                // пунктов в дорожке единицы
                await Layout.db.from('worship_kit_items')
                    .update({ sort_order: пункты[j].sort_order }).eq('id', пункты[i].id);
                await Layout.db.from('worship_kit_items')
                    .update({ sort_order: пункты[i].sort_order }).eq('id', пункты[j].id);
                return перечитать();
            }

            const правитьТекст = ev.target.closest('[data-правитьТекст]');
            if (правитьТекст) {
                const п = пункты.find(x => x.id === правитьТекст.dataset.правитьтекст
                                        || x.id === правитьТекст.getAttribute('data-правитьТекст'));
                const текст = prompt('Текст между пунктами', п?.note || '');
                if (текст === null || !текст.trim()) return;
                const { error } = await Layout.db.from('worship_kit_items')
                    .update({ note: текст.trim() }).eq('id', п.id);
                if (error) return Layout.handleError(error, 'Пункт');
                return перечитать();
            }

            const убрать = ev.target.closest('[data-убрать]');
            if (убрать) {
                if (!confirm('Убрать пункт из подборки?')) return;
                const { error } = await Layout.db.from('worship_kit_items')
                    .delete().eq('id', убрать.dataset.убрать);
                if (error) return Layout.handleError(error, 'Пункт');
                return перечитать();
            }

            const отозвать = ev.target.closest('[data-отозвать]');
            if (отозвать) {
                if (!confirm('Отозвать выдачу? Доступ к содержимому закроется сразу.')) return;
                const { error } = await Layout.db.rpc('worship_kit_revoke',
                    { p_grant: отозвать.dataset.отозвать });
                if (error) return Layout.handleError(error, 'Отзыв выдачи');
                return перечитать();
            }

            const b = ev.target.closest('button');
            if (!b) return;
            if (b.id === 'печать') return print();
            if (b.id === 'выдатьЧеловеку') return выдать('человек');
            if (b.id === 'выдатьРетриту') return выдать('ретрит');
            if (b.id === 'включение') {
                const { error } = await Layout.db.from('worship_kits')
                    .update({ is_active: !подборка.is_active, updated_at: new Date().toISOString(),
                              updated_by: window.currentUser?.id || null }).eq('id', id);
                if (error) return Layout.handleError(error, 'Подборка');
                return перечитать();
            }
            if (b.id === 'правка') {
                const название = prompt('Название подборки', подборка.title);
                if (название === null || !название.trim()) return;
                const описание = prompt('Описание: для кого и когда', подборка.description || '');
                if (описание === null) return;
                const { error } = await Layout.db.from('worship_kits').update({
                    title: название.trim(), description: описание.trim() || null,
                    updated_at: new Date().toISOString(), updated_by: window.currentUser?.id || null,
                }).eq('id', id);
                if (error) return Layout.handleError(error, 'Подборка');
                return перечитать();
            }
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
