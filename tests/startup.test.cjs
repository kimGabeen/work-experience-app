const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const script = html.match(/<script>\s*([\s\S]*?)<\/script>/)[1];

// Execute the complete app with persisted browser storage and a small DOM stub.
// No real accounts or network writes are used by these regression tests.
// `cloud` is one shared app_state row, so two launches act like two devices on one account.
function newCloud() {
  return { row: { user_id: 'test-user', data: { groups: [], links: [], scraps: [], events: [] }, updated_at: '2026-09-20T00:00:00.000Z' } };
}

function launch(savedTab, useCloud = false, storage = new Map(), cloud = newCloud()) {
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
      const q = { op: 'select', filters: {}, payload: null };
      const copy = value => JSON.parse(JSON.stringify(value));
      const run = () => {
        if (q.op === 'select') return { data: cloud.row ? copy(cloud.row) : null, error: null };
        if (cloud.beforeWrite) { const hook = cloud.beforeWrite; cloud.beforeWrite = null; hook(); }
        calls.push({ write: copy(q.payload), op: q.op });
        if (q.op === 'upsert') {
          cloud.row = { ...(cloud.row || {}), ...copy(q.payload) };
        } else if (q.op === 'insert') {
          if (cloud.row) return { data: null, error: { code: '23505' } };
          cloud.row = copy(q.payload);
        } else {
          // Like `.eq('updated_at', seen)`: matches nothing if another device saved first.
          if (!cloud.row || cloud.row.updated_at !== q.filters.updated_at) return { data: [], error: null };
          Object.assign(cloud.row, copy(q.payload));
        }
        return { data: [{ updated_at: cloud.row.updated_at }], error: null };
      };
      const builder = {
        select() { return builder; },
        eq(key, value) { q.filters[key] = value; return builder; },
        insert(payload) { q.op = 'insert'; q.payload = payload; return builder; },
        update(payload) { q.op = 'update'; q.payload = payload; return builder; },
        upsert(payload) { q.op = 'upsert'; q.payload = payload; return builder; },
        single: () => Promise.resolve(run()).then(result => ({ ...result, data: result.data && result.data[0] })),
        maybeSingle: () => Promise.resolve(run()),
        then: (resolve, reject) => Promise.resolve(run()).then(resolve, reject)
      };
      return builder;
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
    elements, document, window, storage, calls, cloud, timers,
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

async function flush() {
  for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
}

async function signIn(app) {
  await flush();
  app.auth('SIGNED_IN');
  app.runTimers(0);
  await flush();
}

function addLinkVia(app, url, name) {
  app.elements.get('addBtn').dispatch('click');
  app.elements.get('fUrl').value = url;
  app.elements.get('fName').value = name;
  app.elements.get('formLink').dispatch('submit');
}

async function save(app) {
  app.runTimers(650);
  await flush();
}

function cloudLinks(cloud) {
  return cloud.row.data.links.map(link => link.name).sort();
}

function localLinks(app) {
  return JSON.parse(app.storage.get('notice-drawer-v1')).links.map(link => link.name).sort();
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
  assert.ok(app.calls.length >= 1);
  assert.equal(app.calls[0].table, 'app_state');
  assert.ok(app.calls.filter(call => call.table).every(call => call.insideAuthCallback === false));
});

test('a device that has not refreshed does not erase links added on another device', async () => {
  const cloud = newCloud();
  const phone = launch('drawers', true, new Map(), cloud);
  const mac = launch('drawers', true, new Map(), cloud);
  await signIn(phone);
  await signIn(mac);

  addLinkVia(phone, 'https://phone.example.invalid', 'from phone');
  await save(phone);
  assert.deepEqual(cloudLinks(cloud), ['from phone']);

  // The Mac still shows its old list and saves without pulling first.
  addLinkVia(mac, 'https://mac.example.invalid', 'from mac');
  await save(mac);
  assert.deepEqual(cloudLinks(cloud), ['from mac', 'from phone']);
  assert.deepEqual(localLinks(mac), ['from mac', 'from phone']);

  phone.document.dispatch('visibilitychange');
  await flush();
  assert.deepEqual(localLinks(phone), ['from mac', 'from phone']);
  // Default drawers created on each device are not duplicated.
  assert.equal(cloud.row.data.groups.length, 5);
});

function findButtons(app, title) {
  const found = [];
  const walk = node => {
    if (node.title === title) found.push(node);
    (node.children || []).forEach(walk);
  };
  app.elements.forEach(walk);
  return found;
}

function deleteLinkVia(app, name) {
  for (const pen of findButtons(app, '고치기')) {
    pen.dispatch('click');
    if (app.elements.get('fName').value === name) {
      app.elements.get('fDel').dispatch('click');
      return;
    }
  }
  assert.fail('link not found: ' + name);
}

test('deleting on one device removes the link on the other instead of bringing it back', async () => {
  const cloud = newCloud();
  const phone = launch('drawers', true, new Map(), cloud);
  const mac = launch('drawers', true, new Map(), cloud);
  await signIn(phone);
  addLinkVia(phone, 'https://a.example.invalid', 'a');
  addLinkVia(phone, 'https://b.example.invalid', 'b');
  await save(phone);
  await signIn(mac);
  assert.deepEqual(localLinks(mac), ['a', 'b']);

  deleteLinkVia(phone, 'a');
  await save(phone);
  assert.deepEqual(cloudLinks(cloud), ['b']);

  // The Mac still has "a" locally; its next save must not resurrect it.
  addLinkVia(mac, 'https://c.example.invalid', 'c');
  await save(mac);
  assert.deepEqual(cloudLinks(cloud), ['b', 'c']);
  assert.deepEqual(localLinks(mac), ['b', 'c']);
});

test('a save that loses the race re-reads and merges instead of overwriting', async () => {
  const cloud = newCloud();
  const phone = launch('drawers', true, new Map(), cloud);
  await signIn(phone);
  addLinkVia(phone, 'https://mine.example.invalid', 'mine');
  // Another device saves after this device read the row but before it writes.
  cloud.beforeWrite = () => {
    const now = Date.now();
    cloud.row = {
      ...cloud.row,
      data: { ...cloud.row.data, links: [...cloud.row.data.links,
        { id: 'other1', name: 'theirs', url: 'https://theirs.example.invalid', groupId: 'x', memo: '', pinned: true, addedAt: now, updatedAt: now }] },
      updated_at: new Date(Date.parse(cloud.row.updated_at) + 5).toISOString()
    };
  };
  await save(phone);
  assert.equal(cloud.beforeWrite, null);
  assert.deepEqual(cloudLinks(cloud), ['mine', 'theirs']);
  assert.deepEqual(localLinks(phone), ['mine', 'theirs']);
});

test('links added before signing in are kept and uploaded, not replaced by the cloud copy', async () => {
  const cloud = newCloud();
  cloud.row.data.links = [{ id: 'cloud1', name: 'cloud link', url: 'https://cloud.example.invalid', groupId: 'g', memo: '', pinned: true, addedAt: 1 }];
  const phone = launch('drawers', true, new Map(), cloud);
  await flush();
  addLinkVia(phone, 'https://offline.example.invalid', 'offline link');
  await signIn(phone);
  assert.deepEqual(localLinks(phone), ['cloud link', 'offline link']);
  assert.deepEqual(cloudLinks(cloud), ['cloud link', 'offline link']);
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
