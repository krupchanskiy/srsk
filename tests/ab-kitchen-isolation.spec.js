const { test, expect } = require('playwright/test');
const fs = require('node:fs');
const path = require('node:path');

const AB_CONTEXT_KEY = 'srsk_ab_kitchen_context';

function authMockScript({ abAccess = true, mainAccess = true, isSuperuser = true } = {}) {
  return `
    (() => {
      const user = { id: 'admin-1', email: 'admin@example.test' };
      const vaishnava = {
        id: 'person-1', spiritual_name: 'Администратор', first_name: null,
        last_name: null, photo_url: null, user_type: 'staff',
        approval_status: 'approved', is_superuser: ${isSuperuser}, is_active: true
      };
      const resultFor = table => table === 'vaishnavas'
        ? { data: vaishnava, error: null }
        : table === 'permissions'
          ? { data: [{ code: 'view_menu' }, { code: 'view_stock' }], error: null }
          : { data: [], error: null };
      const query = table => {
        const q = {
          select() { return q; },
          eq() { return q; },
          maybeSingle() { return Promise.resolve(resultFor(table)); },
          single() { return Promise.resolve(resultFor(table)); },
          then(resolve) { return Promise.resolve(resultFor(table)).then(resolve); }
        };
        return q;
      };
      const client = {
        auth: {
          getSession: async () => ({ data: { session: { user, access_token: 'test-token' } }, error: null }),
          signOut: async () => ({ error: null })
        },
        from: table => query(table),
        rpc: async name => {
          if (name === 'has_ab_kitchen_access') return { data: ${abAccess}, error: null };
          if (name === 'has_main_backoffice_access') return { data: ${mainAccess}, error: null };
          return { data: [], error: null };
        }
      };
      window.supabase = { createClient: () => client };
      window.debug = () => {};
    })();
  `;
}

async function seedAbContext(page) {
  await page.route('**/seed-ab-context', route => route.fulfill({
    contentType: 'text/html',
    body: '<!doctype html><title>seed</title>'
  }));
  await page.goto('/seed-ab-context');
  await page.evaluate(key => sessionStorage.setItem(key, '1'), AB_CONTEXT_KEY);
}

async function installSyntheticProtectedPage(page, pathPattern, authOptions) {
  await page.route(pathPattern, route => route.fulfill({
    contentType: 'text/html',
    body: `<!doctype html><html><body><main id="protected-content">Общий BackOffice</main>
      <script>${authMockScript(authOptions)}</script>
      <script src="/js/config.js?v=4"></script>
      <script src="/js/auth-check.js?v=8"></script>
    </body></html>`
  }));
}

test.describe('AB Kitchen — граница маршрутов', () => {
  test('ABK-ISO-002: прямой URL общего профиля возвращает в AB Kitchen', async ({ page }) => {
    await seedAbContext(page);
    await installSyntheticProtectedPage(page, '**/vaishnavas/person.html*');
    await page.route('**/ab-kitchen/', route => route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><title>AB Kitchen sentinel</title><main id="ab-entry">AB Kitchen</main>'
    }));

    await page.goto('/vaishnavas/person.html?id=fixture-person');

    await expect(page).toHaveURL(/\/ab-kitchen\/$/);
    await expect(page.locator('#ab-entry')).toHaveText('AB Kitchen');
    expect(await page.evaluate(key => sessionStorage.getItem(key), AB_CONTEXT_KEY)).toBe('1');
  });

  test('ABK-ISO-002: общая главная не выключает AB-контекст', async ({ page }) => {
    await page.route('https://**/*', route => route.fulfill({ status: 204, body: '' }));
    await page.addInitScript(authMockScript());
    await seedAbContext(page);
    await page.route('**/ab-kitchen/', route => route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><title>AB Kitchen sentinel</title><main id="ab-entry">AB Kitchen</main>'
    }));

    await page.goto('/index.html');

    await expect(page).toHaveURL(/\/ab-kitchen\/$/);
    expect(await page.evaluate(key => sessionStorage.getItem(key), AB_CONTEXT_KEY)).toBe('1');
  });

  test('ABK-ISO-003: разрешённый маршрут кухни не блокируется', async ({ page }) => {
    await seedAbContext(page);
    await installSyntheticProtectedPage(page, '**/kitchen/menu.html');

    await page.goto('/kitchen/menu.html');
    await page.waitForFunction(() => Boolean(window.currentUser));

    await expect(page).toHaveURL(/\/kitchen\/menu\.html$/);
    await expect(page.locator('#protected-content')).toBeVisible();
  });

  test('ABK-AUTH-003: пользователь без AB-роли получает понятный отказ', async ({ page }) => {
    await seedAbContext(page);
    await installSyntheticProtectedPage(page, '**/kitchen/menu.html', {
      abAccess: false,
      mainAccess: true,
      isSuperuser: false
    });

    await page.goto('/kitchen/menu.html');

    await expect(page).toHaveURL(/\/ab-kitchen\/access-denied\.html$/);
    await expect(page.getByRole('heading', { name: 'Нет доступа к AB Kitchen' })).toBeVisible();
  });
});

