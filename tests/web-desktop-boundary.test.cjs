const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('public BackOffice has no AB Kitchen entry point', () => {
    assert.equal(fs.existsSync(path.join(root, 'ab-kitchen', 'index.html')), false);
    assert.doesNotMatch(read('index.html'), /srsk_ab_kitchen_context|\/ab-kitchen\//);
    assert.doesNotMatch(read('js/auth-check.js'), /AB_KITCHEN_ENTRY_PATH|srsk_ab_kitchen_context/);
});

test('web location selector excludes the desktop-only kitchen', () => {
    const layout = read('js/layout.js');
    assert.match(layout, /const AB_KITCHEN_SLUG = 'ab-kitchen'/);
    assert.match(layout, /data\.filter\(loc => loc\.slug !== AB_KITCHEN_SLUG\)/);
    assert.doesNotMatch(layout, /isAbKitchenContext|srsk_ab_kitchen_context/);
});

test('legacy AB Kitchen redirects are rejected by browser auth flows', () => {
    for (const relative of [
        'guest-portal/login/index.html',
        'guest-portal/auth-callback/index.html',
        'guest-portal/reset-password/index.html'
    ]) {
        assert.match(read(relative), /redirect\.startsWith\('\/ab-kitchen\/'\)\) return ''/);
        assert.doesNotMatch(read(relative), /has_ab_kitchen_access|srsk_ab_kitchen_context/);
    }
});

test('shared database contracts required by the desktop app remain versioned', () => {
    assert.equal(fs.existsSync(path.join(root, 'supabase', '280_ab_kitchen_hidden_location.sql')), true);
    assert.equal(fs.existsSync(path.join(root, 'supabase', '367_ab_kitchen_admin.sql')), true);
});
