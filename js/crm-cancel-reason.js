// Причина отказа (мигр. 675): без неё база не пустит сделку в «Отказ».
// CrmCancelReason.ask(count) → { cancellation_reason_id, cancellation_note } или null, если передумали
const CrmCancelReason = {
    _reasons: null,

    async ask(count = 1) {
        if (!this._reasons) {
            const { data, error } = await Layout.db.from('crm_cancellation_reasons')
                .select('id, code, name_ru, name_en, name_hi').order('sort_order');
            if (error) { Layout.handleError(error, 'Причины отказа'); return null; }
            this._reasons = data || [];
        }
        const esc = s => Layout.escapeHtml(s);
        return new Promise(resolve => {
            const dlg = document.createElement('dialog');
            dlg.className = 'modal';
            dlg.innerHTML = `
                <div class="modal-box max-w-sm">
                    <h3 class="font-bold text-lg mb-1">Причина отказа</h3>
                    ${count > 1 ? `<p class="text-sm opacity-70 mb-2">Для всех выбранных сделок: ${count}</p>` : ''}
                    <form class="space-y-2">
                        <div class="space-y-1">
                            ${this._reasons.map(r => `
                                <label class="flex items-center gap-2 cursor-pointer text-sm">
                                    <input type="radio" name="reason" value="${r.id}" data-code="${esc(r.code)}" class="radio radio-sm" required>
                                    ${esc(Layout.getName(r))}
                                </label>`).join('')}
                        </div>
                        <textarea name="note" class="textarea textarea-bordered textarea-sm w-full" rows="2"
                            placeholder="Комментарий (для «Другое» — обязательно)"></textarea>
                        <div class="modal-action">
                            <button type="button" class="btn btn-sm" data-act="back">Назад</button>
                            <button type="submit" class="btn btn-sm btn-error">Сохранить отказ</button>
                        </div>
                    </form>
                </div>`;
            document.body.appendChild(dlg);
            let result = null;
            const form = dlg.querySelector('form');
            const note = form.elements.note;
            note.addEventListener('input', () => note.setCustomValidity(''));
            form.addEventListener('submit', ev => {
                ev.preventDefault();
                const picked = form.querySelector('input[name="reason"]:checked');
                if (!picked) return;
                if (picked.dataset.code === 'other' && !note.value.trim()) {
                    note.setCustomValidity('Напишите, почему отказался');
                    note.reportValidity();
                    return;
                }
                result = { cancellation_reason_id: picked.value, cancellation_note: note.value.trim() || null };
                dlg.close();
            });
            dlg.querySelector('[data-act="back"]').addEventListener('click', () => dlg.close());
            dlg.addEventListener('close', () => { dlg.remove(); resolve(result); });
            dlg.showModal();
        });
    }
};