async function renderLayout(page, isAbContext, hostPath = '/layout-host') {
  await page.route('**/layout-host', route => route.fulfill({
    contentType: 'text/html',
    body: '<!doctype html><html><body><div id="header-placeholder"></div><main></main><div id="footer-placeholder"></div></body></html>'
  }));
  await page.goto(hostPath);
  await page.evaluate(({ isAbContext, contextKey }) => {
    sessionStorage.clear();
    localStorage.clear();
    if (isAbContext) sessionStorage.setItem(contextKey, '1');
    localStorage.setItem('srsk_location', 'main');
    window.currentUser = {
      id: 'admin-1', email: 'admin@example.test', name: 'Администратор',
      is_superuser: true, vaishnava_id: 'person-1', permissions: ['*']
    };
    window.hasPermission = () => true;
    window.Cache = { getOrLoad: async (_key, loader) => loader(), invalidate: () => {} };
    window.Utils = { pluralize: () => '', debounce: fn => fn, escapeHtml: value => String(value ?? '') };
    window.Translit = { ru: value => value, hi: value => value };
    window.AutoTranslate = { translate: async value => value, setup: () => {}, reset: () => {} };
    window.debug = () => {};
    window.lucide = { createIcons: () => {} };
    const requiredKeys = ['self_accommodation', 'nav_user_management', 'nav_retreat_prasad', 'purchased', 'nav_residents_list', 'nav_prasad'];
    const translations = requiredKeys.map(key => ({ key, ru: key, en: key, hi: key }));
    const locations = [
      { id: 'main-id', slug: 'main', name_ru: 'Основная кухня', name_en: 'Main', name_hi: 'Main', color: '#111111' },
      { id: 'ab-id', slug: 'ab-kitchen', name_ru: 'AB Kitchen', name_en: 'AB Kitchen', name_hi: 'AB Kitchen', color: '#f49800' }
    ];
    window.supabaseClient = {
      from: table => ({
        select: () => {
          if (table === 'translations') return { range: async () => ({ data: translations, error: null }) };
          if (table === 'locations') return Promise.resolve({ data: locations, error: null });
          return Promise.resolve({ data: [], error: null });
        }
      }),
      auth: { signOut: async () => ({ error: null }) }
    };
  }, { isAbContext, contextKey: AB_CONTEXT_KEY });
  await page.addScriptTag({ url: '/js/layout.js?v=40' });
  await page.evaluate(() => Layout.init({ module: 'kitchen', menuId: 'kitchen', itemId: 'menu' }));
}

