const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const script = html.match(/<script>\s*([\s\S]*?)<\/script>/)[1];

// Execute the complete app with persisted browser storage and a small DOM stub.
// No real accounts or network writes are used by these regression tests.
function launch(savedTab, useCloud = false, storage = new Map()) {
  if (savedTab) storage.set('notice-drawer-tab', savedTab);
  function node(tagName = 'DIV') {
    const listeners = {};
    const attributes = {};
    let text = '';
    return {
      tagName, listeners, children: [], style: {}, value: '', hidden: false,
      classList: { add() {}, remove() {} },
      get textContent() { return text; },
      set textContent(value) { text = value; this.children = []; },
      appendChild(child) { this.children.push(child); return child; },
      setAttribute(key, value) { attributes[key] = value; },
      getAttribute(key) { return attributes[key]; },
      removeAttribute(key) { delete attributes[key]; },
      addEventListener(type, callback) { (listeners[type] ||= []).push(callback); },
      dispatch(type, extra = {}) {
        for (const callback of listeners[type] || []) callback.call(this, { preventDefault() {}, ...extra });
      },
      focus() {}, showModal() { this.open = true; }, close() { this.open = false; }
    };
  }
  const elements = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(match => [match[1], node()]));
  const document = Object.assign(node(), {
    visibilityState: 'visible', documentElement: node('HTML'),
    getElementById: id => {
      assert.ok(elements.has(id), 'Missing element: ' + id);
      return elements.get(id);
    },
    createElement: tag => node(tag.toUpperCase()), querySelectorAll: () => []
  });
  const timers = new Map();
  let nextTimer = 0;
  let authCallback;
  let insideAuthCallback = false;
  const calls = [];
  const user = { id: 'test-user', email: 'test@example.invalid' };
  const remote = { data: { groups: [], links: [], scraps: [], events: [] }, updated_at: '2026-09-20T00:00:00Z' };
  const sb = {
    auth: {
      getSession: () => Promise.resolve({ data: { session: null } }),
      onAuthStateChange: callback => { authCallback = callback; },
      signInWithPassword: () => Promise.resolve({ data: { user } }),
      resetPasswordForEmail: (email, options) => {
        calls.push({ reset: email, options });
        return Promise.resolve({ data: {}, error: null });
      },
      updateUser: attributes => {
        calls.push({ update: attributes });
        return Promise.resolve({ data: { user }, error: null });
      }
    },
    from(table) {
      calls.push({ table, insideAuthCallback });
      return {
        select() { return this; }, eq() { return this; },
        maybeSingle: () => Promise.resolve({ data: remote }),
        upsert(data) { calls.push({ write: data }); return this; },
        single: () => Promise.resolve({ data: { updated_at: remote.updated_at } })
      };
    }
  };
  const window = node();
  if (useCloud) window.supabase = { createClient: () => sb };
  const context = vm.createContext({
    window, document, console, URL, Blob,
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    setTimeout: (callback, delay) => { timers.set(++nextTimer, { callback, delay }); return nextTimer; },
    clearTimeout: id => timers.delete(id)
  });
  vm.runInContext(script, context, { filename: 'index.html' });
  return {
    elements, document, window, storage, calls,
    auth(event, session = { user }) {
      insideAuthCallback = true;
      try { authCallback(event, session); } finally { insideAuthCallback = false; }
    },
    runTimers(delay) {
      for (const [id, timer] of [...timers]) {
        if (timer.delay === delay) { timers.delete(id); timer.callback(); }
      }
    }
  };
}

async function settle() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

for (const tab of ['drawers', 'scraps', 'cal']) {
  test('startup and add buttons with saved tab: ' + tab, () => {
    const app = launch(tab, true);
    app.elements.get('authBtn').dispatch('click');
    assert.equal(app.elements.get('dlgAuth').open, true);
    app.elements.get('addBtn').dispatch('click');
    assert.equal(app.elements.get('dlgLink').open, true);
    app.elements.get('addScrapBtn').dispatch('click');
    assert.equal(app.elements.get('dlgScrap').open, true);
    app.elements.get('addEventBtn').dispatch('click');
    assert.equal(app.elements.get('dlgEvent').open, true);
  });
}

test('calendar survives app restart and still saves new events offline', () => {
  const first = launch('drawers');
  first.elements.get('tabCal').dispatch('click');
  const app = launch(null, false, first.storage);
  assert.equal(app.elements.get('viewCal').hidden, false);
  assert.ok(app.elements.get('calGrid').children.length > 30);
  app.elements.get('addEventBtn').dispatch('click');
  app.elements.get('eTitle').value = 'Resume regression';
  app.elements.get('eDate').value = '2026-10-01';
  app.elements.get('formEvent').dispatch('submit');
  const saved = JSON.parse(app.storage.get('notice-drawer-v1'));
  assert.equal(saved.events[0].title, 'Resume regression');
  const restarted = launch(null, false, app.storage);
  assert.equal(JSON.parse(restarted.storage.get('notice-drawer-v1')).events.length, 1);
});

test('auth callback releases its lock before any cloud query starts', async () => {
  const app = launch('drawers', true);
  await settle();
  app.auth('SIGNED_IN');
  assert.equal(app.calls.length, 0);
  app.runTimers(0);
  await settle();
  assert.equal(app.calls.length, 1);
  assert.equal(app.calls[0].insideAuthCallback, false);
});

test('forgot password sends a reset mail that returns to the app', async () => {
  const app = launch('drawers', true);
  app.elements.get('authBtn').dispatch('click');
  app.elements.get('authForgot').dispatch('click');
  assert.equal(app.calls.some(call => call.reset), false);
  app.elements.get('authEmail').value = ' test@example.invalid ';
  app.elements.get('authForgot').dispatch('click');
  await settle();
  const sent = app.calls.find(call => call.reset);
  assert.equal(sent.reset, 'test@example.invalid');
  assert.match(sent.options.redirectTo, /^https:\/\//);
  assert.equal(app.elements.get('authForgot').disabled, false);
});

test('reset mail link opens the new password dialog and saves it', async () => {
  const app = launch('drawers', true);
  await settle();
  app.auth('PASSWORD_RECOVERY');
  app.runTimers(0);
  assert.equal(app.elements.get('dlgReset').open, true);
  app.elements.get('resetPassword').value = 'newpass1';
  app.elements.get('resetPassword2').value = 'different';
  app.elements.get('formReset').dispatch('submit');
  assert.equal(app.calls.some(call => call.update), false);
  app.elements.get('resetPassword2').value = 'newpass1';
  app.elements.get('formReset').dispatch('submit');
  await settle();
  assert.equal(app.calls.find(call => call.update).update.password, 'newpass1');
  assert.equal(app.elements.get('dlgReset').open, false);
});
