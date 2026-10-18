/**
 * Теги: показ и правка на карточке чего угодно.
 *
 * Словарь один на модуль, поэтому и виджет один: тег «Экадаши» у стандарта,
 * у материала и у набора фотографий — это одна и та же запись, и благодаря
 * этому на странице стандарта честно показывается «по этим тегам есть ещё
 * материалы и фото».
 *
 * Связь хранится двумя полями (статья либо набор), а не «тип плюс номер»:
 * так правило доступа само проверяет, видна ли человеку цель.
 */
const WorshipTags = (() => {
    const e = str => Layout.escapeHtml(str ?? '');

    /**
     * Рисует теги в контейнере и позволяет их править.
     * `цель` — { article_id } либо { album_id }.
     */
    async function нарисовать(контейнер, цель, { можноПравить = false } = {}) {
        if (!контейнер) return;
        const поле = цель.article_id ? 'article_id' : 'album_id';
        const значение = цель.article_id || цель.album_id;
        if (!значение) return;

        const [связи, словарь] = await Promise.all([
            Layout.db.from('worship_tag_links').select('id, tag_id').eq(поле, значение),
            Layout.db.from('worship_tags').select('id, name').order('name'),
        ]);
        if (связи.error) { Layout.handleError(связи.error, 'Теги'); return; }
        // без этой проверки сбой второго запроса давал пустой словарь имён,
        // и все расставленные теги молча исчезали с карточки
        if (словарь.error) { Layout.handleError(словарь.error, 'Словарь тегов'); return; }

        const имена = Object.fromEntries((словарь.data || []).map(т => [т.id, т.name]));
        const свои = (связи.data || []).filter(с => имена[с.tag_id]);

        контейнер.innerHTML = `
            ${свои.map(с => `
                <span class="badge badge-outline gap-1">
                    <a class="link link-hover" href="search.html?tag=${с.tag_id}">${e(имена[с.tag_id])}</a>
                    ${можноПравить ? `<button class="text-error" data-снять="${с.id}" title="Убрать">✕</button>` : ''}
                </span>`).join('')}
            ${можноПравить ? `
                <span class="join">
                    <input list="словарьТегов" class="input input-xs input-bordered w-40 join-item"
                           placeholder="+ тег" data-новыйТег maxlength="60">
                    <button class="btn btn-xs join-item" data-поставитьТег
                            title="Добавить тег">+</button>
                </span>
                <datalist id="словарьТегов">
                    ${(словарь.data || []).map(т => `<option value="${e(т.name)}">`).join('')}
                </datalist>` : ''}
            ${!свои.length && !можноПравить ? '<span class="text-sm opacity-50">тегов нет</span>' : ''}`;

        if (!можноПравить || контейнер.dataset.слушает) return;
        контейнер.dataset.слушает = '1';

        const добавитьИзПоля = async () => {
            const поле2 = контейнер.querySelector('[data-новыйТег]');
            const имя = поле2?.value.trim();
            if (!имя) return;
            поле2.value = '';
            await поставить(цель, имя);
            await нарисовать(контейнер, цель, { можноПравить });
        };

        контейнер.addEventListener('click', async ev => {
            if (ev.target.closest('[data-поставитьТег]')) {
                ev.preventDefault();
                return добавитьИзПоля();
            }
            const снять = ev.target.closest('[data-снять]');
            if (!снять) return;
            const { error } = await Layout.db.from('worship_tag_links')
                .delete().eq('id', снять.dataset.снять);
            if (error) return Layout.handleError(error, 'Тег');
            await нарисовать(контейнер, цель, { можноПравить });
        });

        контейнер.addEventListener('keydown', async ev => {
            if (!ev.target.closest('[data-новыйТег]') || ev.key !== 'Enter') return;
            ev.preventDefault();
            await добавитьИзПоля();
        });
    }

    /** Ставит тег, заводя его в словаре, если такого ещё нет. */
    async function поставить(цель, имя) {
        const { data, error } = await Layout.db.rpc('worship_tag_ensure', { p_name: имя });
        if (error) return Layout.handleError(error, 'Тег');

        const строка = {
            tag_id: data.tag_id,
            article_id: цель.article_id || null,
            album_id: цель.album_id || null,
            created_by: window.currentUser?.id || null,
        };
        const { error: ош } = await Layout.db.from('worship_tag_links').insert(строка);
        // повтор — не ошибка: тег уже стоит
        if (ош && ош.code !== '23505') Layout.handleError(ош, 'Тег');
    }

    /**
     * «По этим тегам есть ещё…»: соседи по тегам, кроме самого объекта.
     * Возвращает { статьи: [...], наборы: [...] }.
     */
    async function соседи(цель, предел = 6) {
        const поле = цель.article_id ? 'article_id' : 'album_id';
        const значение = цель.article_id || цель.album_id;

        const { data: мои } = await Layout.db.from('worship_tag_links')
            .select('tag_id').eq(поле, значение);
        const ids = (мои || []).map(с => с.tag_id);
        if (!ids.length) return { статьи: [], наборы: [] };

        const { data: связи } = await Utils.fetchAll((от, до) =>
            Layout.db.from('worship_tag_links')
                .select('article_id, album_id').in('tag_id', ids).range(от, до));

        const статьиIds = [...new Set((связи || []).map(с => с.article_id)
            .filter(x => x && x !== значение))].slice(0, предел);
        const наборыIds = [...new Set((связи || []).map(с => с.album_id)
            .filter(x => x && x !== значение))].slice(0, предел);

        const [статьи, наборы] = await Promise.all([
            статьиIds.length
                ? Layout.db.from('worship_articles').select('id, title, kind').in('id', статьиIds)
                : Promise.resolve({ data: [] }),
            наборыIds.length
                ? Layout.db.from('worship_albums').select('id, title, event_date').in('id', наборыIds)
                : Promise.resolve({ data: [] }),
        ]);
        return { статьи: статьи.data || [], наборы: наборы.data || [] };
    }

    return { нарисовать, поставить, соседи };
})();
