'use strict';
/* global SQL, Grid, Editor */

// ============================================================ DOM helpers

const $ = (selector, rootNode = document) => rootNode.querySelector(selector);

function h(tag, props = {}, ...children) {
  const [name, ...classes] = tag.split('.');
  const node = document.createElement(name || 'div');
  if (classes.length) node.className = classes.join(' ');
  for (const [key, value] of Object.entries(props || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = [node.className, value].filter(Boolean).join(' ');
    else if (key === 'text') node.textContent = value;
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (['value', 'checked', 'disabled', 'hidden', 'selected', 'title', 'type', 'placeholder', 'tabIndex', 'spellcheck'].includes(key)) node[key] = value;
    else node.setAttribute(key, value === true ? '' : value);
  }
  if ((name === 'input' || name === 'textarea') && !node.hasAttribute('autocapitalize')) {
    node.setAttribute('autocapitalize', 'off');   // identifiers and SQL, not prose
    node.setAttribute('autocorrect', 'off');
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : String(child));
  }
  return node;
}

const plural = (n, word, many = word + 's') => `${Number(n).toLocaleString()} ${n === 1 ? word : many}`;
const compact = n => n === null || n === undefined ? '' : n >= 1e6 ? (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k' : String(n);
const bytes = n => { n = Number(n); if (!n) return '0 B'; const u = ['B', 'KB', 'MB', 'GB', 'TB']; const i = Math.min(4, Math.floor(Math.log(n) / Math.log(1024))); return (n / 1024 ** i).toFixed(i ? 1 : 0) + ' ' + u[i]; };
const message = error => (error && error.message) || String(error);
const ENV_LABELS = { local: 'Local', development: 'Dev', testing: 'Test', staging: 'Staging', production: 'Prod' };
const envColor = c => c?.color || (c?.environment ? `var(--env-${c.environment})` : 'var(--line-2)');

// ============================================================ UI primitives

const UI = window.UI = {
  layer: null,
  toast(text) {
    const node = $('#toast');
    node.textContent = text;
    node.hidden = false;
    clearTimeout(UI.toastTimer);
    UI.toastTimer = setTimeout(() => { node.hidden = true; }, 2200);
  },

  /** Copies inside the current user gesture; falls back to a dialog after async work. */
  copy(text, { label = 'Copied to clipboard' } = {}) {
    const active = document.activeElement;
    const area = h('textarea', { style: { position: 'fixed', left: '-9999px', top: '0' } });
    area.value = text;
    document.body.append(area);
    area.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    area.remove();
    active?.focus?.({ preventScroll: true });
    if (ok) UI.toast(label);
    else UI.copyDialog(text);
    return ok;
  },

  async copyDialog(text, title = 'Ready to copy') {
    const area = h('textarea.value', { readonly: true, spellcheck: false });
    area.value = text;
    const result = await UI.modal({
      title, text: plural(text.length, 'character'), body: area, wide: true,
      buttons: [{ label: 'Close', value: false }, { label: 'Copy', primary: true, value: true, keep: true,
        run: () => { area.select(); const ok = document.execCommand('copy'); UI.toast(ok ? 'Copied to clipboard' : 'Press ⌘C to copy'); } }],
      focus: area,
    });
    return result;
  },

  closeMenus() { for (const m of UI.layer.querySelectorAll('.menu')) m.remove(); },

  menu(x, y, items, { parent } = {}) {
    if (!parent) UI.closeMenus();
    const menu = h('div.menu', { role: 'menu' });
    for (const item of items) {
      if (item === '-') { if (menu.lastChild && menu.lastChild.tagName !== 'HR') menu.append(h('hr')); continue; }
      if (!item) continue;
      const button = h('button', { role: 'menuitem', class: item.danger ? 'danger' : '', disabled: item.disabled },
        h('span', { text: item.label }), h('span.hint', { text: item.submenu ? '▸' : item.hint || '' }));
      button.addEventListener('click', event => {
        event.stopPropagation();
        if (item.submenu) {
          for (const m of [...UI.layer.querySelectorAll('.menu')].filter(m => m.dataset.depth > (menu.dataset.depth || 0))) m.remove();
          const r = button.getBoundingClientRect();
          UI.menu(r.right - 4, r.top - 4, item.submenu, { parent: menu });
          return;
        }
        UI.closeMenus();
        item.run?.();
      });
      if (item.submenu) button.addEventListener('mouseenter', () => button.click());
      menu.append(button);
    }
    if (menu.lastChild?.tagName === 'HR') menu.lastChild.remove();
    menu.dataset.depth = parent ? Number(parent.dataset.depth || 0) + 1 : 0;
    UI.layer.append(menu);
    const r = menu.getBoundingClientRect();
    menu.style.left = Math.max(4, Math.min(x, innerWidth - r.width - 4)) + 'px';
    menu.style.top = Math.max(4, Math.min(y, innerHeight - r.height - 4)) + 'px';
    menu.querySelector('button:not(:disabled)')?.focus({ preventScroll: true });
    menu.addEventListener('keydown', event => {
      const buttons = [...menu.querySelectorAll('button:not(:disabled)')];
      const i = buttons.indexOf(document.activeElement);
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        buttons[(i + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
      } else if (event.key === 'Escape') { event.preventDefault(); UI.closeMenus(); }
    });
    return menu;
  },

  /** Resolves with the chosen button's value, or null when dismissed. */
  modal({ title, text, body, buttons = [{ label: 'OK', primary: true, value: true }], wide = false, focus, className = '' }) {
    return new Promise(resolve => {
      const previous = document.activeElement;
      const footer = h('footer');
      const left = h('div.left');
      footer.append(left);
      const box = h('div.modal', { role: 'dialog', 'aria-modal': 'true', 'aria-label': title, class: [wide ? 'wide' : '', className].filter(Boolean).join(' ') },
        title || text ? h('header', {}, title && h('h2', { text: title }), text && h('p', { text })) : null,
        body ? h('div.body', {}, body) : null,
        footer);
      const backdrop = h('div.backdrop', {}, box);
      const done = value => { backdrop.remove(); previous?.focus?.({ preventScroll: true }); resolve(value); };
      let primary = null;
      for (const b of buttons) {
        const button = h('button.button', { class: [b.primary ? 'primary' : '', b.danger ? 'danger' : ''].filter(Boolean).join(' '), text: b.label, disabled: b.disabled });
        button.addEventListener('click', async () => {
          if (b.run) {
            const result = await b.run();
            if (b.keep || result === false) return;
          }
          done(b.value === undefined ? b.label : b.value);
        });
        (b.left ? left : footer).append(button);
        if (b.primary) primary = button;
      }
      backdrop.addEventListener('mousedown', event => { if (event.target === backdrop) done(null); });
      box.addEventListener('keydown', event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); done(null); }
        if (event.key === 'Enter' && primary && !primary.disabled && (event.metaKey || (event.target.tagName !== 'TEXTAREA' && event.target.tagName !== 'BUTTON' && event.target.tagName !== 'SELECT'))) {
          event.preventDefault(); primary.click();
        }
        event.stopPropagation();
      });
      UI.layer.append(backdrop);
      (focus || box.querySelector('input, select, textarea') || primary || box.querySelector('button'))?.focus();
    });
  },

  confirm(title, text, { label = 'OK', danger = false, sql } = {}) {
    return UI.modal({
      title, text, body: sql ? h('pre.sql', { text: sql }) : null, wide: !!sql,
      buttons: [{ label: 'Cancel', value: false }, { label, primary: true, danger, value: true }],
    }).then(Boolean);
  },

  prompt(title, { text, value = '', label = 'OK', placeholder = '' } = {}) {
    const input = h('input', { type: 'text', value, placeholder, style: { width: '100%' }, spellcheck: false });
    return UI.modal({ title, text, body: input, buttons: [{ label: 'Cancel', value: null }, { label, primary: true, run: () => {} }], focus: input })
      .then(v => v === null ? null : input.value);
  },
};

// ============================================================ Host bridge

const bridge = { mode: 'none', pending: 0, label: '' };
let queue = Promise.resolve();

function setBusy(delta, label) {
  bridge.pending += delta;
  if (label) bridge.label = label;
  $('#busy').hidden = bridge.pending <= 0;
  $('#busy-text').textContent = bridge.label || 'Working…';
}

/** Database calls run one at a time; the host allows one statement per tab. */
function call(method, ...args) {
  const run = async () => {
    setBusy(1, method === 'query' ? 'Running query…' : method === 'open' ? 'Connecting…' : 'Working…');
    try { return await window.blink.database[method](...args); }
    finally { setBusy(-1); }
  };
  const promise = queue.then(run, run);
  queue = promise.catch(() => {});
  return promise;
}

async function q(sql, params = [], options = {}) {
  if (bridge.mode === 'legacy') return call('query', params.length ? SQL.inline(sql, params) : sql);
  const result = await call('query', sql, { params, maxRows: options.maxRows ?? 1000, maxCell: options.maxCell ?? 4096 });
  if (result.reconnected) UI.toast('Reconnected');
  return result;
}

const cancelQuery = () => window.blink?.database?.cancel?.().catch(() => {});

// ============================================================ Stored state

const store = {
  key: 'state.v1',
  data: { history: [], favorites: [], sessions: {}, settings: { pageSize: 300, maxRows: 1000 } },
  async load() {
    let text = null;
    try { text = window.blink?.storage ? await window.blink.storage.get(this.key) : localStorage.getItem(this.key); } catch { text = null; }
    try { if (text) this.data = { ...this.data, ...JSON.parse(text) }; } catch { /* keep defaults */ }
    this.data.settings = { pageSize: 300, maxRows: 1000, ...this.data.settings };
  },
  save() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.write(), 400);
  },
  async write() {
    const d = this.data;
    d.history = d.history.slice(0, 120).map(h => ({ ...h, sql: h.sql.slice(0, 4000) }));
    // Apps get 64 KiB of storage; drop the oldest history, then old sessions.
    let text = JSON.stringify(d);
    while (text.length > 60000 && d.history.length > 10) { d.history.length = Math.floor(d.history.length * 0.8); text = JSON.stringify(d); }
    const ids = Object.keys(d.sessions).sort((a, b) => (d.sessions[b].at || 0) - (d.sessions[a].at || 0));
    while (text.length > 60000 && ids.length) { delete d.sessions[ids.pop()]; text = JSON.stringify(d); }
    try {
      if (window.blink?.storage) await window.blink.storage.set(this.key, text);
      else localStorage.setItem(this.key, text);
    } catch (error) { console.warn('Could not save state', error); }
  },
};

// ============================================================ Home: saved connections

const home = { connections: [], selected: 0 };

async function detect() {
  const db = window.blink?.database;
  try {
    const info = await window.blink?.host?.info?.();
    if (info?.capabilities?.includes('database') && db) {
      bridge.mode = typeof db.connections === 'function' && typeof db.open === 'function' ? 'full' : 'legacy';
    }
  } catch { bridge.mode = 'none'; }
}

async function loadConnections() {
  if (bridge.mode !== 'full') return renderHome();
  try { home.connections = await call('connections'); }
  catch (error) { homeStatus(message(error), true); }
  renderHome();
}

function homeStatus(text, error = false) {
  const node = $('#home-status');
  node.textContent = text || '';
  node.style.color = error ? 'var(--danger)' : '';
}

function connectionDetail(c) {
  const where = `${c.user}@${c.host}${c.port === 3306 ? '' : ':' + c.port}${c.database ? '/' + c.database : ''}`;
  return c.ssh ? `${where} via SSH ${c.ssh}` : where;
}

