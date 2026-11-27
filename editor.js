'use strict';
// SQL editor: a textarea over a highlighted <pre>, with line numbers,
// current-statement highlight, indent/comment keys and autocomplete.

(function (root) {
  const SQL = () => root.SQL;
  const escape = s => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

  class Editor {
    /** options: value, onChange(value), onRun(all), completions() → {tables, columns(table), keywords} */
    constructor(host, options = {}) {
      this.options = options;
      this.root = document.createElement('div');
      this.root.className = 'editor';
      this.lines = document.createElement('div');
      this.lines.className = 'lines';
      const code = document.createElement('div');
      code.className = 'code';
      this.pre = document.createElement('pre');
      this.pre.setAttribute('aria-hidden', 'true');
      this.area = document.createElement('textarea');
      this.area.spellcheck = false;
      this.area.wrap = 'off';
      this.area.setAttribute('autocapitalize', 'off');
      this.area.setAttribute('autocomplete', 'off');
      this.area.setAttribute('autocorrect', 'off');
      this.area.setAttribute('aria-label', 'SQL editor');
      this.area.value = options.value || '';
      code.append(this.pre, this.area);
      this.root.append(this.lines, code);
      host.append(this.root);
      this.popup = null;
      this.bind();
      this.paint();
    }

    get value() { return this.area.value; }
    set value(v) { this.area.value = v; this.paint(); this.options.onChange?.(v); }
    focus() { this.area.focus(); }

    /** The selection, or the statement under the cursor. */
    target() {
      const { selectionStart: a, selectionEnd: b, value } = this.area;
      if (b > a && value.slice(a, b).trim()) return { sql: value.slice(a, b), start: a, end: b, selection: true };
      return SQL().statementAt(value, a);
    }

    paint() {
      const value = this.area.value;
      const current = SQL().statementAt(value, this.area.selectionStart);
      let html = '';
      for (const t of SQL().scan(value)) {
        const text = escape(t.text);
        html += t.type === 'space' || t.type === 'op' || t.type === 'word' || t.type === 'semi' ? text : `<span class="t-${t.type}">${text}</span>`;
      }
      // Mark the statement ⌘↩ would run, unless it's the whole editor.
      if (current && SQL().split(value).length > 1) {
        html = this.mark(value, current.start, current.end);
      }
      this.pre.innerHTML = html + '\n';
      const count = value.split('\n').length;
      if (count !== this.lineCount) {
        this.lineCount = count;
        this.lines.textContent = Array.from({ length: count }, (_, i) => i + 1).join('\n');
      }
      this.sync();
    }

    mark(value, start, end) {
      let html = '';
      let open = false;
      for (const t of SQL().scan(value)) {
        let piece = '';
        const tEnd = t.start + t.text.length;
        // split tokens that straddle the statement boundary
        const cuts = [t.start, ...[start, end].filter(x => x > t.start && x < tEnd), tEnd];
        for (let i = 0; i < cuts.length - 1; i++) {
          if (!open && cuts[i] >= start && cuts[i] < end) { piece += '<span class="current">'; open = true; }
          if (open && cuts[i] >= end) { piece += '</span>'; open = false; }
          const text = escape(value.slice(cuts[i], cuts[i + 1]));
          piece += ['space', 'op', 'word', 'semi'].includes(t.type) ? text : `<span class="t-${t.type}">${text}</span>`;
        }
        html += piece;
      }
      return html + (open ? '</span>' : '');
    }

    sync() {
      this.pre.scrollTop = this.area.scrollTop;
      this.pre.scrollLeft = this.area.scrollLeft;
      this.lines.scrollTop = this.area.scrollTop;
    }

    insert(text, start = this.area.selectionStart, end = this.area.selectionEnd) {
      this.area.focus();
      this.area.setSelectionRange(start, end);
      // execCommand keeps the native undo stack.
      if (!document.execCommand('insertText', false, text)) this.area.setRangeText(text, start, end, 'end');
      this.paint();
      this.options.onChange?.(this.area.value);
    }

    bind() {
      let frame = 0;
      const repaint = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => this.paint()); };
      this.area.addEventListener('input', () => { repaint(); this.options.onChange?.(this.area.value); this.complete(false); });
      this.area.addEventListener('scroll', () => { this.sync(); this.closePopup(); });
      this.area.addEventListener('click', () => { repaint(); this.closePopup(); });
      this.area.addEventListener('keyup', event => { if (event.key.startsWith('Arrow') || event.key === 'Home' || event.key === 'End') repaint(); });
      this.area.addEventListener('blur', () => setTimeout(() => this.closePopup(), 150));
      this.area.addEventListener('keydown', event => this.key(event));
    }

    key(event) {
      const meta = event.metaKey || event.ctrlKey;
      if (this.popup) {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          this.popup.index = (this.popup.index + (event.key === 'ArrowDown' ? 1 : -1) + this.popup.items.length) % this.popup.items.length;
          this.drawPopup();
          return;
        }
        if (event.key === 'Enter' || event.key === 'Tab') { event.preventDefault(); this.accept(); return; }
        if (event.key === 'Escape') { event.preventDefault(); this.closePopup(); return; }
      }
      if (event.key === 'Enter' && meta) {
        event.preventDefault();
        this.options.onRun?.(event.shiftKey);
        return;
      }
      if (event.key === ' ' && event.ctrlKey) { event.preventDefault(); this.complete(true); return; }
      if (event.key === 'Tab') { event.preventDefault(); this.indent(event.shiftKey); return; }
      if (event.key === '/' && meta) { event.preventDefault(); this.toggleComment(); return; }
      if (event.key === 'Enter' && !event.shiftKey && !event.altKey) {
        const { value, selectionStart } = this.area;
        const lineStart = value.lastIndexOf('\n', selectionStart - 1) + 1;
        const indent = value.slice(lineStart, selectionStart).match(/^[ \t]*/)[0];
        if (indent) { event.preventDefault(); this.insert('\n' + indent); }
      }
    }

    selectedLines() {
      const { value, selectionStart: a, selectionEnd: b } = this.area;
      const start = value.lastIndexOf('\n', a - 1) + 1;
      let end = value.indexOf('\n', b > a && value[b - 1] === '\n' ? b - 1 : b);
      if (end < 0) end = value.length;
      return { start, end, text: value.slice(start, end) };
    }

    indent(outdent) {
      const { selectionStart: a, selectionEnd: b } = this.area;
      if (a === b && !outdent) { this.insert('  '); return; }
      const lines = this.selectedLines();
      const next = lines.text.split('\n').map(l => outdent ? l.replace(/^( {1,2}|\t)/, '') : '  ' + l).join('\n');
      this.insert(next, lines.start, lines.end);
      this.area.setSelectionRange(lines.start, lines.start + next.length);
    }

    toggleComment() {
      const lines = this.selectedLines();
      const all = lines.text.split('\n');
      const commented = all.filter(l => l.trim()).every(l => /^\s*-- ?/.test(l));
      const next = all.map(l => !l.trim() ? l : commented ? l.replace(/^(\s*)-- ?/, '$1') : l.replace(/^(\s*)/, '$1-- ')).join('\n');
      this.insert(next, lines.start, lines.end);
      this.area.setSelectionRange(lines.start, lines.start + next.length);
    }

    // ---------- Autocomplete ----------

    complete(force) {
      const { value, selectionStart: at, selectionEnd } = this.area;
      if (at !== selectionEnd) return this.closePopup();
      const before = value.slice(0, at);
      const match = before.match(/(?:`?([\w$]+)`?\.)?`?([\w$]*)$/);
      const prefix = match[2] || '';
      const owner = match[1];
      if (!force && !owner && prefix.length < 2) return this.closePopup();
      const source = this.options.completions?.() || {};
      const statement = SQL().statementAt(value, at)?.sql || value;
      const aliases = {};
      for (const m of statement.matchAll(/\b(?:from|join|update|into|table)\s+(?:`?[\w$]+`?\.)?`?([\w$]+)`?(?:\s+(?:as\s+)?`?([\w$]+)`?)?/gi)) {
        aliases[m[1].toLowerCase()] = m[1];
        if (m[2] && !SQL().KEYWORDS.has(m[2].toUpperCase())) aliases[m[2].toLowerCase()] = m[1];
      }
      let items = [];
      const lower = prefix.toLowerCase();
      if (owner) {
        const table = aliases[owner.toLowerCase()] || owner;
        items = (source.columns?.(table) || []).map(c => ({ text: c.name, kind: c.type || 'column' }));
      } else {
        const tables = source.tables || [];
        const mentioned = Object.values(aliases);
        const columns = [...new Set(mentioned)].flatMap(t => (source.columns?.(t) || []).map(c => ({ text: c.name, kind: t })));
        items = [
          ...columns,
          ...tables.map(t => ({ text: t.name, kind: t.view ? 'view' : 'table' })),
          ...[...SQL().KEYWORDS].map(k => ({ text: k, kind: 'keyword' })),
          ...[...SQL().FUNCTIONS].map(f => ({ text: f + '(', kind: 'function' })),
        ];
      }
      const seen = new Set();
      items = items.filter(i => {
        const t = i.text.toLowerCase();
        if (seen.has(t + i.kind) || (lower && !t.startsWith(lower)) || t === lower) return false;
        seen.add(t + i.kind);
        return true;
      }).slice(0, 80);
      if (!items.length) return this.closePopup();
      this.popup = { items, index: 0, start: at - prefix.length, upper: prefix && prefix === prefix.toUpperCase() && /[A-Z]/.test(prefix) };
      this.drawPopup();
    }

    drawPopup() {
      if (!this.popupEl) {
        this.popupEl = document.createElement('ul');
        this.popupEl.className = 'completions';
        this.popupEl.setAttribute('role', 'listbox');
        this.popupEl.addEventListener('mousedown', event => {
          const li = event.target.closest('li');
          if (!li) return;
          event.preventDefault();
          this.popup.index = Number(li.dataset.i);
          this.accept();
        });
        this.root.append(this.popupEl);
      }
      const { items, index } = this.popup;
      this.popupEl.replaceChildren(...items.map((item, i) => {
        const li = document.createElement('li');
        li.dataset.i = i;
        li.className = i === index ? 'active' : '';
        const text = document.createElement('span');
        text.textContent = item.text;
        const kind = document.createElement('span');
        kind.className = 'kind';
        kind.textContent = item.kind;
        li.append(text, kind);
        return li;
      }));
      this.popupEl.children[index]?.scrollIntoView({ block: 'nearest' });
      const { line, column } = this.caret();
      const style = getComputedStyle(this.area);
      const charWidth = this.charWidth || (this.charWidth = this.measure());
      const lineHeight = parseFloat(style.lineHeight) || 20;
      const left = this.lines.offsetWidth + parseFloat(style.paddingLeft) + column * charWidth - this.area.scrollLeft;
      const top = parseFloat(style.paddingTop) + (line + 1) * lineHeight - this.area.scrollTop + 2;
      this.popupEl.style.left = Math.min(left, this.root.clientWidth - 230) + 'px';
      this.popupEl.style.top = (top + 220 > this.root.clientHeight && top > 240 ? top - lineHeight - 224 : top) + 'px';
    }

    accept() {
      const item = this.popup?.items[this.popup.index];
      if (!item) return;
      let text = item.kind === 'keyword' && !this.popup.upper ? item.text.toUpperCase() : item.text;
      if (item.kind !== 'keyword' && item.kind !== 'function' && !/^[A-Za-z_][\w$]*$/.test(text)) text = SQL().ident(text);
      const start = this.popup.start;
      this.closePopup();
      this.insert(text, start, this.area.selectionStart);
    }

    closePopup() {
      this.popup = null;
      this.popupEl?.remove();
      this.popupEl = null;
    }

    caret() {
      const before = this.area.value.slice(0, this.area.selectionStart);
      const lines = before.split('\n');
      return { line: lines.length - 1, column: lines[lines.length - 1].replace(/\t/g, '  ').length };
    }

    measure() {
      const span = document.createElement('span');
      span.textContent = 'x'.repeat(100);
      span.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;font:inherit';
      this.pre.append(span);
      const width = span.getBoundingClientRect().width / 100;
      span.remove();
      return width || 7.8;
    }
  }

  root.Editor = Editor;
})(window);
