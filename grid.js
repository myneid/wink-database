'use strict';
// A spreadsheet-style result grid: cell selection, inline editing, pending
// inserts/updates/deletes, copy and paste. Knows nothing about databases;
// app.js turns grid.changes() into SQL.

(function (root) {
  const DEFAULT = Object.freeze({ $expr: 'DEFAULT' });
  const NUMERIC = /^(tinyint|smallint|mediumint|int|integer|bigint|decimal|numeric|float|double|real|bit|year|long|longlong|short|tiny|newdecimal|int24)/i;

  const isObject = v => v !== null && typeof v === 'object';
  const same = (a, b) => a === b || (isObject(a) && isObject(b) && JSON.stringify(a) === JSON.stringify(b));

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function display(value) {
    if (value === null || value === undefined) return { text: 'NULL', cls: 'null' };
    if (value === DEFAULT || (isObject(value) && value.$expr)) return { text: value.$expr, cls: 'null' };
    if (isObject(value) && value.$b !== undefined) return { text: `BLOB ${value.n.toLocaleString()} bytes`, cls: 'blob' };
    if (isObject(value) && value.$t !== undefined) return { text: value.$t.slice(0, 200).replace(/\r?\n/g, '⏎') + '…', cls: 'truncated' };
    const s = String(value);
    return { text: (s.length > 300 ? s.slice(0, 300) + '…' : s).replace(/\r?\n/g, '⏎'), cls: '' };
  }

  class Grid {
    /**
     * options: onChange(), onSort(columnName), sortMode ('server'|'client'),
     * menuItems(info) → extra context-menu items, onOpenValue(r, c),
     * onStatus(text), canEditReason (string when not editable)
     */
    constructor(host, options = {}) {
      this.options = options;
      this.wrap = el('div', 'grid-wrap');
      this.wrap.tabIndex = -1;
      this.sink = el('textarea', 'grid-sink');
      this.sink.setAttribute('aria-label', 'Grid keyboard input');
      this.sink.tabIndex = 0;
      host.append(this.wrap);
      this.columns = [];
      this.entries = [];
      this.widths = {};
      this.keyColumns = [];
      this.editable = false;
      this.sort = null;
      this.anchor = this.focus = null;
      this.rowMode = false;
      this.undoStack = [];
      this.selected = [];
      this.bind();
    }

    // ---------- Data ----------

    setData(columns, rows, { editable = false, keyColumns = [], sort = null, emptyText = 'No rows' } = {}) {
      this.columns = columns.map(c => ({ ...c, numeric: c.numeric ?? NUMERIC.test(c.type || '') }));
      this.entries = rows.map(row => ({ orig: row, values: row.slice(), state: 'clean', edited: new Set() }));
      this.editable = editable;
      this.keyColumns = keyColumns;
      this.sort = sort;
      this.emptyText = emptyText;
      this.undoStack = [];
      this.anchor = this.focus = this.entries.length && this.columns.length ? { r: 0, c: 0 } : null;
      this.rowMode = false;
      this.render();
    }

    get pending() {
      return this.entries.filter(e => e.state === 'insert' || e.state === 'delete' || e.edited.size).length;
    }

    keyOf(entry) {
      const key = {};
      const indexes = this.keyColumns.length
        ? this.keyColumns.map(name => this.columns.findIndex(c => c.name === name))
        : this.columns.map((_, i) => i).filter(i => !isObject(entry.orig[i]));
      for (const i of indexes) key[this.columns[i].name] = entry.orig[i];
      return key;
    }

    changes() {
      const out = [];
      for (const entry of this.entries) {
        const values = {};
        for (const c of entry.edited) values[this.columns[c].name] = entry.values[c];
        if (entry.state === 'insert') out.push({ kind: 'insert', values });
        else if (entry.state === 'delete') out.push({ kind: 'delete', key: this.keyOf(entry) });
        else if (entry.edited.size) out.push({ kind: 'update', key: this.keyOf(entry), values });
      }
      return out;
    }

    discard() {
      this.entries = this.entries.filter(e => e.state !== 'insert');
      for (const e of this.entries) { e.values = e.orig.slice(); e.state = 'clean'; e.edited.clear(); }
      this.undoStack = [];
      this.render();
      this.changed();
    }

    changed() { this.options.onChange?.(); }

    snapshot(r) {
      const e = this.entries[r];
      this.undoStack.push({ r, entry: { ...e, values: e.values.slice(), edited: new Set(e.edited) }, count: this.entries.length });
      if (this.undoStack.length > 200) this.undoStack.shift();
    }

    undo() {
      const step = this.undoStack.pop();
      if (!step) return;
      if (step.count < this.entries.length) this.entries.splice(step.r, 1);   // undo an added row
      else if (step.count > this.entries.length) this.entries.splice(step.r, 0, step.entry);
      else this.entries[step.r] = step.entry;
      this.render();
      this.changed();
    }

    canEdit(r, c) {
      const entry = this.entries[r];
      const col = this.columns[c];
      if (!this.editable) return this.options.canEditReason || 'These results can’t be edited.';
      if (!entry || entry.state === 'delete') return 'This row is marked for deletion.';
      if (col.generated) return `${col.name} is a generated column.`;
      if (entry.state !== 'insert' && isObject(entry.values[c]) && !entry.values[c].$expr) return 'open';
      return null;
    }

    setValue(r, c, value, { record = true } = {}) {
      const entry = this.entries[r];
      if (!entry || entry.state === 'delete') return;
      if (record) this.snapshot(r);
      entry.values[c] = value;
      if (entry.state === 'insert') {
        if (value === DEFAULT) entry.edited.delete(c); else entry.edited.add(c);
      } else if (same(value, entry.orig[c])) entry.edited.delete(c);
      else entry.edited.add(c);
      this.renderRow(r);
      this.changed();
    }

    addRow(values) {
      const entry = {
        orig: null, state: 'insert', edited: new Set(),
        values: this.columns.map((_, i) => values ? values[i] : DEFAULT),
      };
      if (values) values.forEach((v, i) => { if (v !== DEFAULT) entry.edited.add(i); });
      this.entries.push(entry);
      this.undoStack.push({ r: this.entries.length - 1, entry, count: this.entries.length - 1 });
      this.render();
      const r = this.entries.length - 1;
      const c = Math.max(0, this.columns.findIndex(col => !col.autoIncrement));
      this.select({ r, c });
      this.changed();
      return r;
    }

    duplicateRows(rows) {
      for (const r of rows) {
        const source = this.entries[r];
        if (!source) continue;
        this.addRow(source.values.map((v, i) => {
          const col = this.columns[i];
          return col.autoIncrement || col.generated || isObject(v) ? DEFAULT : v;
        }));
      }
    }

    deleteRows(rows) {
      if (!this.editable) { this.options.onStatus?.(this.options.canEditReason || 'These results can’t be edited.'); return; }
      for (const r of [...rows].sort((a, b) => b - a)) {
        const entry = this.entries[r];
        if (!entry) continue;
        if (entry.state === 'insert') {
          this.undoStack.push({ r, entry, count: this.entries.length });
          this.entries.splice(r, 1);
        } else {
          this.snapshot(r);
          entry.state = entry.state === 'delete' ? 'clean' : 'delete';
        }
      }
      this.render();
      this.changed();
    }

    revertRows(rows) {
      for (const r of [...rows].sort((a, b) => b - a)) {
        const entry = this.entries[r];
        if (!entry) continue;
        this.snapshot(r);
        if (entry.state === 'insert') this.entries.splice(r, 1);
        else { entry.values = entry.orig.slice(); entry.state = 'clean'; entry.edited.clear(); }
      }
      this.render();
      this.changed();
    }

    // ---------- Selection ----------

    rect() {
      if (!this.anchor || !this.focus) return null;
      const last = this.columns.length - 1;
      return {
        r1: Math.min(this.anchor.r, this.focus.r), r2: Math.max(this.anchor.r, this.focus.r),
        c1: this.rowMode ? 0 : Math.min(this.anchor.c, this.focus.c), c2: this.rowMode ? last : Math.max(this.anchor.c, this.focus.c),
      };
    }

    selectedRows() {
      const rect = this.rect();
      if (!rect) return [];
      return Array.from({ length: rect.r2 - rect.r1 + 1 }, (_, i) => rect.r1 + i);
    }

    selection() {
      const rect = this.rect();
      if (!rect) return { columns: [], rows: [] };
      const columns = this.columns.slice(rect.c1, rect.c2 + 1).map(c => c.name);
      const rows = this.selectedRows().map(r => this.entries[r].values.slice(rect.c1, rect.c2 + 1));
      return { columns, rows, rect };
    }

    select(focus, { extend = false, rowMode = false } = {}) {
      if (!this.entries.length) return;
      focus = { r: Math.max(0, Math.min(this.entries.length - 1, focus.r)), c: Math.max(0, Math.min(this.columns.length - 1, focus.c)) };
      if (!extend || !this.anchor) { this.anchor = focus; this.rowMode = rowMode; }
      this.focus = focus;
      this.paintSelection();
      this.cell(focus.r, focus.c)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      this.focusKeys();
    }

    /** Keyboard focus without summoning the on-screen keyboard on touch screens. */
    focusKeys() {
      if (this.lastPointer === 'touch') this.wrap.focus({ preventScroll: true });
      else this.sink.focus({ preventScroll: true });
    }

    selectAll() {
      if (!this.entries.length) return;
      this.anchor = { r: 0, c: 0 };
      this.focus = { r: this.entries.length - 1, c: this.columns.length - 1 };
      this.rowMode = true;
      this.paintSelection();
    }

    paintSelection() {
      for (const node of this.selected) node.classList.remove('sel', 'cursor', 'sel-row');
      this.selected = [];
      const rect = this.rect();
      if (!rect || !this.tbody) return;
      const multi = rect.r1 !== rect.r2 || rect.c1 !== rect.c2;
      for (let r = rect.r1; r <= rect.r2; r++) {
        const tr = this.tbody.rows[r];
        if (!tr) continue;
        if (this.rowMode) { tr.classList.add('sel-row'); this.selected.push(tr); }
        for (let c = rect.c1; c <= rect.c2; c++) {
          const td = tr.cells[c + 1];
          if (multi) { td.classList.add('sel'); this.selected.push(td); }
        }
      }
      const cursor = this.cell(this.focus.r, this.focus.c);
      if (cursor) { cursor.classList.add('cursor'); this.selected.push(cursor); }
      this.options.onSelect?.();
    }

    cell(r, c) { return this.tbody?.rows[r]?.cells[c + 1]; }

    // ---------- Rendering ----------

    estimateWidth(col, index) {
      if (this.widths[col.name]) return this.widths[col.name];
      let chars = Math.max(col.name.length + (col.key ? 2 : 0), (col.type || '').length * 0.8);
      for (const e of this.entries.slice(0, 60)) chars = Math.max(chars, Math.min(40, display(e.values[index]).text.length));
      return Math.round(Math.max(64, Math.min(340, chars * 7.3 + 22)));
    }

    render() {
      this.closeEditor(false);
      const table = el('table', 'grid');
      const colgroup = el('colgroup');
      const gutterWidth = 22 + String(this.entries.length).length * 7;
      const gutterCol = el('col'); gutterCol.style.width = gutterWidth + 'px';
      colgroup.append(gutterCol);
      this.cols = this.columns.map((col, i) => {
        const node = el('col');
        node.style.width = this.estimateWidth(col, i) + 'px';
        colgroup.append(node);
        return node;
      });
      const thead = el('thead');
      const head = thead.insertRow();
      const corner = el('th', 'gutter');
      corner.title = 'Select all';
      head.append(corner);
      this.columns.forEach((col, i) => {
        const th = el('th');
        th.dataset.c = i;
        th.title = [col.name, col.type, col.nullable === false ? 'NOT NULL' : '', col.comment || ''].filter(Boolean).join(' · ');
        if (col.key === 'PRI') th.append(el('span', 'key', '⚷'));
        th.append(document.createTextNode(col.name));
        if (this.sort?.column === col.name) th.append(el('span', 'sort', this.sort.dir === 'DESC' ? '▼' : '▲'));
        if (col.type) th.append(el('span', 'type', col.type));
        th.append(el('span', 'resize'));
        head.append(th);
      });
      this.tbody = el('tbody');
      const fragment = document.createDocumentFragment();
      this.entries.forEach((_, r) => fragment.append(this.rowElement(r)));
      this.tbody.append(fragment);
      table.style.width = (gutterWidth + this.cols.reduce((sum, c) => sum + parseInt(c.style.width, 10), 0)) + 'px';
      table.append(colgroup, thead, this.tbody);
      this.table = table;
      const children = [table, this.sink];
      if (!this.entries.length) children.splice(1, 0, el('div', 'grid-empty', this.emptyText));
      this.wrap.replaceChildren(...children);
      this.selected = [];
      if (this.anchor && this.anchor.r >= this.entries.length) this.anchor = this.focus = this.entries.length ? { r: this.entries.length - 1, c: 0 } : null;
      this.paintSelection();
    }

    rowElement(r) {
      const entry = this.entries[r];
      const tr = el('tr', entry.state === 'clean' ? '' : entry.state === 'insert' ? 'inserted' : 'deleted');
      tr.append(el('td', 'gutter', entry.state === 'insert' ? '+' : String(r + 1)));
      entry.values.forEach((value, c) => {
        const shown = display(value);
        const td = el('td', [shown.cls, this.columns[c]?.numeric && !shown.cls ? 'number' : '', entry.edited.has(c) && entry.state !== 'insert' ? 'edited' : ''].filter(Boolean).join(' '), shown.text);
        tr.append(td);
      });
      return tr;
    }

    renderRow(r) {
      const old = this.tbody?.rows[r];
      if (!old) return this.render();
      old.replaceWith(this.rowElement(r));
      this.selected = [];
      this.paintSelection();
    }

    // ---------- Editing ----------

    edit(r, c, initial) {
      const reason = this.canEdit(r, c);
      if (reason === 'open') { this.options.onOpenValue?.(r, c); return; }
      if (reason) { this.options.onStatus?.(reason); return; }
      this.closeEditor(false);
      const td = this.cell(r, c);
      if (!td) return;
      const col = this.columns[c];
      const value = this.entries[r].values[c];
      let input;
      if (col.enum?.length) {
        input = el('select', 'grid-editor');
        const options = [...(col.nullable !== false ? [['__null', 'NULL']] : []), ...col.enum.map(v => [v, v])];
        if (this.entries[r].state === 'insert') options.unshift(['__default', 'DEFAULT']);
        for (const [v, label] of options) { const o = el('option', '', label); o.value = v; input.append(o); }
        input.value = value === null ? '__null' : value === DEFAULT ? '__default' : String(value);
      } else {
        input = el('textarea', 'grid-editor');
        input.value = initial ?? (value === null || isObject(value) ? '' : String(value));
        input.placeholder = value === null ? 'NULL' : value === DEFAULT ? 'DEFAULT' : '';
        input.spellcheck = false;
        input.setAttribute('autocapitalize', 'off');
        input.setAttribute('autocorrect', 'off');
        input.setAttribute('autocomplete', 'off');
      }
      const lines = input.value ? input.value.split('\n').length : 1;
      input.style.left = (td.offsetLeft + this.table.offsetLeft) + 'px';
      input.style.top = (td.offsetTop + this.table.offsetTop) + 'px';
      input.style.width = Math.max(td.offsetWidth, 180) + 'px';
      input.style.height = Math.max(td.offsetHeight, Math.min(220, lines * 17 + 10)) + 'px';
      this.editor = { input, r, c, original: input.value };
      input.addEventListener('keydown', event => {
        if (event.key === 'Escape') { event.preventDefault(); this.closeEditor(false); this.focusKeys(); }
        else if (event.key === 'Enter' && !event.shiftKey && !event.altKey) {
          event.preventDefault(); this.closeEditor(true); this.select({ r: r + 1, c });
        } else if (event.key === 'Tab') {
          event.preventDefault(); this.closeEditor(true); this.select({ r, c: c + (event.shiftKey ? -1 : 1) });
        }
        event.stopPropagation();
      });
      input.addEventListener('blur', () => { if (this.editor?.input === input) this.closeEditor(true); });
      this.wrap.append(input);
      input.focus();
      if (input.select && initial === undefined) input.select();
    }

    closeEditor(commit) {
      const editor = this.editor;
      if (!editor) return;
      this.editor = null;
      editor.input.remove();
      if (!commit) return;
      let value = editor.input.value;
      if (editor.input.tagName === 'SELECT') {
        value = value === '__null' ? null : value === '__default' ? DEFAULT : value;
        if (same(value, this.entries[editor.r].values[editor.c])) return;
      } else if (value === editor.original) return;
      this.setValue(editor.r, editor.c, value);
    }

    paste(text) {
      if (!this.focus) return;
      const rows = text.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n').map(line => line.split('\t'));
      const rect = this.rect();
      // One value pasted into a selection fills the selection.
      const fill = rows.length === 1 && rows[0].length === 1 && (rect.r1 !== rect.r2 || rect.c1 !== rect.c2);
      const targets = fill ? this.selectedRows().flatMap(r => Array.from({ length: rect.c2 - rect.c1 + 1 }, (_, i) => [r, rect.c1 + i, rows[0][0]]))
        : rows.flatMap((line, dr) => line.map((v, dc) => [rect.r1 + dr, rect.c1 + dc, v]));
      let skipped = 0;
      for (const [r, c, raw] of targets) {
        if (r >= this.entries.length || c >= this.columns.length) { skipped++; continue; }
        if (this.canEdit(r, c)) { skipped++; continue; }
        this.setValue(r, c, raw === 'NULL' ? null : raw);
      }
      if (skipped) this.options.onStatus?.(`${skipped} pasted value${skipped === 1 ? '' : 's'} skipped.`);
    }

    // ---------- Sorting (client) ----------

    sortBy(name) {
      const i = this.columns.findIndex(c => c.name === name);
      if (i < 0) return;
      const dir = this.sort?.column === name && this.sort.dir === 'ASC' ? 'DESC' : 'ASC';
      if (this.sort?.column === name && this.sort.dir === 'DESC') { this.sort = null; }
      else this.sort = { column: name, dir };
      if (this.options.sortMode === 'server') { this.options.onSort?.(this.sort); return; }
      const numeric = this.columns[i].numeric;
      const key = e => e.values[i];
      const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
      if (this.sort) {
        const m = this.sort.dir === 'DESC' ? -1 : 1;
        this.entries.sort((a, b) => {
          const x = key(a), y = key(b);
          if (x === null || y === null) return x === y ? 0 : x === null ? -m : m;
          if (numeric) return (Number(x) - Number(y)) * m;
          return collator.compare(String(isObject(x) ? x.$t ?? '' : x), String(isObject(y) ? y.$t ?? '' : y)) * m;
        });
      } else this.entries.sort((a, b) => (a.orig ? 0 : 1) - (b.orig ? 0 : 1));
      this.render();
    }

    // ---------- Events ----------

    bind() {
      let dragging = false;
      this.lastPointer = 'mouse';
      this.wrap.addEventListener('pointerdown', event => { this.lastPointer = event.pointerType || 'mouse'; }, true);
      this.wrap.addEventListener('keydown', event => { if (event.target === this.wrap) this.key(event); });
      const position = target => {
        const td = target.closest('td');
        if (!td || !this.tbody?.contains(td)) return null;
        return { r: td.parentElement.sectionRowIndex, c: td.cellIndex - 1 };
      };
      this.wrap.addEventListener('mousedown', event => {
        if (event.target.closest('.grid-editor')) return;
        const resize = event.target.closest('.resize');
        if (resize) return this.startResize(event, Number(resize.parentElement.dataset.c));
        const th = event.target.closest('th');
        if (th) {
          event.preventDefault();
          if (th.classList.contains('gutter')) this.selectAll();
          else this.sortBy(this.columns[Number(th.dataset.c)].name);
          this.focusKeys();
          return;
        }
        const at = position(event.target);
        if (!at) { this.focusKeys(); return; }
        if (event.button === 2) {
          const rect = this.rect();
          const inside = rect && at.r >= rect.r1 && at.r <= rect.r2 && (at.c < 0 || (at.c >= rect.c1 && at.c <= rect.c2));
          if (!inside) this.select({ r: at.r, c: Math.max(0, at.c) }, { rowMode: at.c < 0 });
          return;
        }
        event.preventDefault();
        // Touch: tapping the selected cell again edits it (there's no double-click).
        if (this.lastPointer === 'touch' && !event.shiftKey && at.c >= 0 && !this.rowMode && this.focus
            && this.focus.r === at.r && this.focus.c === at.c && this.anchor.r === at.r && this.anchor.c === at.c) {
          this.edit(at.r, at.c);
          return;
        }
        if (at.c < 0) this.select({ r: at.r, c: this.columns.length - 1 }, { extend: event.shiftKey, rowMode: true });
        else this.select(at, { extend: event.shiftKey });
        dragging = true;
      });
      this.wrap.addEventListener('mouseover', event => {
        if (!dragging) return;
        const at = position(event.target);
        if (at) this.select({ r: at.r, c: this.rowMode ? this.columns.length - 1 : Math.max(0, at.c) }, { extend: true });
      });
      window.addEventListener('mouseup', () => { dragging = false; });
      this.wrap.addEventListener('dblclick', event => {
        const at = position(event.target);
        if (at && at.c >= 0) this.edit(at.r, at.c);
      });
      this.wrap.addEventListener('contextmenu', event => {
        if (event.target.closest('.grid-editor')) return;
        const at = position(event.target);
        if (!at) return;
        event.preventDefault();
        this.showMenu(event.clientX, event.clientY);
      });
      this.sink.addEventListener('keydown', event => this.key(event));
      this.sink.addEventListener('paste', event => {
        event.preventDefault();
        const text = event.clipboardData?.getData('text/plain');
        if (text) this.paste(text);
      });
      this.sink.addEventListener('copy', event => {
        event.preventDefault();
        event.clipboardData.setData('text/plain', root.SQL.tsvRows(this.selection().rows));
      });
    }

    startResize(event, c) {
      event.preventDefault();
      event.stopPropagation();
      const start = event.clientX;
      const width = parseInt(this.cols[c].style.width, 10);
      const tableWidth = parseInt(this.table.style.width, 10);
      const move = e => {
        const w = Math.max(40, width + e.clientX - start);
        this.cols[c].style.width = w + 'px';
        this.table.style.width = (tableWidth + w - width) + 'px';
        this.widths[this.columns[c].name] = w;
      };
      const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    }

    key(event) {
      const meta = event.metaKey || event.ctrlKey;
      const f = this.focus;
      if (!f) return;
      const page = Math.max(1, Math.floor(this.wrap.clientHeight / 22) - 1);
      const moves = {
        ArrowUp: { r: meta ? 0 : f.r - 1, c: f.c }, ArrowDown: { r: meta ? this.entries.length - 1 : f.r + 1, c: f.c },
        ArrowLeft: { r: f.r, c: meta ? 0 : f.c - 1 }, ArrowRight: { r: f.r, c: meta ? this.columns.length - 1 : f.c + 1 },
        PageUp: { r: f.r - page, c: f.c }, PageDown: { r: f.r + page, c: f.c },
        Home: { r: meta ? 0 : f.r, c: 0 }, End: { r: meta ? this.entries.length - 1 : f.r, c: this.columns.length - 1 },
      };
      if (moves[event.key]) {
        event.preventDefault();
        this.select(moves[event.key], { extend: event.shiftKey, rowMode: event.shiftKey && this.rowMode });
        return;
      }
      if (meta && event.key.toLowerCase() === 'a') { event.preventDefault(); this.selectAll(); return; }
      if (meta && event.key.toLowerCase() === 'c') {
        const { columns, rows } = this.selection();
        this.sink.value = (event.altKey ? columns.join('\t') + '\n' : '') + root.SQL.tsvRows(rows);
        this.sink.select();
        return;   // the browser copies the sink's selection
      }
      if (meta && event.key.toLowerCase() === 'v') { this.sink.value = ''; return; }
      if (meta && event.key.toLowerCase() === 'z' && !event.shiftKey) { event.preventDefault(); this.undo(); return; }
      if (meta && event.key === 'Backspace') { event.preventDefault(); this.deleteRows(this.selectedRows()); return; }
      if ((event.key === 'Backspace' || event.key === 'Delete') && this.rowMode) { event.preventDefault(); this.deleteRows(this.selectedRows()); return; }
      if (event.key === 'Enter' || event.key === 'F2') { event.preventDefault(); this.edit(f.r, f.c); return; }
      if (event.key === 'Tab') { event.preventDefault(); this.select({ r: f.r, c: f.c + (event.shiftKey ? -1 : 1) }); return; }
      if (event.key === 'Escape') { if (this.rowMode || this.anchor.r !== f.r || this.anchor.c !== f.c) { event.preventDefault(); this.select(f); } return; }
      if (event.key.length === 1 && !meta && !event.altKey && this.editable) {
        event.preventDefault();
        this.edit(f.r, f.c, event.key);
      }
    }

    showMenu(x, y) {
      const UI = root.UI;
      const rows = this.selectedRows();
      const { r, c } = this.focus;
      const entry = this.entries[r];
      const col = this.columns[c];
      const many = rows.length > 1 ? ` (${rows.length} rows)` : '';
      const copy = text => UI.copy(text);
      const sel = () => this.selection();
      const items = [
        { label: 'Copy', hint: '⌘C', run: () => copy(root.SQL.tsvRows(sel().rows)) },
        { label: 'Copy with Headers', hint: '⌥⌘C', run: () => { const s = sel(); copy(s.columns.join('\t') + '\n' + root.SQL.tsvRows(s.rows)); } },
        { label: 'Copy Rows as', submenu: [
          { label: 'CSV', run: () => copy(root.SQL.csv(this.columns.map(c => c.name), rows.map(i => this.entries[i].values))) },
          { label: 'JSON', run: () => copy(root.SQL.json(this.columns.map(c => c.name), rows.map(i => this.entries[i].values))) },
          { label: 'SQL INSERT', run: () => copy(root.SQL.inserts(this.options.database?.() || '', this.options.table?.() || 'table', this.columns.map(c => c.name), rows.map(i => this.entries[i].values))) },
        ] },
        { label: 'Copy Column Name', run: () => copy(col.name) },
        '-',
        ...(this.options.menuItems?.({ r, c, rows, column: col, value: entry?.values[c] }) || []),
      ];
      if (this.editable) {
        items.push('-',
          { label: 'Edit Cell', hint: '↩', run: () => this.edit(r, c) },
          { label: 'Set NULL', disabled: col.nullable === false, run: () => this.forSelection(null) },
          { label: 'Set Empty String', run: () => this.forSelection('') },
          ...(entry?.state === 'insert' ? [{ label: 'Set DEFAULT', run: () => this.forSelection(DEFAULT) }] : []),
          '-',
          { label: 'Add Row', run: () => this.addRow() },
          { label: 'Duplicate Row' + many, run: () => this.duplicateRows(rows) },
          { label: (entry?.state === 'delete' ? 'Undelete Row' : 'Delete Row') + many, hint: '⌘⌫', danger: entry?.state !== 'delete', run: () => this.deleteRows(rows) },
          { label: 'Revert Changes' + many, disabled: !rows.some(i => this.entries[i].state !== 'clean' || this.entries[i].edited.size), run: () => this.revertRows(rows) });
      }
      UI.menu(x, y, items);
    }

    forSelection(value) {
      const rect = this.rect();
      for (const r of this.selectedRows()) for (let c = rect.c1; c <= rect.c2; c++) if (!this.canEdit(r, c)) this.setValue(r, c, value);
    }
  }

  Grid.DEFAULT = DEFAULT;
  Grid.display = display;
  root.Grid = Grid;
})(window);