function renderHome() {
  const list = $('#connection-list');
  const search = $('#connection-search').value.trim().toLowerCase();
  $('#new-connection').disabled = $('#import-url').disabled = bridge.mode === 'none';
  if (bridge.mode === 'none') {
    list.replaceChildren(h('li.empty', {}, h('h2', { text: 'Database access isn’t available here' }),
      h('p', { text: 'This host doesn’t provide the database bridge. Open Database Workbench from Wink’s Apps menu (Wink 0.9.4 or newer).' })));
    $('#connection-search').hidden = true;
    return;
  }
  if (bridge.mode === 'legacy') {
    $('#import-url').hidden = true;
    $('#new-connection').textContent = 'Choose Connection…';
    $('#connection-search').hidden = true;
    list.replaceChildren(h('li.empty', {}, h('h2', { text: 'Update Wink for saved connections' }),
      h('p', { text: 'This version of Wink offers one read-only connection at a time. Wink 0.9.4 adds saved connections, SSH tunnels to your hosts, URL import and editing.' })));
    return;
  }
  const items = home.connections.filter(c => !search || [c.title, c.host, c.user, c.database, c.ssh, c.environment].join(' ').toLowerCase().includes(search));
  home.visible = items;
  home.selected = Math.min(home.selected, Math.max(0, items.length - 1));
  $('#connection-search').hidden = home.connections.length < 6;
  if (!home.connections.length) {
    list.replaceChildren(h('li.empty', {}, h('h2', { text: 'No connections yet' }),
      h('p', {}, 'Create one, or import a URL like ', h('code', { text: 'mysql://user:pass@host:3306/db' }), '.'),
      h('p', {}, 'To go through one of your Wink or Blink hosts, choose it under “Over SSH”, or add ', h('code', { text: '?ssh=alias' }), ' to the URL.')));
    return;
  }
  list.replaceChildren(...items.map((c, i) => {
    const action = (label, fn, cls = '') => h('button', { class: cls, text: label, onclick: event => { event.stopPropagation(); fn(); } });
    return h('li.connection', { role: 'option', 'aria-selected': String(i === home.selected), class: i === home.selected ? 'selected' : '', tabIndex: -1,
      onclick: () => { home.selected = i; renderHome(); }, ondblclick: () => connect(c.id),
      oncontextmenu: event => { event.preventDefault(); home.selected = i; renderHome(); connectionMenu(c, event.clientX, event.clientY); } },
    h('span.stripe', { style: { background: envColor(c) } }),
    h('div.info', {},
      h('div.name', {}, c.title,
        c.environment && h('span.tag.env', { text: ENV_LABELS[c.environment], style: { background: envColor(c) } }),
        c.ssh && h('span.tag', { text: 'SSH' }),
        c.readOnly && h('span.tag', { text: 'read-only' })),
      h('div.detail', { text: connectionDetail(c), title: connectionDetail(c) })),
    h('div.actions', {},
      action('Edit', () => editConnection(c.id)),
      action('⋯', () => { const r = list.children[i].getBoundingClientRect(); connectionMenu(c, r.right - 200, r.bottom); }),
      action('Connect', () => connect(c.id), 'connect')));
  }));
}

function connectionMenu(c, x, y) {
  UI.menu(x, y, [
    { label: 'Connect', hint: '↩', run: () => connect(c.id) },
    { label: 'Edit…', run: () => editConnection(c.id) },
    { label: 'Duplicate', run: async () => { try { await call('duplicate', c.id); await loadConnections(); } catch (e) { homeStatus(message(e), true); } } },
    { label: 'Copy URL…', run: async () => { try { if (await call('copyURL', c.id)) UI.toast('Connection URL copied'); } catch (e) { homeStatus(message(e), true); } } },
    '-',
    { label: 'Delete…', danger: true, run: async () => { try { if (await call('remove', c.id)) await loadConnections(); } catch (e) { homeStatus(message(e), true); } } },
  ]);
}

async function editConnection(id) {
  try {
    const saved = await call('edit', id);
    if (saved) { await loadConnections(); selectConnection(saved.id); }
  } catch (error) { homeStatus(message(error), true); }
}

function selectConnection(id) {
  const i = (home.visible || []).findIndex(c => c.id === id);
  if (i >= 0) { home.selected = i; renderHome(); }
}

// ============================================================ Workspace state

let ws = null;

function freshWorkspace(conn, info) {
  return {
    conn, version: info.version || '', database: info.database || '', databases: [], tables: [], routines: [],
    columns: new Map(), tabs: [], active: null, nextID: 1,
  };
}

async function connect(id) {
  homeStatus('Connecting…');
  const c = home.connections.find(x => x.id === id);
  if (c?.ssh) homeStatus(`Opening SSH tunnel through ${c.ssh}…`);
  let info;
  try {
    if (bridge.mode === 'legacy') {
      if (!await call('connect')) { homeStatus(''); return; }
      info = { connection: { id: 'legacy', title: 'MySQL', readOnly: true, user: '', host: '127.0.0.1', port: 3306 } };
      const r = await q('SELECT VERSION(), DATABASE()');
      info.version = r.rows[0][0]; info.database = r.rows[0][1];
    } else info = await call('open', id);
  } catch (error) { homeStatus(message(error), true); return; }
  homeStatus('');
  ws = freshWorkspace(info.connection, info);
  $('#home').hidden = true;
  $('#workspace').hidden = false;
  renderToolbar();
  $('#panes').replaceChildren();
  $('#tabs').replaceChildren();
  status(`Connected to ${ws.conn.title}${ws.conn.ssh ? ' through ' + ws.conn.ssh : ''}.`);
  await loadDatabases();
  await loadObjects();
  restoreSession();
}

async function disconnect() {
  if (!ws) return;
  const dirty = ws.tabs.filter(t => t.dirty?.());
  if (dirty.length && !await UI.confirm('Discard unsaved changes?', `${plural(dirty.length, 'tab')} with uncommitted changes will be closed.`, { label: 'Discard', danger: true })) return;
  saveSession();
  cancelQuery();
  try { if (bridge.mode === 'full') await call('disconnect'); } catch { /* already closed */ }
  ws = null;
  $('#workspace').hidden = true;
  $('#home').hidden = false;
  await loadConnections();
  $('#connection-list').focus();
}

function renderToolbar() {
  const c = ws.conn;
  $('#env-dot').style.background = envColor(c);
  $('#env-dot').title = c.environment ? ENV_LABELS[c.environment] : '';
  $('#conn-title').textContent = c.title;
  $('#conn-meta').textContent = bridge.mode === 'legacy' ? '' : connectionDetail({ ...c, database: '' });
  $('#badge-ro').hidden = !c.readOnly;
  $('#server').textContent = ws.version ? (/mariadb/i.test(ws.version) ? 'MariaDB ' : 'MySQL ') + ws.version.replace(/-.*$/, '') : '';
  document.title = `${c.title} — Database Workbench`;
}

function status(text, error = false) {
  const node = $('#status');
  node.textContent = text;
  node.className = error ? 'error' : '';
  node.title = text;
}

// ============================================================ Databases and objects

async function loadDatabases() {
  try {
    const r = await q('SHOW DATABASES', [], { maxRows: 10000 });
    ws.databases = r.rows.map(row => row[0]);
  } catch (error) { ws.databases = ws.database ? [ws.database] : []; status(message(error), true); }
  const select = $('#database-select');
  select.replaceChildren(
    ...(ws.database ? [] : [h('option', { value: '', text: 'Choose database…' })]),
    ...ws.databases.map(name => h('option', { value: name, text: name, selected: name === ws.database })));
}

async function useDatabase(name) {
  if (!name || name === ws.database) return;
  try {
    await q('USE ' + SQL.ident(name));
    ws.database = name;
    await loadDatabases();
    await loadObjects();
    saveSession();
    status(`Using ${name}.`);
  } catch (error) { status(message(error), true); $('#database-select').value = ws.database; }
}

const parseEnum = type => {
  const m = /^enum\((.*)\)$/i.exec(type || '');
  return m ? [...m[1].matchAll(/'((?:[^']|'')*)'/g)].map(x => x[1].replaceAll("''", "'").replaceAll('\\\\', '\\')) : null;
};

function columnInfo(row) {
  const [table, name, type, dataType, nullable, def, key, extra, comment, charset, collation] = row;
  return {
    table, name, type, dataType, nullable: nullable === 'YES', default: def, key, extra: extra || '', comment: comment || '', charset, collation,
    autoIncrement: /auto_increment/i.test(extra || ''), generated: /\b(VIRTUAL|STORED) GENERATED\b/i.test(extra || ''), enum: parseEnum(type),
  };
}

const COLUMNS_SQL = `SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_KEY, EXTRA, COLUMN_COMMENT,
  CHARACTER_SET_NAME, COLLATION_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ?`;

async function loadObjects() {
  ws.tables = []; ws.routines = [];
  ws.columns = new Map([...ws.columns].filter(([key]) => !key.startsWith(ws.database + '\0')));
  if (!ws.database) { renderSidebar(); return; }
  const db = ws.database;
  try {
    const t = await q(`SELECT TABLE_NAME, TABLE_TYPE, ENGINE, TABLE_ROWS, DATA_LENGTH + INDEX_LENGTH, TABLE_COMMENT
      FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME`, [db], { maxRows: 50000 });
    ws.tables = t.rows.map(([name, type, engine, rows, size, comment]) => ({
      name, view: type === 'VIEW', type, engine, rows: rows === null ? null : Number(rows), size: Number(size || 0), comment }));
    const c = await q(COLUMNS_SQL + ' ORDER BY TABLE_NAME, ORDINAL_POSITION', [db], { maxRows: 50000, maxCell: 1024 });
    const grouped = new Map();
    for (const row of c.rows) {
      const info = columnInfo(row);
      const key = db + '\0' + info.table;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(info);
    }
    for (const [key, cols] of grouped) ws.columns.set(key, cols);
    const r = await q('SELECT ROUTINE_NAME, ROUTINE_TYPE FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ? ORDER BY ROUTINE_NAME', [db], { maxRows: 10000 });
    ws.routines = r.rows.map(([name, type]) => ({ name, type }));
  } catch (error) { status(message(error), true); }
  renderSidebar();
}

async function columnsFor(table, db = ws.database) {
  const key = db + '\0' + table;
  if (!ws.columns.has(key)) {
    const r = await q(COLUMNS_SQL + ' AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION', [db, table], { maxRows: 5000 });
    ws.columns.set(key, r.rows.map(columnInfo));
  }
  return ws.columns.get(key);
}

const tableInfo = name => ws.tables.find(t => t.name === name);

function renderSidebar() {
  const nav = $('#objects');
  const filter = $('#object-filter').value.trim().toLowerCase();
  const active = ws.tabs.find(t => t.id === ws.active);
  const match = name => !filter || name.toLowerCase().includes(filter);
  if (!ws.database) {
    nav.replaceChildren(h('p.note', { text: ws.databases.length ? 'Choose a database above.' : 'No databases are visible to this user.' }));
    $('#object-count').textContent = '';
    return;
  }
  const section = (title, items, icon, open) => items.length ? [h('h3', { text: title }), ...items.map(item => h('button', {
    class: active?.kind === 'table' && active.name === item.name && active.db === ws.database && item.type !== 'PROCEDURE' && item.type !== 'FUNCTION' ? 'active' : '',
    title: [item.name, item.comment, item.engine, item.size ? bytes(item.size) : ''].filter(Boolean).join(' · '),
    onclick: () => open(item), oncontextmenu: event => { event.preventDefault(); objectMenu(item, event.clientX, event.clientY); },
  }, h('span.icon', { text: icon }), h('span.label', { text: item.name }), item.rows !== undefined && item.rows !== null && !item.view && h('span.count', { text: compact(item.rows) })))] : [];
  const tables = ws.tables.filter(t => !t.view && match(t.name));
  const views = ws.tables.filter(t => t.view && match(t.name));
  const routines = ws.routines.filter(r => match(r.name));
  nav.replaceChildren(
    ...section('Tables', tables, '▦', t => openTable(t.name)),
    ...section('Views', views, '◫', t => openTable(t.name)),
    ...section('Routines', routines, 'ƒ', r => showRoutine(r)));
  if (!nav.children.length) nav.append(h('p.note', { text: filter ? 'No matches.' : 'This database is empty.' }));
  $('#object-count').textContent = plural(ws.tables.length, 'object');
}

