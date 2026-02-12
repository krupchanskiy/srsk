// Утилиты для работы с модальными окнами
// Общие функции для <dialog> элементов

window.ModalUtils = {
    // Открыть модалку по id
    open(modalId) {
        const modal = document.getElementById(modalId);
        if (modal && typeof modal.showModal === 'function') {
            modal.showModal();
        }
    },

    // Закрыть модалку по id
    close(modalId) {
        const modal = document.getElementById(modalId);
        if (modal && typeof modal.close === 'function') {
            modal.close();
        }
    },

    // Переключить модалку
    toggle(modalId) {
        const modal = document.getElementById(modalId);
        if (modal) {
            if (modal.open) {
                modal.close();
            } else {
                modal.showModal();
            }
        }
    },

    // Настроить закрытие по клику на backdrop
    setupBackdropClose(modalId) {
        const modal = document.getElementById(modalId);
        if (!modal) return;

        modal.addEventListener('click', (e) => {
            // Клик на сам dialog (backdrop), а не на содержимое
            if (e.target === modal) {
                modal.close();
            }
        });
    },

    // Настроить закрытие по Escape (обычно работает по умолчанию)
    setupEscapeClose(modalId) {
        const modal = document.getElementById(modalId);
        if (!modal) return;

        modal.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                modal.close();
            }
        });
    },

    // Настроить всё: backdrop + escape
    setup(modalId) {
        this.setupBackdropClose(modalId);
    },

    // Настроить несколько модалок сразу
    setupAll(modalIds) {
        modalIds.forEach(id => this.setup(id));
    },

    // Найти и настроить все dialog на странице
    setupAllDialogs() {
        const dialogs = document.querySelectorAll('dialog');
        dialogs.forEach(dialog => {
            if (dialog.id) {
                this.setup(dialog.id);
            }
        });
    },

    // Проверить, открыта ли модалка
    isOpen(modalId) {
        const modal = document.getElementById(modalId);
        return modal?.open || false;
    },

    // Получить текущую открытую модалку (первую найденную)
    getOpen() {
        const dialogs = document.querySelectorAll('dialog[open]');
        return dialogs.length > 0 ? dialogs[0] : null;
    },

    // Закрыть все открытые модалки
    closeAll() {
        const dialogs = document.querySelectorAll('dialog[open]');
        dialogs.forEach(dialog => dialog.close());
    },

    // Подтверждение действия через модалку
    async confirm(message, title = null) {
        return new Promise((resolve) => {
            // Создаём временную модалку
            const modal = document.createElement('dialog');
            modal.className = 'modal';
            modal.innerHTML = `
                <div class="modal-box">
                    ${title ? `<h3 class="font-bold text-lg">${title}</h3>` : ''}
                    <p class="py-4">${message}</p>
                    <div class="modal-action">
                        <button class="btn" data-action="cancel">Отмена</button>
                        <button class="btn btn-primary" data-action="confirm">OK</button>
                    </div>
                </div>
            `;

            modal.querySelector('[data-action="cancel"]').onclick = () => {
                modal.close();
                modal.remove();
                resolve(false);
            };

            modal.querySelector('[data-action="confirm"]').onclick = () => {
                modal.close();
                modal.remove();
                resolve(true);
            };

            modal.addEventListener('click', (e) => {
                if (e.target === modal) {
                    modal.close();
                    modal.remove();
                    resolve(false);
                }
            });

            document.body.appendChild(modal);
            modal.showModal();
        });
    },

    // Показать информационную модалку
    alert(message, title = null) {
        return new Promise((resolve) => {
            const modal = document.createElement('dialog');
            modal.className = 'modal';
            modal.innerHTML = `
                <div class="modal-box">
                    ${title ? `<h3 class="font-bold text-lg">${title}</h3>` : ''}
                    <p class="py-4">${message}</p>
                    <div class="modal-action">
                        <button class="btn btn-primary" data-action="ok">OK</button>
                    </div>
                </div>
            `;

            const close = () => {
                modal.close();
                modal.remove();
                resolve();
            };

            modal.querySelector('[data-action="ok"]').onclick = close;
            modal.addEventListener('click', (e) => {
                if (e.target === modal) close();
            });

            document.body.appendChild(modal);
            modal.showModal();
        });
    }
};
