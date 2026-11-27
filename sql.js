'use strict';
// SQL helpers with no DOM: quoting, statement splitting, highlighting tokens,
// filters and the statements that save grid edits. Loaded by index.html and
// by tests/sql.test.cjs.

(function (root) {
  const KEYWORDS = new Set(`ADD ALL ALTER ANALYZE AND AS ASC AUTO_INCREMENT BEGIN BETWEEN BIGINT BINARY BLOB BOOLEAN BOTH BY CALL CASCADE CASE
    CAST CHANGE CHAR CHARACTER CHARSET CHECK COLLATE COLUMN COLUMNS COMMENT COMMIT CONSTRAINT CREATE CROSS CURRENT_DATE CURRENT_TIMESTAMP
    DATABASE DATABASES DATE DATETIME DECIMAL DEFAULT DELETE DESC DESCRIBE DISTINCT DIV DOUBLE DROP DUPLICATE ELSE END ENGINE ENUM ESCAPE EXISTS
    EXPLAIN FALSE FIELDS FIRST FLOAT FOR FOREIGN FROM FULL FULLTEXT FUNCTION GRANT GROUP HAVING IF IGNORE IN INDEX INNER INSERT INT INTEGER
    INTERVAL INTO IS JOIN JSON KEY KEYS KILL LAST LEADING LEFT LIKE LIMIT LOCK LONGTEXT MEDIUMINT MEDIUMTEXT MODIFY NATURAL NOT NULL OFFSET
    ON OR ORDER OUTER PRIMARY PROCEDURE PROCESSLIST REFERENCES REGEXP RENAME REPLACE RESTRICT RETURNS REVOKE RIGHT ROLLBACK ROW ROWS SCHEMA
    SELECT SET SHOW SMALLINT START STATUS TABLE TABLES TEMPORARY TEXT THEN TIME TIMESTAMP TINYINT TINYTEXT TO TRAILING TRANSACTION TRIGGER
    TRUE TRUNCATE UNION UNIQUE UNSIGNED UPDATE USE USING VALUES VARCHAR VARIABLES VIEW WHEN WHERE WITH XOR YEAR ZEROFILL`.split(/\s+/));

  const FUNCTIONS = new Set(`ABS AVG COALESCE CONCAT CONCAT_WS COUNT CURDATE CURTIME DATE_ADD DATE_FORMAT DATE_SUB DATEDIFF FIND_IN_SET
    FLOOR GREATEST GROUP_CONCAT HEX IFNULL INSTR JSON_ARRAY JSON_EXTRACT JSON_OBJECT JSON_UNQUOTE LCASE LEAST LENGTH LOCATE LOWER LPAD LTRIM
    MAX MD5 MIN MOD NOW NULLIF RAND ROUND RPAD RTRIM SHA1 SHA2 SUBSTR SUBSTRING SUM TRIM UCASE UNHEX UNIX_TIMESTAMP UPPER UUID`.split(/\s+/));

  const ident = name => '`' + String(name).replaceAll('`', '``') + '`';
  const qualified = (db, table) => (db ? ident(db) + '.' : '') + ident(table);

  /** A literal for display (previews, copy as SQL). Queries bind params instead. */
  function literal(value) {
    if (value === null || value === undefined) return 'NULL';
    if (typeof value === 'object' && value.$expr) return value.$expr;
    if (typeof value === 'number' || typeof value === 'bigint') return String(value);
    return "'" + String(value).replace(/[\0\n\r\b\t\\'\x1a]/g, ch => ({
      '\0': '\\0', '\n': '\\n', '\r': '\\r', '\b': '\\b', '\t': '\\t', '\\': '\\\\', "'": "\\'", '\x1a': '\\Z' }[ch])) + "'";
  }

  /** Inlines ? params for display only. */
  function inline(sql, params = []) {
    let index = 0;
    return scan(sql).map(t => t.type === 'param' ? literal(params[index++]) : t.text).join('');
  }

  /**
   * Tokens: keyword, function, ident, string, number, comment, param, op,
   * space, word. Concatenating every token's text gives back the input.
   */
  function scan(sql) {
    const tokens = [];
    let i = 0;
    const n = sql.length;
    const push = (type, start) => tokens.push({ type, text: sql.slice(start, i), start });
    while (i < n) {
      const start = i;
      const c = sql[i], d = sql[i + 1];
      if (c === '-' && d === '-' && (i + 2 >= n || /\s/.test(sql[i + 2])) || c === '#') {
        while (i < n && sql[i] !== '\n') i++;
        push('comment', start);
      } else if (c === '/' && d === '*') {
        const end = sql.indexOf('*/', i + 2);
        i = end < 0 ? n : end + 2;
        push('comment', start);
      } else if (c === "'" || c === '"' || c === '`') {
        i++;
        while (i < n) {
          if (sql[i] === '\\' && c !== '`') { i += 2; continue; }
          if (sql[i] === c) { if (sql[i + 1] === c) { i += 2; continue; } i++; break; }
          i++;
        }
        push(c === '`' ? 'ident' : 'string', start);
      } else if (/\s/.test(c)) {
        while (i < n && /\s/.test(sql[i])) i++;
        push('space', start);
      } else if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(d || ''))) {
        while (i < n && /[0-9a-fA-FxX.eE]/.test(sql[i])) i++;
        push('number', start);
      } else if (/[A-Za-z_$@\u0080-￿]/.test(c)) {
        while (i < n && /[A-Za-z0-9_$@\u0080-￿]/.test(sql[i])) i++;
        const word = sql.slice(start, i).toUpperCase();
        const next = sql.slice(i).match(/^\s*\(/);
        push(FUNCTIONS.has(word) && next ? 'function' : KEYWORDS.has(word) ? 'keyword' : 'word', start);
      } else if (c === '?') {
        i++; push('param', start);
      } else {
        i++; push(c === ';' ? 'semi' : 'op', start);
      }
    }
    return tokens;
  }

  /** Statements with their offsets; handles quotes, comments and DELIMITER. */
  function split(sql) {
    const out = [];
    let delimiter = ';';
    let start = 0;
    let i = 0;
    const tokens = scan(sql);
    // DELIMITER lines are client syntax; honor them like the mysql client.
    const text = sql;
    const pushStatement = (from, to) => {
      const raw = text.slice(from, to);
      const trimmed = raw.trim();
      if (trimmed && !/^(--[^\n]*\n?|#[^\n]*\n?|\/\*[\s\S]*?\*\/|\s)*$/.test(trimmed)) {
        const lead = raw.length - raw.trimStart().length;
        out.push({ sql: trimmed, start: from + lead, end: from + lead + trimmed.length });
      }
    };
    while (i < tokens.length) {
      const t = tokens[i];
      const lineStart = t.start === 0 || text[t.start - 1] === '\n';
      if (t.type !== 'space' && lineStart && /^delimiter$/i.test(t.text)) {
        pushStatement(start, t.start);
        const lineEnd = text.indexOf('\n', t.start);
        const line = text.slice(t.start, lineEnd < 0 ? text.length : lineEnd);
        delimiter = line.replace(/^delimiter\s+/i, '').trim() || ';';
        start = lineEnd < 0 ? text.length : lineEnd + 1;
        while (i < tokens.length && tokens[i].start < start) i++;
        continue;
      }
      if (delimiter === ';' ? t.type === 'semi' : (t.type !== 'string' && t.type !== 'comment' && t.type !== 'ident' && text.startsWith(delimiter, t.start))) {
        pushStatement(start, t.start);
        start = t.start + delimiter.length;
        while (i < tokens.length && tokens[i].start < start) i++;
        continue;
      }
      i++;
    }
    pushStatement(start, text.length);
    return out;
  }

  /** The statement under the cursor (or the one just before it). */
  function statementAt(sql, cursor) {
    const all = split(sql);
    if (!all.length) return null;
    return all.find(s => cursor >= s.start && cursor <= s.end + 1)
      || [...all].reverse().find(s => s.end < cursor) || all[0];
  }

  const firstWord = sql => (scan(sql).find(t => !['space', 'comment', 'op'].includes(t.type))?.text || '').toUpperCase();

  const READS = new Set(['SELECT', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN', 'USE', 'WITH', 'HELP', 'TABLE', 'VALUES']);
  const isWrite = sql => !READS.has(firstWord(sql));

  /** Why a statement deserves a second look before it runs, or null. */
  function risk(sql) {
    const word = firstWord(sql);
    const words = scan(sql).filter(t => t.type === 'keyword' || t.type === 'word').map(t => t.text.toUpperCase());
    if ((word === 'UPDATE' || word === 'DELETE') && !words.includes('WHERE')) return `${word} without WHERE changes every row.`;
    if (word === 'DROP') return 'DROP permanently removes ' + (words[1] || 'it').toLowerCase() + '.';
    if (word === 'TRUNCATE') return 'TRUNCATE removes every row.';
    if (word === 'ALTER' && words.includes('DROP')) return 'ALTER … DROP removes data.';
    return null;
  }

  // ---------- Filters ----------

  const OPERATORS = [
    ['=', '='], ['!=', '≠'], ['<', '<'], ['>', '>'], ['<=', '≤'], ['>=', '≥'],
    ['contains', 'contains'], ['not contains', 'doesn’t contain'], ['starts', 'starts with'], ['ends', 'ends with'],
    ['in', 'in list'], ['not in', 'not in list'], ['between', 'between'], ['null', 'is NULL'], ['not null', 'is not NULL'],
    ['empty', 'is empty'], ['not empty', 'is not empty'], ['regexp', 'matches regexp']];

  const likeEscape = v => String(v).replace(/[\\%_]/g, '\\$&');

  /** {column, op, value} → {sql, params}. column '*' means any column; '' with op 'raw' is raw SQL. */
  function filterClause(filter, columns) {
    const { op } = filter;
    let value = filter.value ?? '';
    if (filter.column === '' || op === 'raw') return value.trim() ? { sql: '(' + value + ')', params: [] } : null;
    if (filter.column === '*') {
      if (['null', 'not null', 'empty', 'not empty'].includes(op) || !String(value).length) return null;
      const parts = columns.map(c => filterClause({ column: c, op, value }, columns)).filter(Boolean);
      return parts.length ? { sql: '(' + parts.map(p => p.sql).join(' OR ') + ')', params: parts.flatMap(p => p.params) } : null;
    }
    const col = ident(filter.column);
    const text = `CAST(${col} AS CHAR)`;
    switch (op) {
      case '=': case '!=': case '<': case '>': case '<=': case '>=':
        return { sql: `${col} ${op} ?`, params: [value] };
      case 'contains': return { sql: `${text} LIKE ?`, params: ['%' + likeEscape(value) + '%'] };
      case 'not contains': return { sql: `${text} NOT LIKE ?`, params: ['%' + likeEscape(value) + '%'] };
      case 'starts': return { sql: `${text} LIKE ?`, params: [likeEscape(value) + '%'] };
      case 'ends': return { sql: `${text} LIKE ?`, params: ['%' + likeEscape(value)] };
      case 'regexp': return { sql: `${text} REGEXP ?`, params: [value] };
      case 'in': case 'not in': {
        const items = String(value).split(',').map(v => v.trim()).filter(v => v.length);
        if (!items.length) return null;
        return { sql: `${col} ${op === 'in' ? 'IN' : 'NOT IN'} (${items.map(() => '?').join(', ')})`, params: items };
      }
      case 'between': {
        const [a, b] = String(value).split(/\s*(?:,|\band\b)\s*/i);
        return b === undefined ? null : { sql: `${col} BETWEEN ? AND ?`, params: [a, b] };
      }
      case 'null': return { sql: `${col} IS NULL`, params: [] };
      case 'not null': return { sql: `${col} IS NOT NULL`, params: [] };
      case 'empty': return { sql: `(${col} IS NULL OR ${col} = '')`, params: [] };
      case 'not empty': return { sql: `(${col} IS NOT NULL AND ${col} <> '')`, params: [] };
      default: return null;
    }
  }

  function whereClause(filters, columns) {
    const parts = filters.filter(f => f.enabled !== false).map(f => filterClause(f, columns)).filter(Boolean);
    return parts.length ? { sql: ' WHERE ' + parts.map(p => p.sql).join(' AND '), params: parts.flatMap(p => p.params) } : { sql: '', params: [] };
  }

  // ---------- Saving grid edits ----------

  /**
   * changes: [{kind:'update', key:{col:val}, values:{col:val}},
   *           {kind:'insert', values:{col:val}}, {kind:'delete', key:{col:val}}]
   * key holds the primary key (or every original column when there's none,
   * with LIMIT 1). Values may be {$expr:'DEFAULT'} etc.
   */
  function changeStatements(db, table, changes, { limitOne = false } = {}) {
    const target = qualified(db, table);
    const where = key => {
      const cols = Object.keys(key);
      const params = [];
      const sql = cols.map(c => {
        if (key[c] === null) return ident(c) + ' IS NULL';
        params.push(key[c]);
        return ident(c) + ' = ?';
      }).join(' AND ');
      return { sql, params };
    };
    const value = (v, params) => {
      if (v && typeof v === 'object' && v.$expr) return v.$expr;
      params.push(v);
      return '?';
    };
    const out = [];
    for (const change of changes.filter(c => c.kind === 'delete')) {
      const w = where(change.key);
      out.push({ sql: `DELETE FROM ${target} WHERE ${w.sql}${limitOne ? ' LIMIT 1' : ''}`, params: w.params });
    }
    for (const change of changes.filter(c => c.kind === 'update')) {
      const cols = Object.keys(change.values);
      if (!cols.length) continue;
      const params = [];
      const set = cols.map(c => ident(c) + ' = ' + value(change.values[c], params)).join(', ');
      const w = where(change.key);
      out.push({ sql: `UPDATE ${target} SET ${set} WHERE ${w.sql}${limitOne ? ' LIMIT 1' : ''}`, params: [...params, ...w.params] });
    }
    for (const change of changes.filter(c => c.kind === 'insert')) {
      const cols = Object.keys(change.values);
      if (!cols.length) { out.push({ sql: `INSERT INTO ${target} () VALUES ()`, params: [] }); continue; }
      const params = [];
      const vals = cols.map(c => value(change.values[c], params));
      out.push({ sql: `INSERT INTO ${target} (${cols.map(ident).join(', ')}) VALUES (${vals.join(', ')})`, params });
    }
    return out;
  }

  // ---------- Export ----------

  const plain = v => v === null || v === undefined ? null : typeof v === 'object' ? (v.$t ?? (v.$b !== undefined ? '0x' + base64Hex(v.$b) : '')) : String(v);

  function base64Hex(b64) {
    const bytes = typeof atob === 'function' ? atob(b64) : Buffer.from(b64, 'base64').toString('binary');
    return Array.from(bytes, ch => ch.charCodeAt(0).toString(16).padStart(2, '0')).join('').toUpperCase();
  }

  function csv(columns, rows, sep = ',') {
    const cell = v => {
      const s = plain(v);
      if (s === null) return sep === '\t' ? 'NULL' : '';
      return sep === '\t' ? s.replace(/[\t\n\r]/g, ' ') : /["\n\r]|^\s|\s$/.test(s) || s.includes(sep) ? '"' + s.replaceAll('"', '""') + '"' : s;
    };
    return [columns.map(c => cell(c)).join(sep), ...rows.map(r => r.map(cell).join(sep))].join('\n');
  }

  const tsvRows = rows => rows.map(r => r.map(v => { const s = plain(v); return s === null ? 'NULL' : s.replace(/[\t\n\r]/g, ' '); }).join('\t')).join('\n');

  function json(columns, rows) {
    return JSON.stringify(rows.map(r => Object.fromEntries(columns.map((c, i) => [c, plain(r[i])]))), null, 2);
  }

  function inserts(db, table, columns, rows) {
    if (!rows.length) return '';
    const head = `INSERT INTO ${qualified(db, table)} (${columns.map(ident).join(', ')}) VALUES\n`;
    const binary = v => v && typeof v === 'object' && v.$b !== undefined;
    return head + rows.map(r => '  (' + r.map(v => binary(v) ? 'X' + literal(base64Hex(v.$b)) : literal(plain(v))).join(', ') + ')').join(',\n') + ';';
  }

  /** A light formatter: one clause per line, keywords upper-cased. */
  function format(sql) {
    const breakBefore = new Set(['SELECT', 'FROM', 'WHERE', 'GROUP', 'ORDER', 'HAVING', 'LIMIT', 'UNION', 'VALUES', 'SET',
      'LEFT', 'RIGHT', 'INNER', 'JOIN', 'CROSS', 'ON', 'AND', 'OR']);
    const indent = new Set(['AND', 'OR', 'ON']);
    let out = '';
    let depth = 0;
    let previous = '';
    for (const t of scan(sql)) {
      if (t.type === 'space') { if (!out.endsWith('\n') && !out.endsWith(' ') && out) out += ' '; continue; }
      let text = t.type === 'keyword' || t.type === 'function' ? t.text.toUpperCase() : t.text;
      const word = text.toUpperCase();
      const joined = (word === 'JOIN' && ['LEFT', 'RIGHT', 'INNER', 'CROSS', 'OUTER'].includes(previous)) || (word === 'BY' ) || (word === 'OUTER');
      if (t.type === 'keyword' && breakBefore.has(word) && !joined && depth === 0 && out.trim()) {
        out = out.trimEnd() + '\n' + (indent.has(word) ? '  ' : '');
      }
      if (t.text === '(') depth++;
      if (t.text === ')') depth = Math.max(0, depth - 1);
      if (t.type === 'semi') { out = out.trimEnd() + ';\n\n'; previous = ''; continue; }
      out += text;
      if (t.type === 'keyword') previous = word;
    }
    return out.replace(/ +\n/g, '\n').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').replace(/\s+,/g, ',').trim() + '\n';
  }

  const api = { KEYWORDS, FUNCTIONS, OPERATORS, ident, qualified, literal, inline, scan, split, statementAt, firstWord, isWrite, risk,
    filterClause, whereClause, changeStatements, plain, csv, tsvRows, json, inserts, format, base64Hex };
  if (typeof module !== 'undefined') module.exports = api;
  else root.SQL = api;
})(typeof window !== 'undefined' ? window : globalThis);
