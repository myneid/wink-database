'use strict';

const byID = id => document.getElementById(id);
const connect = byID('connect');
const run = byID('run');
const cancel = byID('cancel');
const sql = byID('sql');
const status = byID('status');
const tables = byID('tables');
const results = byID('results');
let connected = false;

function setBusy(busy) {
  connect.disabled = busy;
  run.disabled = busy || !connected;
  cancel.disabled = !busy;
  for (const button of tables.querySelectorAll('button')) button.disabled = busy;
}

function drawResult({ columns, rows, truncated }) {
  const header = document.createElement('thead');
  const heading = header.insertRow();
  for (const column of columns) {
    const cell = document.createElement('th');
    cell.scope = 'col';
    cell.textContent = column;
    heading.append(cell);
  }
  const body = document.createElement('tbody');
  for (const row of rows) {
    const line = body.insertRow();
    for (const value of row) line.insertCell().textContent = value === null ? 'NULL' : String(value);
  }
  results.replaceChildren(header, body);
  status.textContent = rows.length + (truncated ? ' rows shown (result capped).' : ' rows returned.');
}

async function query(action) {
  setBusy(true);
  status.textContent = 'Running query…';
  try { await action(); }
  catch (error) { status.textContent = error.message || String(error); }
  finally { setBusy(false); }
}

function runEditor() {
  if (run.disabled) return;
  results.replaceChildren();
  return query(async () => drawResult(await blink.database.query(sql.value.trim())));
}

connect.addEventListener('click', async () => {
  connect.disabled = true;
  try {
    if (!await blink.database.connect()) return;
    connected = true;
    results.replaceChildren();
    tables.replaceChildren();
    await query(async () => {
      const { rows } = await blink.database.query('SHOW FULL TABLES');
      for (const [name] of rows) {
        const item = document.createElement('li');
        const button = document.createElement('button');
        button.textContent = name;
        button.addEventListener('click', () => {
          sql.value = 'SELECT * FROM `' + name.replaceAll('`', '``') + '` LIMIT 100;';
          runEditor();
        });
        item.append(button);
        tables.append(item);
      }
      status.textContent = 'Select a table or run a query.';
    });
  } catch (error) {
    status.textContent = error.message || String(error);
  } finally { setBusy(false); }
});

run.addEventListener('click', runEditor);
cancel.addEventListener('click', () => blink.database.cancel());
sql.addEventListener('keydown', event => {
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    runEditor();
  }
});

async function detectDatabase() {
  const unavailable = 'This app is installed, but this host does not support MySQL connections yet. Use Wink 0.9.3 or newer.';
  try {
    const host = window.blink;
    const info = await host?.host?.info?.();
    if (info?.capabilities?.includes('database') &&
        ['connect', 'query', 'cancel'].every(method => typeof host.database?.[method] === 'function')) {
      connect.disabled = false;
      return;
    }
  } catch {
    // An older host may not expose feature detection.
  }
  status.textContent = unavailable;
}

detectDatabase();
