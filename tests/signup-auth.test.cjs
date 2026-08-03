const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadSignupAuth() {
    const source = fs.readFileSync(path.join(__dirname, '..', 'js', 'signup-auth.js'), 'utf8');
    const context = vm.createContext({ window: {} });
    new vm.Script(source, { filename: 'signup-auth.js' }).runInContext(context);
    return context.window.SignupAuth;
}

test('continues an interrupted registration when the existing password is correct', async () => {
    let signUpCalled = false;
    const db = {
        auth: {
            signInWithPassword: async ({ email, password }) => {
                assert.equal(email, 'user@example.com');
                assert.equal(password, 'secret123');
                return { data: { user: { id: 'existing-user' }, session: { access_token: 'token' } }, error: null };
            },
            signUp: async () => {
                signUpCalled = true;
                throw new Error('signUp must not be called');
            }
        }
    };

    const result = await loadSignupAuth().ensureUser(db, {
        email: ' User@Example.com ',
        password: 'secret123'
    });

    assert.equal(result.user.id, 'existing-user');
    assert.equal(result.recovered, true);
    assert.equal(signUpCalled, false);
});

test('creates a new Auth user after an invalid-credentials sign-in', async () => {
    const db = {
        auth: {
            signInWithPassword: async () => ({
                data: { user: null, session: null },
                error: { code: 'invalid_credentials', message: 'Invalid login credentials' }
            }),
            signUp: async ({ email, options }) => {
                assert.equal(email, 'new@example.com');
                assert.equal(options.data.full_name, 'New User');
                return {
                    data: {
                        user: { id: 'new-user', identities: [{ id: 'identity' }] },
                        session: { access_token: 'token' }
                    },
                    error: null
                };
            }
        }
    };

    const result = await loadSignupAuth().ensureUser(db, {
        email: 'new@example.com',
        password: 'secret123',
        metadata: { full_name: 'New User' }
    });

    assert.equal(result.user.id, 'new-user');
    assert.equal(result.recovered, false);
});

test('requests password recovery for an existing Auth user with another password', async () => {
    const db = {
        auth: {
            signInWithPassword: async () => ({
                data: { user: null, session: null },
                error: { code: 'invalid_credentials', message: 'Invalid login credentials' }
            }),
            signUp: async () => ({
                data: { user: { id: 'obfuscated-existing-user', identities: [] }, session: null },
                error: null
            })
        }
    };

    await assert.rejects(
        loadSignupAuth().ensureUser(db, { email: 'existing@example.com', password: 'wrong-password' }),
        error => error.code === 'account_exists_password_mismatch'
    );
});

test('does not sign up after a non-credential sign-in failure', async () => {
    let signUpCalled = false;
    const networkError = new Error('Network unavailable');
    const db = {
        auth: {
            signInWithPassword: async () => ({ data: null, error: networkError }),
            signUp: async () => {
                signUpCalled = true;
            }
        }
    };

    await assert.rejects(
        loadSignupAuth().ensureUser(db, { email: 'user@example.com', password: 'secret123' }),
        networkError
    );
    assert.equal(signUpCalled, false);
});