function objectMenu(item, x, y) {
  if (item.type === 'PROCEDURE' || item.type === 'FUNCTION') {
    UI.menu(x, y, [
      { label: 'Show Definition', run: () => showRoutine(item) },
      { label: 'Copy Name', run: () => UI.copy(item.name) },
      '-',
      { label: `Drop ${item.type.toLowerCase()}…`, danger: true, disabled: ws.conn.readOnly, run: () => runDDL(`DROP ${item.type} ${SQL.qualified(ws.database, item.name)}`, { danger: true, confirmName: item.name }) },
    ]);
    return;
  }
  const t = SQL.qualified(ws.database, item.name);
  const ro = ws.conn.readOnly;
  UI.menu(x, y, [
    { label: 'Open', run: () => openTable(item.name) },
    { label: 'Open Structure', run: () => openTable(item.name, 'structure') },
    { label: 'New Query', run: () => newQuery(`SELECT *\nFROM ${SQL.ident(item.name)}\nLIMIT 100;`) },
    '-',
    { label: 'Copy Name', run: () => UI.copy(item.name) },
    { label: 'Copy CREATE Statement', run: async () => {
      try { const r = await q(`SHOW CREATE ${item.view ? 'VIEW' : 'TABLE'} ${t}`); UI.copyDialog(r.rows[0][1] + ';', `CREATE ${item.view ? 'VIEW' : 'TABLE'} ${item.name}`); }
      catch (e) { status(message(e), true); } } },
    { label: 'Export Rows', submenu: ['SQL INSERT', 'CSV', 'JSON'].map(format => ({ label: format, run: () => exportTable(item.name, format) })) },
    '-',
    { label: 'Rename…', disabled: ro, run: async () => {
      const name = await UI.prompt(`Rename ${item.name}`, { value: item.name, label: 'Rename' });
      if (name && name !== item.name) runDDL(`RENAME TABLE ${t} TO ${SQL.qualified(ws.database, name)}`);
    } },
    !item.view && { label: 'Duplicate Structure…', disabled: ro, run: async () => {
      const name = await UI.prompt(`Duplicate ${item.name}`, { text: 'Creates an empty table with the same columns and indexes.', value: item.name + '_copy', label: 'Create' });
      if (name) runDDL(`CREATE TABLE ${SQL.qualified(ws.database, name)} LIKE ${t}`);
    } },
    !item.view && { label: 'Truncate…', danger: true, disabled: ro, run: () => runDDL(`TRUNCATE TABLE ${t}`, { danger: true, confirmName: item.name }) },
    { label: `Drop ${item.view ? 'View' : 'Table'}…`, danger: true, disabled: ro, run: () => runDDL(`DROP ${item.view ? 'VIEW' : 'TABLE'} ${t}`, { danger: true, confirmName: item.name }) },
  ]);
}

async function exportTable(name, format) {
  try {
    const r = await q(`SELECT * FROM ${SQL.qualified(ws.database, name)}`, [], { maxRows: 20000, maxCell: 1 << 20 });
    const cols = r.columns.map(c => c.name);
    const text = format === 'CSV' ? SQL.csv(cols, r.rows) : format === 'JSON' ? SQL.json(cols, r.rows) : SQL.inserts(ws.database, name, cols, r.rows);
    UI.copyDialog(text, `${name} as ${format}${r.truncated ? ' (first ' + plural(r.rows.length, 'row') + ')' : ''}`);
  } catch (error) { status(message(error), true); }
}

async function showRoutine(routine) {
  try {
    const r = await q(`SHOW CREATE ${routine.type} ${SQL.qualified(ws.database, routine.name)}`, [], { maxCell: 1 << 20 });
    const body = r.rows[0][2];
    newQuery('DELIMITER //\n' + (body ? SQL.plain(body) : '-- You need more privileges to see this definition.') + ' //\nDELIMITER ;\n', routine.name);
  } catch (error) { status(message(error), true); }
}

/** Confirms and runs one DDL statement, then refreshes. */
async function runDDL(sql, { danger = false, confirmName = null, then } = {}) {
  if (ws.conn.readOnly) { status('This connection is read-only.', true); return false; }
  const body = h('div', {}, h('pre.sql', { text: sql }));
  let input = null;
  if (confirmName && (danger && ws.conn.environment === 'production')) {
    input = h('input', { type: 'text', placeholder: confirmName, style: { width: '100%', marginTop: '10px' } });
    body.append(h('p', { class: 'warning', text: `Production: type ${confirmName} to confirm.` }), input);
  }
  const ok = await UI.modal({
    title: danger ? 'Are you sure?' : 'Run this statement?', body, wide: true, focus: input,
    buttons: [{ label: 'Cancel', value: false }, { label: danger ? 'Run' : 'Run', primary: true, danger, value: true,
      run: () => { if (input && input.value !== confirmName) { input.focus(); return false; } } }],
  });
  if (!ok) return false;
  try {
    await q(sql);
    status('Done: ' + sql.split('\n')[0].slice(0, 120));
    addHistory(sql);
    await loadObjects();
    for (const tab of ws.tabs) if (tab.kind === 'table') tab.stale = true;
    activeTab()?.refresh?.({ soft: true });
    then?.();
    return true;
  } catch (error) {
    await UI.modal({ title: 'The statement failed', text: message(error), body: h('pre.sql', { text: sql }), wide: true });
    return false;
  }
}

// ============================================================ Tabs

const activeTab = () => ws?.tabs.find(t => t.id === ws.active);

function addTab(tab) {
  tab.id = ws.nextID++;
  ws.tabs.push(tab);
  $('#panes').append(tab.pane);
  activate(tab.id);
  return tab;
}

function activate(id) {
  ws.active = id;
  for (const tab of ws.tabs) tab.pane.hidden = tab.id !== id;
  renderTabs();
  renderSidebar();
  const tab = activeTab();
  tab?.shown?.();
  saveSession();
}

function renderTabs() {
  const bar = $('#tabs');
  bar.replaceChildren(...ws.tabs.map(tab => h('div.tab', {
    role: 'tab', 'aria-selected': String(tab.id === ws.active), class: tab.id === ws.active ? 'active' : '', tabIndex: 0, title: tab.tooltip?.() || tab.title(),
    onmousedown: event => { if (event.button === 1) { event.preventDefault(); closeTab(tab.id); } },
    onclick: () => activate(tab.id),
    onkeydown: event => { if (event.key === 'Enter' || event.key === ' ') activate(tab.id); },
    oncontextmenu: event => { event.preventDefault(); UI.menu(event.clientX, event.clientY, [
      { label: 'Close Tab', hint: '⌥⌘W', run: () => closeTab(tab.id) },
      { label: 'Close Other Tabs', run: async () => { for (const t of ws.tabs.filter(t => t.id !== tab.id)) await closeTab(t.id); } },
      tab.kind === 'query' && { label: 'Rename…', run: async () => { const name = await UI.prompt('Rename tab', { value: tab.title() }); if (name) { tab.name = name; renderTabs(); saveSession(); } } },
    ]); },
  }, h('span.icon', { text: tab.kind === 'table' ? (tab.view ? '◫' : '▦') : '⌨' }), h('span.label', { text: tab.title() }),
  tab.dirty?.() && h('span.dirty', { title: 'Uncommitted changes' }),
  h('button.close', { text: '×', title: 'Close tab', 'aria-label': 'Close tab', onclick: event => { event.stopPropagation(); closeTab(tab.id); } }))));
  if (!ws.tabs.length) {
    $('#panes').replaceChildren(h('div.welcome', {},
      h('p', {}, 'Choose a table on the left, press ', h('kbd', { text: '⌘P' }), ' to open one, or start a ', h('button.link-button', { text: 'new SQL query', onclick: () => newQuery() }), '.')));
  } else $('#panes .welcome')?.remove();
}

async function closeTab(id) {
  const tab = ws.tabs.find(t => t.id === id);
  if (!tab) return;
  if (tab.dirty?.() && !await UI.confirm(`Discard changes in ${tab.title()}?`, 'Your edits haven’t been committed.', { label: 'Discard', danger: true })) return;
  const index = ws.tabs.indexOf(tab);
  ws.tabs.splice(index, 1);
  tab.pane.remove();
  if (ws.active === id) {
    const next = ws.tabs[Math.min(index, ws.tabs.length - 1)];
    if (next) activate(next.id); else { ws.active = null; renderTabs(); renderSidebar(); saveSession(); }
  } else { renderTabs(); saveSession(); }
}

function cycleTab(step) {
  if (!ws?.tabs.length) return;
  const i = ws.tabs.findIndex(t => t.id === ws.active);
  activate(ws.tabs[(i + step + ws.tabs.length) % ws.tabs.length].id);
}

function saveSession() {
  if (!ws || bridge.mode !== 'full') return;
  store.data.sessions[ws.conn.id] = {
    at: Date.now(), db: ws.database, active: ws.tabs.findIndex(t => t.id === ws.active),
    tabs: ws.tabs.map(t => t.kind === 'table' ? { kind: 'table', name: t.name, db: t.db, view: t.subview } : { kind: 'query', name: t.name, sql: t.editor.value.slice(0, 8000) }),
  };
  store.save();
}

async function restoreSession() {
  const saved = store.data.sessions[ws.conn.id];
  if (saved?.db && saved.db !== ws.database && ws.databases.includes(saved.db) && !ws.conn.database) await useDatabase(saved.db);
  for (const t of saved?.tabs || []) {
    if (t.kind === 'table' && t.db === ws.database && tableInfo(t.name)) openTable(t.name, t.view, { quiet: true });
    if (t.kind === 'query') newQuery(t.sql, t.name, { quiet: true });
  }
  const tab = ws.tabs[saved?.active ?? -1] || ws.tabs[ws.tabs.length - 1];
  if (tab) activate(tab.id); else renderTabs();
}

// ============================================================ Table tab

function gridColumns(resultColumns, info = []) {
  return resultColumns.map(rc => {
    const meta = info.find(c => c.name === rc.name);
    return meta ? { ...meta, type: meta.type } : {
      name: rc.name, type: (rc.type || '').toLowerCase(), key: rc.flags?.includes('primary_key') ? 'PRI' : '', nullable: !rc.flags?.includes('not_null'),
      numeric: /^(LONG|LONGLONG|SHORT|TINY|INT24|NEWDECIMAL|DECIMAL|DOUBLE|FLOAT|YEAR|BIT)$/.test(rc.type || ''),
    };
  });
}

function keyColumnsOf(info) {
  const pk = info.filter(c => c.key === 'PRI').map(c => c.name);
  if (pk.length) return pk;
  const unique = info.find(c => c.key === 'UNI' && !c.nullable);
  return unique ? [unique.name] : [];
}

function openTable(name, view = 'data', { quiet = false } = {}) {
  const existing = ws.tabs.find(t => t.kind === 'table' && t.name === name && t.db === ws.database);
  if (existing) { if (view !== existing.subview) existing.setView(view); if (!quiet) activate(existing.id); return existing; }
  const tab = tableTab(name, view);
  addTab(tab);
  return tab;
}

