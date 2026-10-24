// ==================== РАЗДЕЛ «ДЕПАРТАМЕНТЫ» ====================
// Решение ВГ 18.10.2026: все департаменты — в одном разделе, а не модулем каждый.
// departments/index.html — плитки (финансисты видят все, остальные — свои: глава
// и люди из списка «Кто видит департамент»); один департамент — сразу его страница.
// departments/account.html?d=<id|code> — страница департамента: пока «Счёт» (DeptAccount).
// Какие департаменты видит человек — решает сервер (fin_my_departments, мигр. 704).
window.DeptPages = (function() {
'use strict';

const t = key => Layout.t(key);
const e = str => Layout.escapeHtml(str);
const tr = (key, fallback) => { const v = t(key); return v === key ? fallback : v; };
const $ = id => document.getElementById(id);

// Департаменты, у которых есть свой рабочий модуль: ссылка «Открыть модуль»
const WORK_MODULES = {
    kitchen: { href: '../kitchen/menu.html', perms: ['view_menu', 'view_recipes', 'view_products', 'view_stock'] },
    shop: { href: '../shop/till.html', perms: ['shop_sell', 'shop_manage', 'shop_receive'] },
    worship: { href: '../worship/index.html', perms: ['worship_view'] }
};

// У департамента со своим модулем «Счёт» живёт в самом модуле (ВГ 24.10): всё о департаменте —
// в одном месте. Плитка ведёт туда; Кафе — та же страница Кухни, локация «Кухня кафе»
const MODULE_ACCOUNT = {
    kitchen: '../kitchen/account.html?d=kitchen',
    cafe: '../kitchen/account.html?d=cafe',
    shop: '../shop/account.html',
    worship: '../worship/account.html'
};
const accountHref = d => MODULE_ACCOUNT[d.code] || `account.html?d=${encodeURIComponent(d.id)}`;

async function loadMine() {
    const { data, error } = await Layout.db.rpc('fin_my_departments');
    if (error) { Layout.handleError(error, 'Департаменты'); return []; }
    return data || [];
}

const dot = color => Utils.isValidColor(color)
    ? `<span class="inline-block w-3 h-3 rounded-full shrink-0" style="background:${color}"></span>` : '';

// ---------- плитки ----------
async function initList() {
    await Layout.init({ module: 'departments', menuId: 'departments', itemId: 'departments' });
    const list = await loadMine();
    if (list.length === 1) { location.replace(accountHref(list[0])); return; }
    const box = $('deptTiles');
    if (!list.length) {
        $('deptEmpty').classList.remove('hidden');
        box.innerHTML = '';
        return;
    }
    box.innerHTML = list.map(d => `
        <a href="${e(accountHref(d))}"
           class="card bg-base-100 shadow-sm hover:shadow-md transition-shadow border-l-4"
           style="border-left-color:${Utils.isValidColor(d.color) ? d.color : '#d1d5db'}">
            <div class="card-body p-4 gap-1">
                <h2 class="card-title text-lg">${dot(d.color)}${e(d.name)}</h2>
                <div class="text-sm opacity-70">${d.head_name ? e(d.head_name) : e(tr('dept_no_head', 'Глава не назначен'))}</div>
                ${d.accounts ? '' : `<div class="text-xs opacity-60">${e(tr('dacc_no_accounts', 'У департамента пока нет счёта'))}</div>`}
            </div>
        </a>`).join('');
}

// ---------- страница департамента ----------
async function initAccount() {
    const d = new URLSearchParams(location.search).get('d');
    if (!d) { location.replace('index.html'); return; }
    if (MODULE_ACCOUNT[d]) { location.replace(MODULE_ACCOUNT[d]); return; }   // старая ссылка по коду
    await DeptAccount.init({ department: d, module: 'departments', menuId: 'departments', itemId: 'departments' });
    const list = await loadMine();
    const dept = list.find(x => x.id === d || x.code === d);
    if (!dept) return;   // чужой департамент — DeptAccount уже показал «нет доступа»
    if (MODULE_ACCOUNT[dept.code]) { location.replace(MODULE_ACCOUNT[dept.code]); return; }
    document.title = `${dept.name} — ШРСК`;
    $('deptName').textContent = dept.name;
    $('deptDot').innerHTML = dot(dept.color);
    // несколько департаментов — назад к плиткам и быстрый переход к соседнему
    if (list.length > 1) {
        $('deptBack').classList.remove('hidden');
        const sw = $('deptSwitch');
        sw.innerHTML = list.map(x => `<option value="${e(x.id)}" ${x.id === dept.id ? 'selected' : ''}>${e(x.name)}</option>`).join('');
        sw.classList.remove('hidden');
        sw.addEventListener('change', () => { location.href = accountHref(list.find(x => x.id === sw.value)); });
    }
    const mod = WORK_MODULES[dept.code];
    if (mod && mod.perms.some(p => window.hasPermission?.(p))) {
        $('deptModule').href = mod.href;
        $('deptModule').classList.remove('hidden');
    }
}

// ---------- «Счёт» внутри модуля департамента (kitchen|shop|worship/account.html) ----------
async function initModuleAccount({ code, module, menuId }) {
    await DeptAccount.init({ department: code, module, menuId, itemId: 'dept_account' });
    const dept = (await loadMine()).find(x => x.code === code);
    if (!dept) return;
    document.title = `${tr('nav_dept_account', 'Счёт')}: ${dept.name} — ШРСК`;
    $('deptName').textContent = dept.name;
    $('deptDot').innerHTML = dot(dept.color);
}

return { initList, initAccount, initModuleAccount };
})();