test.describe('AB Kitchen — оболочка навигации', () => {
  test('ABK-ISO-001: в AB-оболочке нет команды, профиля и общих модулей', async ({ page }) => {
    await renderLayout(page, true, '/kitchen/layout-host');

    const hrefs = await page.locator('header a, footer a, #mobileMenu a').evaluateAll(links =>
      links.map(link => link.getAttribute('href')).filter(Boolean)
    );
    expect(hrefs.some(href => href.includes('vaishnavas/team.html'))).toBe(false);
    expect(hrefs.some(href => /(?:vaishnavas|placement|reception|crm|finance|photos|settings|ashram|guest-portal)\//.test(href))).toBe(false);

    const authSource = fs.readFileSync(path.resolve(__dirname, '..', 'js', 'auth-check.js'), 'utf8');
    const renderedPageUrl = page.url();
    for (const href of hrefs.filter(href => !href.startsWith('#'))) {
      const pathname = new URL(href, renderedPageUrl).pathname.replace(/\/$/, '') || '/';
      expect(authSource, `${pathname} должен быть разрешён защитой маршрутов`).toContain(`'${pathname}'`);
    }

    await expect(page.locator('.avatar-link')).toHaveCount(0);
    expect(await page.evaluate(() => Layout.currentLocation)).toBe('ab-kitchen');
  });

  test('ABK-NORMAL-001: обычная оболочка остаётся без AB-ограничений', async ({ page }) => {
    await renderLayout(page, false);

    const hrefs = await page.locator('header a, footer a, #mobileMenu a').evaluateAll(links =>
      links.map(link => link.getAttribute('href')).filter(Boolean)
    );
    expect(hrefs.some(href => href.includes('vaishnavas/team.html'))).toBe(true);
    await expect(page.locator('.avatar-link')).toHaveCount(2);
    expect(await page.evaluate(() => Layout.locations.map(location => location.slug))).toEqual(['main']);
  });
});

test.describe('AB Kitchen — контракты изоляции данных', () => {
  const repoRoot = path.resolve(__dirname, '..');

  test('ABK-DATA-001: поступления и их изменения ограничены location_id', () => {
    const source = fs.readFileSync(path.join(repoRoot, 'stock', 'receive.html'), 'utf8');
    expect(source).toMatch(/from\('stock_receipts'\)[\s\S]{0,400}\.eq\('location_id',\s*locationId\)/);
    expect(source).toMatch(/from\('stock_receipts'\)\.update\(\{ archived: true \}\)\.eq\('id', id\)\.eq\('location_id', locationId\)/);
    expect(source).toMatch(/from\('stock_receipts'\)\.delete\(\)\.eq\('id', id\)\.eq\('location_id', locationId\)/);
  });

  test('ABK-DATA-002: чтение и изменение рецептов ограничены location_id', () => {
    const viewSource = fs.readFileSync(path.join(repoRoot, 'kitchen', 'recipe.html'), 'utf8');
    const editSource = fs.readFileSync(path.join(repoRoot, 'kitchen', 'recipe-edit.html'), 'utf8');
    const requestsSource = fs.readFileSync(path.join(repoRoot, 'js', 'pages', 'stock-requests.js'), 'utf8');
    const receiveSource = fs.readFileSync(path.join(repoRoot, 'stock', 'receive.html'), 'utf8');
    const issueSource = fs.readFileSync(path.join(repoRoot, 'stock', 'issue.html'), 'utf8');
    expect(viewSource).toMatch(/from\('recipes'\)[\s\S]{0,300}\.eq\('id', id\)[\s\S]{0,100}\.eq\('location_id', locationId\)/);
    expect(editSource).toMatch(/from\('recipes'\)[\s\S]{0,250}\.eq\('id', id\)[\s\S]{0,100}\.eq\('location_id', locationId\)/);
    expect(editSource).toMatch(/from\('recipes'\)\.update\(recipeData\)\.eq\('id', recipeId\)\.eq\('location_id', locationId\)/);
    expect(editSource).toMatch(/from\('recipes'\)\.delete\(\)\.eq\('id', recipeId\)\.eq\('location_id', locationId\)/);
    expect(requestsSource).toMatch(/from\('recipes'\)[\s\S]{0,180}\.eq\('location_id', locationId\)/);
    expect(receiveSource).toMatch(/function loadMenuRecipes\(\)[\s\S]{0,500}\.from\('recipes'\)[\s\S]{0,180}\.eq\('location_id', locationId\)/);
    expect(issueSource).toMatch(/function loadMenuRecipes\(\)[\s\S]{0,500}\.from\('recipes'\)[\s\S]{0,180}\.eq\('location_id', locationId\)/);
  });

  test('ABK-DATA-003: все операционные документы изменяются только в текущей локации', () => {
    const requestsSource = fs.readFileSync(path.join(repoRoot, 'js', 'pages', 'stock-requests.js'), 'utf8');
    const issueSource = fs.readFileSync(path.join(repoRoot, 'stock', 'issue.html'), 'utf8');
    const inventorySource = fs.readFileSync(path.join(repoRoot, 'stock', 'inventory.html'), 'utf8');
    const templatesSource = fs.readFileSync(path.join(repoRoot, 'kitchen', 'menu-templates.html'), 'utf8');

    const expectEveryMutationScoped = (source, table) => {
      const chains = [...source.matchAll(new RegExp(`\\.from\\('${table}'\\)([\\s\\S]*?);`, 'g'))]
        .map(match => match[0])
        .filter(chain => chain.includes('.update(') || chain.includes('.delete()'));

      expect(chains.length, `Для ${table} должны быть операции изменения`).toBeGreaterThan(0);
      for (const chain of chains) {
        expect(chain, `Операция ${table} должна быть ограничена location_id`)
          .toMatch(/\.eq\('location_id',\s*locationId\)/);
      }
    };

    expectEveryMutationScoped(requestsSource, 'purchase_requests');
    expectEveryMutationScoped(issueSource, 'stock_issuances');
    expectEveryMutationScoped(inventorySource, 'stock_inventories');
    expectEveryMutationScoped(templatesSource, 'menu_templates');
  });

  test('ABK-DATA-004: меню и блюда изменяются только внутри текущей кухни', () => {
    const menuSource = fs.readFileSync(path.join(repoRoot, 'js', 'pages', 'kitchen-menu.js'), 'utf8');
    const boardSource = fs.readFileSync(path.join(repoRoot, 'js', 'pages', 'kitchen-menu-board.js'), 'utf8');

    const mealMutations = [...menuSource.matchAll(/\.from\('menu_meals'\)([\s\S]*?);/g)]
      .map(match => match[0])
      .filter(chain => chain.includes('.update(') || chain.includes('.delete()'));
    expect(mealMutations.length).toBeGreaterThan(0);
    for (const chain of mealMutations) {
      expect(chain).toMatch(/\.eq\('location_id',\s*locationId\)/);
    }

    const dishMutations = [menuSource, boardSource]
      .flatMap(source => [...source.matchAll(/\.from\('menu_dishes'\)([\s\S]*?);/g)])
      .map(match => match[0])
      .filter(chain => chain.includes('.update(') || chain.includes('.delete()'));
    expect(dishMutations.length).toBeGreaterThan(0);
    for (const chain of dishMutations) {
      expect(chain).toMatch(/\.eq\('meal_id',\s*(?:currentMeal|mealData|sourceMeal)\.id\)/);
    }
  });

  test('ABK-DATA-005: migration создаёт роль, привязку локации и location-aware RLS', () => {
    const migration = fs.readFileSync(path.join(repoRoot, 'supabase', '367_ab_kitchen_admin.sql'), 'utf8');
    expect(migration).toContain("'ab_kitchen_admin'");
    expect(migration).toContain("'sasha.kostromin.200@gmail.com'");
    expect(migration).toContain("'a.caytanya@gmail.com'");
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS public.user_locations');
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.has_ab_kitchen_access()');
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.has_main_backoffice_access()');

    const locationTables = [
      'recipes', 'recipe_ingredients', 'menu_meals', 'menu_dishes',
      'menu_templates', 'menu_template_meals', 'menu_template_dishes',
      'stock', 'purchase_requests', 'purchase_request_items',
      'stock_receipts', 'stock_receipt_items', 'stock_issuances',
      'stock_issuance_items', 'stock_inventories', 'stock_inventory_items'
    ];
    for (const table of locationTables) {
      expect(migration, `${table} должен быть защищён RLS`)
        .toContain(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`);
    }
    expect(migration).toContain("bucket_id = 'recipe-photos'");
  });

  test('ABK-AUTH-004: invitation/recovery uses real routes and can be repeated', () => {
    const inviteFunction = fs.readFileSync(
      path.join(repoRoot, 'supabase', 'functions', 'send-invite', 'index.ts'),
      'utf8'
    );
    const callback = fs.readFileSync(path.join(repoRoot, 'guest-portal', 'auth-callback', 'index.html'), 'utf8');
    const reset = fs.readFileSync(path.join(repoRoot, 'guest-portal', 'reset-password', 'index.html'), 'utf8');

    expect(inviteFunction).toContain("mode = 'email'");
    expect(inviteFunction).toContain("type: 'recovery'");
    expect(inviteFunction).toContain("type: 'invite'");
    expect(inviteFunction).toContain("/reset-password/");
    expect(inviteFunction).not.toContain('/guest-portal/auth-callback.html');
    expect(callback).not.toContain("select('is_team')");
    expect(reset).not.toContain("select('is_team')");
    expect(callback).toContain("rpc('has_ab_kitchen_access')");
    expect(reset).toContain("rpc('has_ab_kitchen_access')");
  });
});