function tableTab(name, initialView) {
  const info = tableInfo(name) || {};
  const tab = {
    kind: 'table', name, db: ws.database, view: info.view, subview: initialView,
    page: 0, pageSize: store.data.settings.pageSize, sort: null, filters: [], total: null, exact: false, loaded: false, stale: false, structureLoaded: false,
  };
  tab.title = () => tab.db === ws.database ? name : `${tab.db}.${name}`;
  tab.tooltip = () => `${tab.db}.${name}`;

  const segment = (label, value) => h('button', { text: label, 'aria-pressed': String(tab.subview === value), onclick: () => tab.setView(value) });
  const seg = h('div.segmented', {}, segment('Data', 'data'), segment('Structure', 'structure'));
  const filterButton = h('button.button.small', { text: 'Filter', title: 'Filter rows (⌘F)', onclick: () => toggleFilters() });
  const editNote = h('span.muted');
  const subbar = h('div.subbar', {}, seg, filterButton, editNote);
  const filtersEl = h('div.filters', { hidden: true });
  const banner = h('div.banner', { hidden: true });
  const gridHost = h('div', { style: { flex: '1', minHeight: '0', display: 'flex', flexDirection: 'column' } });
  const countEl = h('span.muted');
  const prev = h('button.button.small', { text: '‹', title: 'Previous page', onclick: () => { if (tab.page > 0) { tab.page--; load(); } } });
  const next = h('button.button.small', { text: '›', title: 'Next page', onclick: () => { tab.page++; load(); } });
  const sizeSelect = h('select', { title: 'Rows per page', onchange: () => { tab.pageSize = Number(sizeSelect.value); store.data.settings.pageSize = tab.pageSize; store.save(); tab.page = 0; load(); } },
    ...[100, 300, 500, 1000, 5000].map(n => h('option', { value: n, text: `${n} rows`, selected: n === tab.pageSize })));
  const addRow = h('button.button.small', { text: '＋ Row', title: 'Add row', onclick: () => grid.addRow() });
  const delRow = h('button.button.small', { text: '－ Row', title: 'Delete selected rows (⌘⌫)', onclick: () => grid.deleteRows(grid.selectedRows()) });
  const discard = h('button.button.small', { text: 'Discard', onclick: () => grid.discard() });
  const preview = h('button.button.small', { text: 'Preview SQL', onclick: () => previewChanges() });
  const commitButton = h('button.button.small.primary', { text: 'Commit', title: 'Commit changes (⌘S)', onclick: () => commit() });
  const editGroup = h('div.group', {}, addRow, delRow);
  const changeGroup = h('div.group', {}, discard, preview, commitButton);
  const footbar = h('div.footbar', {}, editGroup, changeGroup, h('span.spacer'), countEl, h('div.group', {}, prev, next, sizeSelect),
    h('button.button.small', { text: 'Export', onclick: event => { const r = event.target.getBoundingClientRect(); UI.menu(r.left, r.top - 110, ['SQL INSERT', 'CSV', 'JSON'].map(f => ({ label: `Copy page as ${f}`, run: () => copyPage(f) }))); } }));
  const dataView = h('div', { style: { flex: '1', minHeight: '0', display: 'flex', flexDirection: 'column' } }, filtersEl, banner, gridHost, footbar);
  const structureView = h('div.structure', { hidden: true });
  tab.pane = h('div.pane', {}, subbar, dataView, structureView);

  let columnsInfo = [];
  let keyCols = [];
  const grid = new Grid(gridHost, {
    sortMode: 'server',
    onSort: sort => { tab.sort = sort; tab.page = 0; load(); },
    onChange: () => { updateFooter(); renderTabs(); },
    onStatus: text => status(text),
    onOpenValue: (r, c) => openValue(grid, r, c, { table: name, db: tab.db, keyCols }),
    database: () => tab.db, table: () => name,
    menuItems: ({ r, c, column, value, rows }) => [
      { label: 'Open Value…', hint: '', run: () => openValue(grid, r, c, { table: name, db: tab.db, keyCols }) },
      grid.editable && { label: 'Edit Row…', run: () => editRow(grid, r) },
      typeof value !== 'object' || value === null ? { label: `Filter: ${column.name} ${value === null ? 'IS NULL' : '= value'}`, run: () => addFilter({ column: column.name, op: value === null ? 'null' : '=', value: value ?? '' }) } : null,
      typeof value !== 'object' || value === null ? { label: `Filter: ${column.name} ${value === null ? 'IS NOT NULL' : '≠ value'}`, run: () => addFilter({ column: column.name, op: value === null ? 'not null' : '!=', value: value ?? '' }) } : null,
      column.key === 'MUL' || column.key === 'PRI' ? { label: 'Find References…', run: () => followKey(column, value) } : null,
      rows.length && { label: 'Copy as UPDATE', run: () => UI.copy(rows.map(i => updateFor(grid, i)).join('\n')) },
    ],
  });
  tab.grid = grid;
  tab.dirty = () => grid.pending > 0;

  function updateFooter() {
    const editable = grid.editable;
    editGroup.hidden = !editable;
    changeGroup.hidden = !editable || !grid.pending;
    commitButton.textContent = grid.pending ? `Commit ${grid.pending}` : 'Commit';
    prev.disabled = tab.page === 0;
    const shown = grid.entries.filter(e => e.orig).length;
    const from = shown ? tab.page * tab.pageSize + 1 : 0;
    const to = tab.page * tab.pageSize + shown;
    next.disabled = shown < tab.pageSize || (tab.total !== null && tab.exact && to >= tab.total);
    const total = tab.total === null ? '' : ` of ${tab.exact ? '' : '~'}${tab.total.toLocaleString()}`;
    countEl.replaceChildren(`${from.toLocaleString()}–${to.toLocaleString()}${total} rows`,
      tab.total !== null && !tab.exact ? h('button.link-button', { text: 'count', title: 'Count exactly', onclick: () => count(true) }) : '');
    filterButton.textContent = tab.filters.length ? `Filter (${tab.filters.filter(f => f.enabled !== false).length})` : 'Filter';
  }

  async function confirmDiscard() {
    return !grid.pending || UI.confirm('Discard uncommitted changes?', `${plural(grid.pending, 'change')} will be lost.`, { label: 'Discard', danger: true });
  }

  async function load({ keepPage = true } = {}) {
    if (!await confirmDiscard()) return;
    if (!keepPage) tab.page = 0;
    try {
      columnsInfo = await columnsFor(name, tab.db);
      keyCols = keyColumnsOf(columnsInfo);
      const where = SQL.whereClause(tab.filters, columnsInfo.map(c => c.name));
      const order = tab.sort ? ` ORDER BY ${SQL.ident(tab.sort.column)} ${tab.sort.dir}` : '';
      const sql = `SELECT * FROM ${SQL.qualified(tab.db, name)}${where.sql}${order} LIMIT ${tab.pageSize} OFFSET ${tab.page * tab.pageSize}`;
      const started = performance.now();
      const r = await q(sql, where.params, { maxRows: tab.pageSize, maxCell: 4096 });
      const readOnly = ws.conn.readOnly || tab.view;
      const reason = ws.conn.readOnly ? 'This connection is read-only.' : tab.view ? 'Views are read-only here.' : '';
      grid.options.canEditReason = reason;
      grid.setData(gridColumns(r.columns, columnsInfo), r.rows, {
        editable: !readOnly, keyColumns: keyCols, sort: tab.sort, emptyText: tab.filters.length ? 'No rows match the filter.' : 'This table is empty.' });
      banner.hidden = readOnly || keyCols.length > 0 || !r.rows.length;
      banner.className = 'banner';
      banner.textContent = 'This table has no primary key: edits match a row on every column and change at most one row.';
      editNote.textContent = reason;
      tab.loaded = true; tab.stale = false;
      tab.lastSQL = SQL.inline(sql, where.params);
      status(`${plural(r.rows.length, 'row')} in ${Math.round(r.elapsed ?? performance.now() - started)} ms — ${tab.lastSQL.slice(0, 200)}`);
      if (!tab.filters.length && tableInfo(name)?.rows !== null && tableInfo(name)?.rows !== undefined && tab.total === null) {
        tab.total = tableInfo(name).rows; tab.exact = false;
      }
      updateFooter();
      if (tab.filters.length || tab.total === null || (tab.total < 50000 && !tab.exact)) count(false);
      renderTabs();
    } catch (error) {
      banner.hidden = false;
      banner.className = 'banner error';
      banner.textContent = message(error);
      status(message(error), true);
    }
  }

  async function count(force) {
    if (tab.view && !force && !tab.filters.length) return;
    try {
      const where = SQL.whereClause(tab.filters, columnsInfo.map(c => c.name));
      const r = await q(`SELECT COUNT(*) FROM ${SQL.qualified(tab.db, name)}${where.sql}`, where.params);
      tab.total = Number(r.rows[0][0]); tab.exact = true;
      updateFooter();
    } catch (error) { status(message(error), true); }
  }

  // ---- Filters
  function toggleFilters(force) {
    const show = force ?? filtersEl.hidden;
    if (show && !tab.filters.length) tab.filters.push({ column: '*', op: 'contains', value: '' });
    filtersEl.hidden = !show;
    renderFilters();
    if (show) filtersEl.querySelector('input[type=text]')?.focus();
  }
  tab.toggleFilters = toggleFilters;

  function addFilter(filter) {
    tab.filters = tab.filters.filter(f => f.value !== '' || ['null', 'not null', 'empty', 'not empty'].includes(f.op));
    tab.filters.push(filter);
    filtersEl.hidden = false;
    renderFilters();
    load({ keepPage: false });
  }

  function renderFilters() {
    const names = (columnsInfo.length ? columnsInfo : grid.columns).map(c => c.name);
    const rows = tab.filters.map((f, i) => {
      const noValue = ['null', 'not null', 'empty', 'not empty'].includes(f.op);
      const value = h('input', { type: 'text', value: f.value ?? '', placeholder: f.column === '' ? 'Raw WHERE clause, e.g. total > 100 AND status = \'paid\'' : f.op === 'in' ? 'a, b, c' : f.op === 'between' ? 'low, high' : 'Value', hidden: noValue,
        oninput: () => { f.value = value.value; }, onkeydown: event => { if (event.key === 'Enter') { event.preventDefault(); load({ keepPage: false }); } } });
      const op = h('select', { hidden: f.column === '', onchange: () => { f.op = op.value; renderFilters(); } },
        ...SQL.OPERATORS.map(([v, label]) => h('option', { value: v, text: label, selected: v === f.op })));
      const column = h('select', { onchange: () => { f.column = column.value; if (f.column === '') f.op = 'raw'; else if (f.op === 'raw') f.op = '='; renderFilters(); } },
        h('option', { value: '*', text: 'Any column', selected: f.column === '*' }),
        ...names.map(n => h('option', { value: n, text: n, selected: n === f.column })),
        h('option', { value: '', text: 'Raw SQL', selected: f.column === '' }));
      return h('div.filter-row', {},
        h('input', { type: 'checkbox', checked: f.enabled !== false, title: 'Use this filter', onchange: event => { f.enabled = event.target.checked; load({ keepPage: false }); } }),
        column, op, value,
        h('button.button.small', { text: '−', title: 'Remove filter', onclick: () => { tab.filters.splice(i, 1); renderFilters(); if (!tab.filters.length) filtersEl.hidden = true; load({ keepPage: false }); } }),
        i === tab.filters.length - 1 && h('button.button.small', { text: '＋', title: 'Add filter', onclick: () => { tab.filters.push({ column: '*', op: 'contains', value: '' }); renderFilters(); } }));
    });
    filtersEl.replaceChildren(...rows, h('div.filter-row', {}, h('span.spacer'),
      h('button.button.small', { text: 'Clear', onclick: () => { tab.filters = []; filtersEl.hidden = true; load({ keepPage: false }); } }),
      h('button.button.small.primary', { text: 'Apply', onclick: () => load({ keepPage: false }) })));
    updateFooter();
  }

  // ---- Saving
  function statements() {
    return SQL.changeStatements(tab.db, name, grid.changes(), { limitOne: !keyCols.length });
  }
  async function previewChanges() {
    const list = statements();
    await UI.modal({ title: `${plural(list.length, 'statement')} to commit`, wide: true,
      body: h('pre.sql', { text: list.map(s => SQL.inline(s.sql, s.params) + ';').join('\n') }),
      buttons: [{ label: 'Copy', left: true, keep: true, run: () => UI.copy(list.map(s => SQL.inline(s.sql, s.params) + ';').join('\n')) },
        { label: 'Close', value: false }, { label: 'Commit', primary: true, run: () => { setTimeout(commit, 0); } }] });
  }
  async function commit() {
    if (!grid.pending) return;
    const list = statements();
    if (ws.conn.environment === 'production' && !await UI.confirm('Commit to production?', `${plural(list.length, 'statement')} will run in one transaction.`,
      { label: 'Commit', danger: true, sql: list.map(s => SQL.inline(s.sql, s.params) + ';').join('\n') })) return;
    try {
      const r = await call('execute', list);
      const missed = (r.affected || []).filter((n, i) => n === 0 && !list[i].sql.startsWith('INSERT')).length;
      addHistory(list.map(s => SQL.inline(s.sql, s.params) + ';').join('\n'));
      grid.discard();
      status(`Committed ${plural(list.length, 'change')}.` + (missed ? ` ${plural(missed, 'statement')} matched no rows — the data may have changed.` : ''), missed > 0);
      UI.toast(`Committed ${plural(list.length, 'change')}`);
      tab.total = null;
      await load();
    } catch (error) {
      await UI.modal({ title: 'Nothing was committed', text: message(error) + ' The transaction was rolled back; your edits are still here.', wide: true,
        body: h('pre.sql', { text: list.map(s => SQL.inline(s.sql, s.params) + ';').join('\n') }) });
    }
  }
  tab.commit = commit;

  function copyPage(format) {
    const cols = grid.columns.map(c => c.name);
    const rows = grid.entries.map(e => e.values);
    UI.copy(format === 'CSV' ? SQL.csv(cols, rows) : format === 'JSON' ? SQL.json(cols, rows) : SQL.inserts(tab.db, name, cols, rows));
  }

  async function followKey(column, value) {
    // MUL: this column references another table; PRI: other tables reference this one.
    try {
      const outgoing = column.key !== 'PRI';
      const r = await q(outgoing
        ? `SELECT REFERENCED_TABLE_SCHEMA, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE
           WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ? AND REFERENCED_TABLE_NAME IS NOT NULL`
        : `SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE
           WHERE REFERENCED_TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME = ? AND REFERENCED_COLUMN_NAME = ?`, [tab.db, name, column.name]);
      if (!r.rows.length) { status(outgoing ? `${column.name} has no foreign key.` : `No foreign keys reference ${name}.${column.name}.`); return; }
      const open = ([db, table, col]) => {
        if (db !== ws.database) { newQuery(`SELECT * FROM ${SQL.qualified(db, table)} WHERE ${SQL.ident(col)} = ${SQL.literal(value)} LIMIT 100;`); return; }
        const t = openTable(table);
        t.applyFilter?.({ column: col, op: '=', value });
      };
      if (r.rows.length === 1) open(r.rows[0]);
      else { const rect = gridHost.getBoundingClientRect(); UI.menu(rect.left + 60, rect.top + 40, r.rows.map(row => ({ label: `${row[1]}.${row[2]}`, run: () => open(row) }))); }
    } catch (error) { status(message(error), true); }
  }
  tab.applyFilter = filter => { tab.filters = [filter]; filtersEl.hidden = false; tab.loaded = true; renderFilters(); load({ keepPage: false }); };

  function updateFor(g, r) {
    const entry = g.entries[r];
    const set = g.columns.map((c, i) => `${SQL.ident(c.name)} = ${SQL.literal(SQL.plain(entry.values[i]))}`).join(', ');
    const key = g.keyOf(entry);
    return `UPDATE ${SQL.qualified(tab.db, name)} SET ${set} WHERE ${Object.entries(key).map(([k, v]) => `${SQL.ident(k)} ${v === null ? 'IS NULL' : '= ' + SQL.literal(SQL.plain(v))}`).join(' AND ')};`;
  }

  // ---- Structure
  async function loadStructure() {
    tab.structureLoaded = true;
    structureView.replaceChildren(h('p.muted', { text: 'Loading structure…' }));
    try {
      const cols = await columnsFor(name, tab.db);
      columnsInfo = cols;
      const t = SQL.qualified(tab.db, name);
      const [stats, indexes, fks, ddl] = [
        await q(`SELECT ENGINE, TABLE_ROWS, AVG_ROW_LENGTH, DATA_LENGTH, INDEX_LENGTH, AUTO_INCREMENT, CREATE_TIME, UPDATE_TIME, TABLE_COLLATION, TABLE_COMMENT
          FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`, [tab.db, name]),
        tab.view ? { rows: [] } : await q(`SELECT INDEX_NAME, NON_UNIQUE, COLUMN_NAME, SUB_PART, INDEX_TYPE, INDEX_COMMENT FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY INDEX_NAME = 'PRIMARY' DESC, INDEX_NAME, SEQ_IN_INDEX`, [tab.db, name]),
        tab.view ? { rows: [] } : await q(`SELECT k.CONSTRAINT_NAME, k.COLUMN_NAME, k.REFERENCED_TABLE_SCHEMA, k.REFERENCED_TABLE_NAME, k.REFERENCED_COLUMN_NAME, r.UPDATE_RULE, r.DELETE_RULE
          FROM information_schema.KEY_COLUMN_USAGE k JOIN information_schema.REFERENTIAL_CONSTRAINTS r
            ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME AND r.TABLE_NAME = k.TABLE_NAME
          WHERE k.TABLE_SCHEMA = ? AND k.TABLE_NAME = ? AND k.REFERENCED_TABLE_NAME IS NOT NULL ORDER BY k.CONSTRAINT_NAME, k.ORDINAL_POSITION`, [tab.db, name]),
        await q(`SHOW CREATE ${tab.view ? 'VIEW' : 'TABLE'} ${t}`, [], { maxCell: 1 << 20 }),
      ];
      const ro = ws.conn.readOnly || tab.view;
      const s = stats.rows[0] || [];
      const infoItems = tab.view ? [['Type', 'View']] : [
        ['Engine', s[0]], ['Rows (estimate)', s[1] === null ? '—' : Number(s[1]).toLocaleString()], ['Data', bytes(s[3])], ['Indexes', bytes(s[4])],
        ['Avg row', bytes(s[2])], ['Next auto-increment', s[5] ?? '—'], ['Collation', s[8]], ['Created', s[6] || '—'], ['Updated', s[7] || '—']];
      const table = (headers, rows) => h('table.plain', {}, h('thead', {}, h('tr', {}, ...headers.map(x => h('th', { text: x })))), h('tbody', {}, ...rows));
      const actions = (...buttons) => h('td', {}, h('div.row-actions', {}, ...buttons));
      const small = (label, run, danger) => h('button.button.small', { text: label, class: danger ? 'danger' : '', disabled: ro, onclick: run });

      // Group index rows by name.
      const indexMap = new Map();
      for (const [iname, nonUnique, col, sub, type, comment] of indexes.rows) {
        if (!indexMap.has(iname)) indexMap.set(iname, { name: iname, unique: nonUnique === '0', type, comment, columns: [] });
        indexMap.get(iname).columns.push(col + (sub ? `(${sub})` : ''));
      }
      const fkMap = new Map();
      for (const [cname, col, rdb, rtable, rcol, onUpdate, onDelete] of fks.rows) {
        if (!fkMap.has(cname)) fkMap.set(cname, { name: cname, columns: [], rdb, rtable, rcolumns: [], onUpdate, onDelete });
        fkMap.get(cname).columns.push(col); fkMap.get(cname).rcolumns.push(rcol);
      }
      const ddlText = (ddl.rows[0]?.[1] ?? '') + ';';
      structureView.replaceChildren(
        h('section', {}, h('h2', {}, tab.view ? 'View' : 'Table', h('span.spacer')),
          s[9] ? h('p.muted', { text: s[9] }) : null,
          h('dl.info-grid', {}, ...infoItems.map(([k, v]) => h('div', {}, h('dt', { text: k }), h('dd', { text: v ?? '—' }))))),
        h('section', {}, h('h2', {}, `Columns (${cols.length})`, h('span.spacer'), !ro && small('＋ Column', () => columnDialog(null))),
          table(['#', 'Name', 'Type', 'Nullable', 'Default', 'Key', 'Extra', 'Comment', ''], cols.map((c, i) => h('tr', { class: ro ? '' : 'clickable', ondblclick: () => !ro && !c.generated && columnDialog(c) },
            h('td.muted', { text: i + 1 }), h('td.mono', { text: c.name }), h('td.mono', { text: c.type }), h('td', { text: c.nullable ? 'YES' : 'NO' }),
            h('td.mono', { text: c.default === null ? (c.nullable ? 'NULL' : '—') : c.default }), h('td', { text: c.key }), h('td.muted', { text: c.extra }), h('td.muted', { text: c.comment }),
            ro ? h('td') : actions(small('Edit', () => columnDialog(c)), small('Drop', () => runDDL(`ALTER TABLE ${t} DROP COLUMN ${SQL.ident(c.name)}`, { danger: true, confirmName: c.name }), true)))))),
        tab.view ? null : h('section', {}, h('h2', {}, `Indexes (${indexMap.size})`, h('span.spacer'), !ro && small('＋ Index', () => indexDialog(cols))),
          indexMap.size ? table(['Name', 'Columns', 'Unique', 'Type', 'Comment', ''], [...indexMap.values()].map(ix => h('tr', {},
            h('td.mono', { text: ix.name }), h('td.mono', { text: ix.columns.join(', ') }), h('td', { text: ix.unique ? 'YES' : '' }), h('td', { text: ix.type }), h('td.muted', { text: ix.comment }),
            ro ? h('td') : actions(small('Drop', () => runDDL(`ALTER TABLE ${t} ${ix.name === 'PRIMARY' ? 'DROP PRIMARY KEY' : 'DROP INDEX ' + SQL.ident(ix.name)}`, { danger: true }), true))))) : h('p.muted', { text: 'No indexes.' })),
        tab.view ? null : h('section', {}, h('h2', {}, `Foreign keys (${fkMap.size})`, h('span.spacer'), !ro && small('＋ Foreign key', () => foreignKeyDialog(cols))),
          fkMap.size ? table(['Name', 'Columns', 'References', 'On update', 'On delete', ''], [...fkMap.values()].map(fk => h('tr', {},
            h('td.mono', { text: fk.name }), h('td.mono', { text: fk.columns.join(', ') }),
            h('td.mono', {}, h('button.link-button', { text: `${fk.rdb === tab.db ? '' : fk.rdb + '.'}${fk.rtable}(${fk.rcolumns.join(', ')})`, onclick: () => fk.rdb === ws.database && openTable(fk.rtable) })),
            h('td', { text: fk.onUpdate }), h('td', { text: fk.onDelete }),
            ro ? h('td') : actions(small('Drop', () => runDDL(`ALTER TABLE ${t} DROP FOREIGN KEY ${SQL.ident(fk.name)}`, { danger: true }), true))))) : h('p.muted', { text: 'No foreign keys.' })),
        h('section', {}, h('h2', {}, 'DDL', h('span.spacer'),
          h('button.button.small', { text: 'Copy', onclick: () => UI.copy(ddlText) }),
          h('button.button.small', { text: 'Open in Editor', onclick: () => newQuery(ddlText + '\n', name + ' DDL') })),
        h('pre.ddl', { text: ddlText })));
    } catch (error) {
      structureView.replaceChildren(h('p', { class: 'warning', text: message(error) }));
    }
  }

  async function columnDialog(existing) {
    const t = SQL.qualified(tab.db, name);
    const cols = await columnsFor(name, tab.db);
    const field = (value = '', placeholder = '') => h('input', { type: 'text', value, placeholder, spellcheck: false });
    const nameInput = field(existing?.name ?? '', 'column_name');
    const typeInput = field(existing?.type ?? 'varchar(255)', 'varchar(255)');
    typeInput.setAttribute('list', 'column-types');
    const types = h('datalist', { id: 'column-types' }, ...['int', 'int unsigned', 'bigint unsigned', 'tinyint(1)', 'decimal(10,2)', 'varchar(255)', 'char(36)', 'text', 'mediumtext', 'longtext', 'json',
      'datetime', 'timestamp', 'date', 'time', 'blob', 'enum(\'a\',\'b\')', 'boolean', 'double', 'float'].map(v => h('option', { value: v })));
    const nullable = h('input', { type: 'checkbox', checked: existing ? existing.nullable : true });
    const defaultMode = h('select', {}, ...[['none', 'No default'], ['null', 'NULL'], ['value', 'Value'], ['expr', 'Expression']].map(([v, l]) => h('option', { value: v, text: l })));
    const defaultValue = field('', 'value or CURRENT_TIMESTAMP');
    if (existing) {
      if (/DEFAULT_GENERATED/i.test(existing.extra)) { defaultMode.value = 'expr'; defaultValue.value = existing.default; }
      else if (existing.default !== null) { defaultMode.value = 'value'; defaultValue.value = existing.default; }
      else defaultMode.value = existing.nullable ? 'null' : 'none';
    }
    const auto = h('input', { type: 'checkbox', checked: existing?.autoIncrement });
    const comment = field(existing?.comment ?? '', 'Optional');
    const position = h('select', {}, h('option', { value: '', text: existing ? 'Keep position' : 'At the end' }), h('option', { value: 'FIRST', text: 'First' }),
      ...cols.filter(c => c.name !== existing?.name).map(c => h('option', { value: 'AFTER ' + SQL.ident(c.name), text: 'After ' + c.name })));
    const preview = h('pre.sql');
    const build = () => {
      const parts = [SQL.ident(nameInput.value.trim()), typeInput.value.trim()];
      if (existing?.collation && typeInput.value.trim() === existing.type && existing.charset) parts.push(`CHARACTER SET ${existing.charset} COLLATE ${existing.collation}`);
      parts.push(nullable.checked ? 'NULL' : 'NOT NULL');
      if (defaultMode.value === 'null') parts.push('DEFAULT NULL');
      if (defaultMode.value === 'value') parts.push('DEFAULT ' + SQL.literal(defaultValue.value));
      if (defaultMode.value === 'expr' && defaultValue.value.trim()) parts.push('DEFAULT ' + (/^[\w() ]+$/.test(defaultValue.value.trim()) && !/^\(/.test(defaultValue.value.trim()) ? defaultValue.value.trim() : `(${defaultValue.value.trim()})`));
      const onUpdate = /on update (\S+(?:\(\d*\))?)/i.exec(existing?.extra || '');
      if (onUpdate) parts.push('ON UPDATE ' + onUpdate[1]);
      if (auto.checked) parts.push('AUTO_INCREMENT');
      if (comment.value) parts.push('COMMENT ' + SQL.literal(comment.value));
      if (position.value) parts.push(position.value);
      return `ALTER TABLE ${t} ${existing ? 'CHANGE COLUMN ' + SQL.ident(existing.name) : 'ADD COLUMN'} ${parts.join(' ')}`;
    };
    const update = () => { defaultValue.hidden = defaultMode.value === 'none' || defaultMode.value === 'null'; preview.textContent = build() + ';'; };
    const body = h('div', {}, types, h('div.form', { oninput: update, onchange: update },
      h('label', { text: 'Name' }), nameInput, h('label', { text: 'Type' }), typeInput,
      h('label', { text: 'Default' }), h('div.inline', {}, defaultMode, defaultValue),
      h('label', { text: '' }), h('div.inline', {}, h('label.check', {}, nullable, 'Nullable'), h('label.check', {}, auto, 'Auto increment')),
      h('label', { text: 'Comment' }), comment, h('label', { text: 'Position' }), position,
      h('div.full', {}, preview)));
    update();
    const ok = await UI.modal({ title: existing ? `Edit column ${existing.name}` : `Add column to ${name}`, body, wide: true,
      buttons: [{ label: 'Cancel', value: false }, { label: existing ? 'Save Column' : 'Add Column', primary: true, value: true, run: () => { if (!nameInput.value.trim() || !typeInput.value.trim()) return false; } }] });
    if (ok) runDDL(build(), { then: () => loadStructure() });
  }

  async function indexDialog(cols) {
    const t = SQL.qualified(tab.db, name);
    const nameInput = h('input', { type: 'text', placeholder: 'idx_name' });
    const kind = h('select', {}, ...['INDEX', 'UNIQUE INDEX', 'FULLTEXT INDEX', 'PRIMARY KEY'].map(k => h('option', { value: k, text: k })));
    const picks = cols.map(c => ({ c, box: h('input', { type: 'checkbox' }) }));
    const order = [];
    const preview = h('pre.sql');
    const build = () => {
      const list = order.filter(o => o.box.checked).map(o => SQL.ident(o.c.name)).join(', ');
      return kind.value === 'PRIMARY KEY' ? `ALTER TABLE ${t} ADD PRIMARY KEY (${list})`
        : `ALTER TABLE ${t} ADD ${kind.value} ${SQL.ident(nameInput.value || 'idx_' + order.filter(o => o.box.checked).map(o => o.c.name).join('_'))} (${list})`;
    };
    for (const p of picks) p.box.addEventListener('change', () => { if (p.box.checked) order.push(p); else order.splice(order.indexOf(p), 1); preview.textContent = build() + ';'; });
    const body = h('div', { oninput: () => { preview.textContent = build() + ';'; }, onchange: () => { preview.textContent = build() + ';'; } },
      h('div.form', {}, h('label', { text: 'Type' }), kind, h('label', { text: 'Name' }), nameInput,
        h('label', { text: 'Columns' }), h('div.inline', {}, ...picks.map(p => h('label.check', {}, p.box, p.c.name)))),
      h('p.muted', { text: 'Columns are indexed in the order you tick them.' }), preview);
    preview.textContent = build() + ';';
    const ok = await UI.modal({ title: `Add index to ${name}`, body, wide: true, buttons: [{ label: 'Cancel', value: false },
      { label: 'Add Index', primary: true, value: true, run: () => { if (!order.length) return false; } }] });
    if (ok) runDDL(build(), { then: () => loadStructure() });
  }

  async function foreignKeyDialog(cols) {
    const t = SQL.qualified(tab.db, name);
    const column = h('select', {}, ...cols.map(c => h('option', { value: c.name, text: c.name })));
    const refTable = h('select', {}, ...ws.tables.filter(x => !x.view).map(x => h('option', { value: x.name, text: x.name })));
    const refColumn = h('select');
    const rules = ['RESTRICT', 'CASCADE', 'SET NULL', 'NO ACTION'];
    const onDelete = h('select', {}, ...rules.map(r => h('option', { value: r, text: r })));
    const onUpdate = h('select', {}, ...rules.map(r => h('option', { value: r, text: r })));
    const nameInput = h('input', { type: 'text', placeholder: 'fk_name (optional)' });
    const preview = h('pre.sql');
    const build = () => `ALTER TABLE ${t} ADD ${nameInput.value ? 'CONSTRAINT ' + SQL.ident(nameInput.value) + ' ' : ''}FOREIGN KEY (${SQL.ident(column.value)}) REFERENCES ${SQL.ident(refTable.value)} (${SQL.ident(refColumn.value)}) ON DELETE ${onDelete.value} ON UPDATE ${onUpdate.value}`;
    const fillRef = async () => {
      const rc = await columnsFor(refTable.value, tab.db);
      refColumn.replaceChildren(...rc.map(c => h('option', { value: c.name, text: c.name, selected: c.key === 'PRI' })));
      preview.textContent = build() + ';';
    };
    refTable.addEventListener('change', fillRef);
    const body = h('div', { onchange: () => { preview.textContent = build() + ';'; }, oninput: () => { preview.textContent = build() + ';'; } },
      h('div.form', {}, h('label', { text: 'Column' }), column, h('label', { text: 'References' }), h('div.inline', {}, refTable, refColumn),
        h('label', { text: 'On delete' }), onDelete, h('label', { text: 'On update' }), onUpdate, h('label', { text: 'Name' }), nameInput), preview);
    await fillRef();
    const ok = await UI.modal({ title: `Add foreign key to ${name}`, body, wide: true, buttons: [{ label: 'Cancel', value: false }, { label: 'Add Foreign Key', primary: true, value: true }] });
    if (ok) runDDL(build(), { then: () => loadStructure() });
  }

  // ---- Tab interface
  tab.setView = view => {
    tab.subview = view;
    for (const b of seg.children) b.setAttribute('aria-pressed', String(b.textContent.toLowerCase() === view));
    dataView.hidden = view !== 'data';
    structureView.hidden = view !== 'structure';
    filterButton.hidden = view !== 'data';
    if (view === 'data' && (!tab.loaded || tab.stale)) load();
    if (view === 'structure' && (!tab.structureLoaded || tab.stale)) loadStructure();
    saveSession();
  };
  tab.shown = () => { tab.setView(tab.subview); if (tab.subview === 'data') grid.sink.focus({ preventScroll: true }); };
  tab.refresh = async ({ soft = false } = {}) => {
    if (soft && tab.id !== ws.active) return;
    ws.columns.delete(tab.db + '\0' + name);
    tab.total = null;
    if (tab.subview === 'structure') loadStructure(); else await load();
  };
  tab.focusFilter = () => toggleFilters(true);
  return tab;
}

/** Full value viewer/editor for one cell (fetches truncated and binary values). */
async function openValue(grid, r, c, { table, db, keyCols } = {}) {
  const entry = grid.entries[r];
  const column = grid.columns[c];
  let value = entry.values[c];
  if (value && typeof value === 'object' && !value.$expr && entry.orig && table) {
    try {
      const key = grid.keyOf(entry);
      const where = Object.entries(key).map(([k, v]) => v === null ? `${SQL.ident(k)} IS NULL` : `${SQL.ident(k)} = ?`).join(' AND ');
      const r2 = await q(`SELECT ${value.$b !== undefined ? 'HEX(' + SQL.ident(column.name) + ')' : SQL.ident(column.name)} FROM ${SQL.qualified(db, table)} WHERE ${where} LIMIT 1`,
        Object.values(key).filter(v => v !== null), { maxRows: 1, maxCell: 16 << 20 });
      if (r2.rows.length) value = value.$b !== undefined ? { hex: r2.rows[0][0], n: value.n } : r2.rows[0][0];
    } catch (error) { status(message(error), true); }
  }
  const binary = value && typeof value === 'object' && (value.hex !== undefined || value.$b !== undefined);
  const text = value === null ? '' : binary ? (value.hex ?? SQL.base64Hex(value.$b)).replace(/(.{2})/g, '$1 ').replace(/((?:\S\S ){16})/g, '$1\n') : typeof value === 'object' ? (value.$t ?? value.$expr ?? '') : String(value);
  const area = h('textarea.value', { spellcheck: false, readonly: binary || !grid.editable || !!grid.canEdit(r, c) && grid.canEdit(r, c) !== 'open' });
  area.value = text;
  const isNull = h('input', { type: 'checkbox', checked: value === null, disabled: area.readOnly || column.nullable === false });
  let json = null;
  try { if (/^\s*[[{]/.test(text)) json = JSON.parse(text); } catch { json = null; }
  const truncated = value && typeof value === 'object' && value.$t !== undefined;
  const result = await UI.modal({
    title: column.name, text: [column.type, binary ? plural(value.n, 'byte') : plural(text.length, 'character'), truncated ? 'truncated preview' : ''].filter(Boolean).join(' · '),
    body: h('div', {}, area, !area.readOnly && h('label.check', { style: { marginTop: '6px' } }, isNull, 'Set to NULL')), wide: true, focus: area,
    buttons: [
      json && { label: 'Format JSON', left: true, keep: true, run: () => { area.value = JSON.stringify(JSON.parse(area.value), null, 2); } },
      { label: 'Copy', left: true, keep: true, run: () => UI.copy(area.value) },
      { label: area.readOnly ? 'Close' : 'Cancel', value: null },
      !area.readOnly && { label: 'Apply', primary: true, value: 'apply' },
    ].filter(Boolean),
  });
  if (result === 'apply') grid.setValue(r, c, isNull.checked ? null : area.value);
}

/** All columns of one row in a form. */
async function editRow(grid, r) {
  const entry = grid.entries[r];
  const fields = grid.columns.map((col, c) => {
    const value = entry.values[c];
    const locked = grid.canEdit(r, c);
    const area = h('textarea.field', { rows: 1, spellcheck: false, disabled: !!locked, style: { width: '100%', fontFamily: 'var(--mono)', fontSize: '12px', resize: 'vertical' } });
    area.value = value === null || typeof value === 'object' ? '' : String(value);
    area.placeholder = value === null ? 'NULL' : value && value.$expr ? value.$expr : '';
    const nul = h('input', { type: 'checkbox', checked: value === null, disabled: !!locked || col.nullable === false, title: 'NULL' });
    area.addEventListener('input', () => { nul.checked = false; });
    return { col, c, area, nul, locked, original: area.value, wasNull: value === null };
  });
  const body = h('div.form', {}, ...fields.flatMap(f => [h('label', { text: f.col.name, title: f.col.type }), h('div.inline', { style: { flexWrap: 'nowrap' } }, f.area, h('label.check', {}, f.nul, 'NULL'))]));
  const ok = await UI.modal({ title: `Row ${r + 1}`, body, wide: true, buttons: [{ label: 'Cancel', value: false }, { label: 'Apply', primary: true, value: true }] });
  if (!ok) return;
  for (const f of fields) {
    if (f.locked) continue;
    if (f.nul.checked && !f.wasNull) grid.setValue(r, f.c, null);
    else if (!f.nul.checked && (f.area.value !== f.original || f.wasNull)) grid.setValue(r, f.c, f.area.value);
  }
}

// ============================================================ Query tab

function newQuery(sql = '', name = null, { quiet = false } = {}) {
  const tab = queryTab(sql, name);
  if (quiet) { tab.id = ws.nextID++; ws.tabs.push(tab); $('#panes').append(tab.pane); tab.pane.hidden = true; renderTabs(); }
  else { addTab(tab); tab.editor.focus(); }
  return tab;
}

function queryTab(initial, name) {
  const tab = { kind: 'query', name, results: [], log: [], selected: 0, running: false };
  const number = ws.tabs.filter(t => t.kind === 'query').length + 1;
  tab.title = () => tab.name || `Query ${number}`;
  const runButton = h('button.button.small.primary', { text: '▶ Run', title: 'Run statement at cursor, or selection (⌘↩)', onclick: () => run(false) });
  const runAll = h('button.button.small', { text: 'Run All', title: 'Run every statement (⇧⌘↩)', onclick: () => run(true) });
  const explain = h('button.button.small', { text: 'Explain', title: 'EXPLAIN the statement at the cursor', onclick: () => run(false, { explain: true }) });
  const format = h('button.button.small', { text: 'Format', onclick: () => { const t = editor.target(); if (t?.selection) editor.insert(SQL.format(t.sql).trimEnd(), t.start, t.end); else editor.value = SQL.format(editor.value); } });
  const historyButton = h('button.button.small', { text: 'History', onclick: () => toggleHistory() });
  const saveButton = h('button.button.small', { text: '☆ Save', title: 'Save as a favorite query', onclick: () => saveFavorite() });
  const limit = h('select', { title: 'Maximum rows per result', onchange: () => { store.data.settings.maxRows = Number(limit.value); store.save(); } },
    ...[100, 1000, 5000, 20000, 50000].map(n => h('option', { value: n, text: `Limit ${n.toLocaleString()}`, selected: n === store.data.settings.maxRows })));
  const subbar = h('div.subbar', {}, runButton, runAll, explain, format, h('span.spacer'), saveButton, historyButton, limit);
  const editorArea = h('div.editor-area');
  const split = h('div.split', { role: 'separator', 'aria-orientation': 'horizontal', 'aria-label': 'Resize editor' });
  const resultTabs = h('div.result-tabs', { role: 'tablist' });
  const resultBody = h('div', { style: { flex: '1', minHeight: '0', display: 'flex', flexDirection: 'column' } });
  const messages = h('div.messages', { hidden: true });
  const gridHost = h('div', { style: { flex: '1', minHeight: '0', display: 'flex', flexDirection: 'column' } });
  resultBody.append(gridHost, messages);
  const info = h('span.muted');
  const commitGroup = h('div.group', { hidden: true },
    h('button.button.small', { text: 'Discard', onclick: () => grid.discard() }),
    h('button.button.small.primary', { text: 'Commit', onclick: () => commit() }));
  const footbar = h('div.footbar', {}, info, h('span.spacer'), commitGroup,
    h('button.button.small', { text: 'Export', onclick: event => { const r = event.target.getBoundingClientRect(); UI.menu(r.left, r.top - 110, ['CSV', 'JSON', 'SQL INSERT'].map(f => ({ label: `Copy result as ${f}`, run: () => copyResult(f) }))); } }));
  const results = h('div.results', {}, resultTabs, resultBody, footbar);
  const historyPanel = h('div.history', { hidden: true });
  const body = h('div.query', { style: { position: 'relative' } }, editorArea, split, results, historyPanel);
  tab.pane = h('div.pane', {}, subbar, body);

  const editor = new Editor(editorArea, {
    value: initial,
    onChange: () => { clearTimeout(tab.saveTimer); tab.saveTimer = setTimeout(saveSession, 800); },
    onRun: all => run(all),
    completions: () => ({ tables: ws.tables, columns: table => ws.columns.get(ws.database + '\0' + (ws.tables.find(t => t.name.toLowerCase() === table.toLowerCase())?.name ?? table)) || [] }),
  });
  tab.editor = editor;
  let editTarget = null;
  const grid = new Grid(gridHost, {
    sortMode: 'client',
    onStatus: text => status(text),
    onChange: () => { commitGroup.hidden = !grid.pending; renderTabs(); },
    onOpenValue: (r, c) => openValue(grid, r, c, editTarget ? { table: editTarget, db: ws.database } : {}),
    database: () => ws.database, table: () => editTarget || 'table',
    menuItems: ({ r, c }) => [{ label: 'Open Value…', run: () => openValue(grid, r, c, editTarget ? { table: editTarget, db: ws.database } : {}) },
      grid.editable && { label: 'Edit Row…', run: () => editRow(grid, r) }],
  });
  tab.grid = grid;
  tab.dirty = () => grid.pending > 0;
  grid.setData([], [], { emptyText: 'Run a query with ⌘↩.' });

  // Drag to resize the editor.
  split.addEventListener('mousedown', event => {
    event.preventDefault();
    const top = body.getBoundingClientRect().top;
    const move = e => { const pct = Math.max(10, Math.min(85, (e.clientY - top) / body.clientHeight * 100)); body.style.setProperty('--editor-height', pct + '%'); };
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });

  async function run(all, { explain = false } = {}) {
    if (tab.running) return;
    if (grid.pending && !await UI.confirm('Discard uncommitted result edits?', '', { label: 'Discard', danger: true })) return;
    let list = all ? SQL.split(editor.value) : [editor.target()].filter(Boolean);
    if (!list.length) { status('Nothing to run.'); return; }
    if (explain) list = list.map(s => ({ ...s, sql: /^\s*explain\b/i.test(s.sql) ? s.sql : 'EXPLAIN ' + s.sql }));
    // Safe mode: second look at writes on production and risky statements everywhere.
    const risky = list.map(s => SQL.risk(s.sql)).filter(Boolean);
    const writes = list.filter(s => SQL.isWrite(s.sql));
    if (risky.length || (writes.length && ws.conn.environment === 'production')) {
      const ok = await UI.confirm(ws.conn.environment === 'production' ? 'Run on production?' : 'Run this?',
        [...new Set(risky)].join(' ') || `${plural(writes.length, 'statement')} will change data.`,
        { label: 'Run', danger: true, sql: (risky.length ? list.filter(s => SQL.risk(s.sql)) : writes).map(s => s.sql + ';').join('\n\n') });
      if (!ok) return;
    }
    tab.running = true;
    runButton.disabled = runAll.disabled = true;
    tab.results = []; tab.log = [];
    editTarget = null;
    let schemaChanged = false, used = false;
    const started = performance.now();
    for (const statement of list) {
      try {
        const r = await q(statement.sql, [], { maxRows: store.data.settings.maxRows, maxCell: 4096 });
        tab.log.push({ sql: statement.sql, ok: true, r });
        if (r.columns.length) tab.results.push({ sql: statement.sql, r });
        const word = SQL.firstWord(statement.sql);
        if (['CREATE', 'ALTER', 'DROP', 'RENAME', 'TRUNCATE'].includes(word)) schemaChanged = true;
        if (word === 'USE') used = true;
      } catch (error) {
        tab.log.push({ sql: statement.sql, ok: false, error: message(error) });
        if (!statement.selection && statement.start !== undefined) {
          editor.area.focus();
          editor.area.setSelectionRange(statement.start, statement.end);
        }
        break;
      }
    }
    tab.running = false;
    runButton.disabled = runAll.disabled = false;
    addHistory(list.map(s => s.sql).join(';\n') + (list.length > 1 ? ';' : ''));
    const failed = tab.log.find(l => !l.ok);
    const total = Math.round(performance.now() - started);
    status(failed ? failed.error : `${plural(tab.log.length, 'statement')} in ${total} ms.`, !!failed);
    tab.selected = failed || !tab.results.length ? 'messages' : tab.results.length - 1;
    renderResults();
    if (used) {
      try { const r = await q('SELECT DATABASE()'); ws.database = r.rows[0][0] || ''; await loadDatabases(); await loadObjects(); } catch { /* ignore */ }
    } else if (schemaChanged) await loadObjects();
  }

  function renderResults() {
    resultTabs.replaceChildren(
      ...tab.results.map((res, i) => h('button', { role: 'tab', 'aria-selected': String(tab.selected === i), text: `Result ${i + 1}`, title: res.sql.slice(0, 300), onclick: () => { tab.selected = i; renderResults(); } })),
      h('button', { role: 'tab', 'aria-selected': String(tab.selected === 'messages'), text: tab.log.some(l => !l.ok) ? 'Messages ⚠' : 'Messages', onclick: () => { tab.selected = 'messages'; renderResults(); } }));
    const showMessages = tab.selected === 'messages';
    messages.hidden = !showMessages;
    gridHost.hidden = showMessages;
    commitGroup.hidden = true;
    if (showMessages) {
      messages.replaceChildren(...(tab.log.length ? tab.log.map(l => h('div.msg', {},
        h('span', { class: l.ok ? 'ok' : 'err', text: l.ok ? '✓' : '✕' }), h('div.sql', { text: l.sql }),
        h('span.muted', { text: l.ok && l.r.elapsed !== undefined ? `${l.r.elapsed.toFixed(1)} ms` : '' }),
        h('div.outcome', { class: l.ok ? '' : 'err', text: l.ok ? (l.r.columns.length ? `${plural(l.r.rows.length, 'row')}${l.r.truncated ? ' (limited)' : ''}` : `${plural(l.r.affected ?? 0, 'row')} affected${l.r.insertId ? ', last insert id ' + l.r.insertId : ''}`) : l.error })))
        : [h('p.muted', { style: { padding: '0 12px' }, text: 'No messages.' })]));
      info.textContent = tab.log.length ? `${plural(tab.log.filter(l => l.ok).length, 'statement')} succeeded` : '';
      return;
    }
    const res = tab.results[tab.selected];
    if (!res) { grid.setData([], [], { emptyText: 'Run a query with ⌘↩.' }); info.textContent = ''; return; }
    // Results from one table that include its key can be edited in place.
    const tables = new Set(res.r.columns.map(c => c.table));
    const only = tables.size === 1 ? [...tables][0] : '';
    const table = only && ws.tables.find(t => t.name === only && !t.view);
    const meta = table ? ws.columns.get(ws.database + '\0' + table.name) || [] : [];
    const keys = keyColumnsOf(meta);
    const names = res.r.columns.map(c => c.name);
    const editable = !!table && !ws.conn.readOnly && keys.length > 0 && keys.every(k => names.includes(k)) && names.every(n => meta.some(m => m.name === n)) && new Set(names).size === names.length;
    editTarget = editable ? table.name : null;
    grid.options.canEditReason = ws.conn.readOnly ? 'This connection is read-only.' : 'Only results from one table that include its primary key can be edited.';
    grid.setData(gridColumns(res.r.columns, editable ? meta : []), res.r.rows, { editable, keyColumns: editable ? keys : [], emptyText: 'No rows.' });
    info.textContent = `${plural(res.r.rows.length, 'row')}${res.r.truncated ? ` (limited to ${store.data.settings.maxRows.toLocaleString()})` : ''} · ${res.r.elapsed?.toFixed(1)} ms${editable ? ` · editable (${table.name})` : ''}`;
  }

  async function commit() {
    if (!editTarget || !grid.pending) return;
    const list = SQL.changeStatements(ws.database, editTarget, grid.changes());
    if (ws.conn.environment === 'production' && !await UI.confirm('Commit to production?', '', { label: 'Commit', danger: true, sql: list.map(s => SQL.inline(s.sql, s.params) + ';').join('\n') })) return;
    try {
      await call('execute', list);
      addHistory(list.map(s => SQL.inline(s.sql, s.params) + ';').join('\n'));
      UI.toast(`Committed ${plural(list.length, 'change')}`);
      // Keep the committed values on screen.
      for (const e of grid.entries) { e.orig = e.values.slice(); e.edited.clear(); e.state = e.state === 'insert' ? 'clean' : e.state; }
      grid.entries = grid.entries.filter(e => e.state !== 'delete');
      grid.render(); commitGroup.hidden = true; renderTabs();
    } catch (error) {
      UI.modal({ title: 'Nothing was committed', text: message(error), wide: true, body: h('pre.sql', { text: list.map(s => SQL.inline(s.sql, s.params) + ';').join('\n') }) });
    }
  }
  tab.commit = commit;

  function copyResult(f) {
    const res = tab.results[tab.selected];
    if (!res) return;
    const cols = res.r.columns.map(c => c.name);
    const rows = grid.entries.map(e => e.values);
    UI.copy(f === 'CSV' ? SQL.csv(cols, rows) : f === 'JSON' ? SQL.json(cols, rows) : SQL.inserts('', editTarget || res.r.columns[0]?.table || 'result', cols, rows));
  }

  async function saveFavorite() {
    const sql = editor.target()?.selection ? editor.target().sql : editor.value;
    if (!sql.trim()) return;
    const title = await UI.prompt('Save query', { value: tab.name || sql.trim().split('\n')[0].slice(0, 60), label: 'Save' });
    if (!title) return;
    store.data.favorites = [{ name: title, sql: sql.slice(0, 8000), at: Date.now() }, ...store.data.favorites.filter(f => f.name !== title)].slice(0, 60);
    store.save();
    UI.toast('Saved to favorites');
  }

  function toggleHistory(show = historyPanel.hidden, mode = 'history') {
    historyPanel.hidden = !show;
    if (!show) return;
    const search = h('input.search.small', { type: 'search', placeholder: 'Search', oninput: () => draw() });
    const modeSelect = h('div.segmented', {},
      h('button', { text: 'History', 'aria-pressed': String(mode === 'history'), onclick: () => toggleHistory(true, 'history') }),
      h('button', { text: 'Saved', 'aria-pressed': String(mode === 'saved'), onclick: () => toggleHistory(true, 'saved') }));
    const list = h('ul');
    const draw = () => {
      const term = search.value.toLowerCase();
      const items = (mode === 'history' ? store.data.history : store.data.favorites).filter(x => !term || x.sql.toLowerCase().includes(term) || (x.name || '').toLowerCase().includes(term));
      list.replaceChildren(...items.slice(0, 200).map(item => h('li', { title: 'Click to insert, double-click to replace and run',
        onclick: () => { editor.insert((editor.value && !editor.value.endsWith('\n') ? '\n\n' : '') + item.sql, editor.value.length, editor.value.length); },
        ondblclick: () => { editor.value = item.sql; toggleHistory(false); run(true); } },
      h('div.when', {}, h('span', { text: item.name || new Date(item.at).toLocaleString() }), h('span', { text: item.db || '' }),
        mode === 'saved' && h('button.link-button', { text: 'Delete', onclick: event => { event.stopPropagation(); store.data.favorites = store.data.favorites.filter(f => f !== item); store.save(); draw(); } })),
      h('pre', { text: item.sql }))));
      if (!items.length) list.append(h('li.muted', { text: mode === 'history' ? 'No queries yet.' : 'Save queries with ☆ Save.' }));
    };
    historyPanel.replaceChildren(h('header', {}, modeSelect, search, h('button.icon-button', { text: '×', 'aria-label': 'Close', onclick: () => toggleHistory(false) })), list);
    draw();
    search.focus();
  }

  tab.shown = () => editor.focus();
  tab.refresh = async () => { await loadObjects(); };
  tab.run = run;
  return tab;
}

function addHistory(sql) {
  if (!sql.trim()) return;
  const h0 = store.data.history[0];
  if (h0 && h0.sql === sql) { h0.at = Date.now(); store.save(); return; }
  store.data.history.unshift({ sql, at: Date.now(), db: ws?.database || '', conn: ws?.conn?.id || '' });
  store.save();
}

// ============================================================ Quick open (⌘P)

function fuzzy(text, term) {
  if (!term) return { score: 0, marks: [] };
  const lower = text.toLowerCase();
  const direct = lower.indexOf(term);
  if (direct >= 0) return { score: direct === 0 ? 0 : 1 + direct / 100, marks: [...Array(term.length)].map((_, i) => direct + i) };
  const marks = [];
  let at = 0;
  for (const ch of term) { at = lower.indexOf(ch, at); if (at < 0) return null; marks.push(at++); }
  return { score: 10 + (marks[marks.length - 1] - marks[0]) / text.length, marks };
}

function quickOpen() {
  if (!ws) return;
  const input = h('input', { type: 'text', placeholder: 'Open table, view, saved query or database…', spellcheck: false });
  const list = h('ul', { role: 'listbox' });
  const entries = [
    ...ws.tables.map(t => ({ icon: t.view ? '◫' : '▦', label: t.name, note: t.view ? 'view' : compact(t.rows), run: () => openTable(t.name) })),
    ...ws.routines.map(r => ({ icon: 'ƒ', label: r.name, note: r.type.toLowerCase(), run: () => showRoutine(r) })),
    ...store.data.favorites.map(f => ({ icon: '☆', label: f.name, note: 'saved query', run: () => newQuery(f.sql, f.name) })),
    ...ws.databases.filter(d => d !== ws.database).map(d => ({ icon: '⛁', label: d, note: 'switch database', run: () => useDatabase(d) })),
    { icon: '⌨', label: 'New SQL query', note: '⌥⌘N', run: () => newQuery() },
  ];
  let index = 0;
  let shown = [];
  const draw = () => {
    const term = input.value.trim().toLowerCase();
    shown = entries.map(e => ({ e, m: fuzzy(e.label, term) })).filter(x => x.m).sort((a, b) => a.m.score - b.m.score).slice(0, 60);
    index = Math.min(index, Math.max(0, shown.length - 1));
    list.replaceChildren(...shown.map(({ e, m }, i) => {
      const label = h('span', { style: { flex: '1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } });
      [...e.label].forEach((ch, j) => label.append(m.marks.includes(j) ? h('mark', { text: ch }) : ch));
      return h('li', { class: i === index ? 'active' : '', role: 'option', onmousedown: event => { event.preventDefault(); index = i; pick(); } },
        h('span.icon', { text: e.icon }), label, h('span.muted', { text: e.note || '' }));
    }));
    list.children[index]?.scrollIntoView({ block: 'nearest' });
  };
  let close;
  const pick = () => { const chosen = shown[index]?.e; close(); chosen?.run(); };
  input.addEventListener('input', () => { index = 0; draw(); });
  input.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); index = (index + (event.key === 'ArrowDown' ? 1 : -1) + shown.length) % Math.max(1, shown.length); draw(); }
    if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); pick(); }
  });
  const promise = UI.modal({ body: h('div', {}, input, list), buttons: [], focus: input, className: 'palette' });
  close = () => UI.layer.querySelector('.palette')?.closest('.backdrop')?.remove();
  promise.then(() => {});
  draw();
}

// ============================================================ Wiring

function bindWorkspace() {
  $('#back').addEventListener('click', disconnect);
  $('#refresh').addEventListener('click', refresh);
  $('#new-query').addEventListener('click', () => newQuery());
  $('#quick-open').addEventListener('click', quickOpen);
  $('#stop').addEventListener('click', () => { cancelQuery(); status('Stopping…'); });
  $('#database-select').addEventListener('change', event => useDatabase(event.target.value));
  $('#object-filter').addEventListener('input', renderSidebar);
  $('#object-filter').addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      const first = $('#objects button');
      first?.click();
    } else if (event.key === 'Escape') { event.target.value = ''; renderSidebar(); }
  });
  $('#new-table').addEventListener('click', () => newQuery(`CREATE TABLE \`new_table\` (
  \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  \`name\` VARCHAR(255) NOT NULL,
  \`created_at\` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  \`updated_at\` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (\`id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`, 'New table'));
  // Sidebar width.
  $('#sidebar-resizer').addEventListener('mousedown', event => {
    event.preventDefault();
    const move = e => { const w = Math.max(150, Math.min(innerWidth * 0.5, e.clientX)); document.documentElement.style.setProperty('--sidebar', w + 'px'); store.data.settings.sidebar = w; };
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); store.save(); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });
}

async function refresh() {
  if (!ws) return;
  const tab = activeTab();
  if (tab?.kind === 'table') { await tab.refresh(); return; }
  await loadDatabases();
  await loadObjects();
  status('Refreshed.');
}

function bindHome() {
  $('#new-connection').addEventListener('click', async () => {
    if (bridge.mode === 'legacy') return connect('legacy');
    await editConnection();
  });
  $('#import-url').addEventListener('click', async () => {
    try {
      const saved = await call('importURL');
      if (saved) { await loadConnections(); selectConnection(saved.id); homeStatus(`Imported ${saved.title}. Press Return to connect.`); }
    } catch (error) { homeStatus(message(error), true); }
  });
  $('#connection-search').addEventListener('input', () => { home.selected = 0; renderHome(); });
  document.addEventListener('keydown', event => {
    if ($('#home').hidden || UI.layer.querySelector('.backdrop, .menu')) return;
    const list = home.visible || [];
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      home.selected = Math.max(0, Math.min(list.length - 1, home.selected + (event.key === 'ArrowDown' ? 1 : -1)));
      renderHome();
    } else if (event.key === 'Enter' && list[home.selected] && event.target.tagName !== 'BUTTON') {
      event.preventDefault(); connect(list[home.selected].id);
    } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'n') {
      event.preventDefault(); editConnection();
    }
  });
}

/** Touch screens: a long press opens the same menus a right-click does. */
function bindLongPress() {
  let timer = null, fired = false, start = null;
  const cancel = () => { clearTimeout(timer); timer = null; };
  document.addEventListener('touchstart', event => {
    fired = false;
    if (event.touches.length !== 1 || event.target.closest('input, textarea, select, .menu')) return;
    const t = event.touches[0];
    start = { x: t.clientX, y: t.clientY, target: event.target };
    cancel();
    timer = setTimeout(() => {
      fired = true;
      start.target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 2, clientX: start.x, clientY: start.y }));
      start.target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: start.x, clientY: start.y }));
    }, 550);
  }, { passive: true });
  document.addEventListener('touchmove', event => {
    const t = event.touches[0];
    if (start && t && Math.hypot(t.clientX - start.x, t.clientY - start.y) > 8) cancel();
  }, { passive: true });
  document.addEventListener('touchend', event => { cancel(); if (fired) event.preventDefault(); });
  document.addEventListener('touchcancel', cancel);
}

function bindShortcuts() {
  bindLongPress();
  document.addEventListener('mousedown', event => { if (!event.target.closest('.menu') && event.isTrusted) UI.closeMenus(); });
  document.addEventListener('keydown', event => {
    if (!ws || $('#workspace').hidden) return;
    if (UI.layer.querySelector('.backdrop')) return;
    const meta = event.metaKey || event.ctrlKey;
    const key = event.key.toLowerCase();
    const tab = activeTab();
    if (meta && key === 'p') { event.preventDefault(); quickOpen(); }
    else if (meta && key === 'r') { event.preventDefault(); refresh(); }
    else if (meta && key === 's') { event.preventDefault(); tab?.commit?.(); }
    else if (meta && key === '.') { event.preventDefault(); cancelQuery(); status('Stopping…'); }
    else if (meta && (key === 't' || (event.altKey && (key === 'n' || event.code === 'KeyN')))) { event.preventDefault(); newQuery(); }
    else if (meta && event.altKey && (key === 'w' || event.code === 'KeyW')) { event.preventDefault(); if (tab) closeTab(tab.id); }
    else if (meta && key === 'f' && tab?.kind === 'table') { event.preventDefault(); tab.focusFilter(); }
    else if (meta && event.shiftKey && (event.code === 'BracketRight' || event.code === 'BracketLeft')) { event.preventDefault(); cycleTab(event.code === 'BracketRight' ? 1 : -1); }
    else if (event.ctrlKey && event.key === 'Tab') { event.preventDefault(); cycleTab(event.shiftKey ? -1 : 1); }
    else if (meta && key === 'k' && !event.shiftKey) { event.preventDefault(); $('#object-filter').focus(); $('#object-filter').select(); }
  });
  window.addEventListener('beforeunload', () => { saveSession(); store.write(); });
}

async function init() {
  UI.layer = $('#layer');
  bindHome();
  bindWorkspace();
  bindShortcuts();
  await store.load();
  if (store.data.settings.sidebar) document.documentElement.style.setProperty('--sidebar', store.data.settings.sidebar + 'px');
  await detect();
  await loadConnections();
  if (bridge.mode === 'full') $('#connection-list').focus?.();
}

init();
