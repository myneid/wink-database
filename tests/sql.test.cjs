'use strict';
// node tests/sql.test.cjs
const assert = require('assert');
const SQL = require('../sql.js');
let count = 0;
const eq = (a, b, note) => { assert.deepStrictEqual(a, b, note); count++; };

// Splitting.
eq(SQL.split("SELECT 1; SELECT 'a;b'; -- c;\nSELECT `x;y`").map(s => s.sql), ["SELECT 1", "SELECT 'a;b'", "-- c;\nSELECT `x;y`"]);
eq(SQL.split("SELECT 'it\\'s; fine'; /* ; */ SELECT 2;").map(s => s.sql), ["SELECT 'it\\'s; fine'", "/* ; */ SELECT 2"]);
eq(SQL.split("  \n-- only a comment\n").length, 0);
const proc = "DELIMITER //\nCREATE PROCEDURE p() BEGIN SELECT 1; SELECT 2; END//\nDELIMITER ;\nCALL p();";
eq(SQL.split(proc).map(s => s.sql), ["CREATE PROCEDURE p() BEGIN SELECT 1; SELECT 2; END", "CALL p()"]);
const text = "SELECT 1;\n\nSELECT 2;\nSELECT 3";
eq(SQL.statementAt(text, 0).sql, 'SELECT 1');
eq(SQL.statementAt(text, 12).sql, 'SELECT 2');
eq(SQL.statementAt(text, text.length).sql, 'SELECT 3');
eq(SQL.statementAt(text, 9).sql, 'SELECT 1');

// Scan round-trips.
for (const s of [text, proc, "SELECT \"a\"\"b\", x--y FROM t # c\n WHERE ?", "select 0x1F, 1.5e3, @v"]) {
  eq(SQL.scan(s).map(t => t.text).join(''), s);
}
eq(SQL.scan("select count(*) from t").filter(t => t.type === 'function').map(t => t.text), ['count']);

// Writes and risks.
eq(SQL.isWrite("  /* hi */ select 1"), false);
eq(SQL.isWrite("WITH x AS (SELECT 1) SELECT * FROM x"), false);
eq(SQL.isWrite("update t set a=1"), true);
assert(SQL.risk("DELETE FROM t")); assert(!SQL.risk("DELETE FROM t WHERE id=1")); assert(SQL.risk("drop table t")); count += 3;
assert(!SQL.risk("UPDATE t SET note='where' WHERE id = 2")); count++;
assert(SQL.risk("UPDATE t SET note='where'")); count++;

// Quoting.
eq(SQL.ident('we`ird'), '`we``ird`');
eq(SQL.literal("it's\n"), "'it\\'s\\n'");
eq(SQL.inline("SELECT ? , '?' , ?", [1, null]), "SELECT 1 , '?' , NULL");

// Filters.
eq(SQL.filterClause({ column: 'name', op: 'contains', value: '50%_off' }, []), { sql: 'CAST(`name` AS CHAR) LIKE ?', params: ['%50\\%\\_off%'] });
eq(SQL.filterClause({ column: 'id', op: 'in', value: '1, 2,3' }, []), { sql: '`id` IN (?, ?, ?)', params: ['1', '2', '3'] });
eq(SQL.filterClause({ column: 'id', op: 'between', value: '1 and 5' }, []), { sql: '`id` BETWEEN ? AND ?', params: ['1', '5'] });
eq(SQL.whereClause([{ column: '*', op: '=', value: 'x' }, { column: 'a', op: 'null' }, { column: 'b', op: '=', value: 1, enabled: false }], ['a', 'b']),
  { sql: ' WHERE (`a` = ? OR `b` = ?) AND `a` IS NULL', params: ['x', 'x'] });
eq(SQL.whereClause([], ['a']), { sql: '', params: [] });

// Grid edits.
eq(SQL.changeStatements('shop', 'tags', [
  { kind: 'insert', values: { name: 'n', color: { $expr: 'DEFAULT' } } },
  { kind: 'update', key: { id: '4', other: null }, values: { name: 'Ada L', note: null } },
  { kind: 'delete', key: { id: '9' } }]), [
  { sql: 'DELETE FROM `shop`.`tags` WHERE `id` = ?', params: ['9'] },
  { sql: 'UPDATE `shop`.`tags` SET `name` = ?, `note` = ? WHERE `id` = ? AND `other` IS NULL', params: ['Ada L', null, '4'] },
  { sql: 'INSERT INTO `shop`.`tags` (`name`, `color`) VALUES (?, DEFAULT)', params: ['n'] }]);
eq(SQL.changeStatements('', 't', [{ kind: 'delete', key: { a: '1' } }], { limitOne: true })[0].sql, 'DELETE FROM `t` WHERE `a` = ? LIMIT 1');

// Export.
eq(SQL.csv(['a', 'b'], [['x,y', null], ['say "hi"', { $t: 'long', n: 9 }]]), 'a,b\n"x,y",\n"say ""hi""",long');
eq(SQL.json(['a'], [[null], ['1']]), '[\n  {\n    "a": null\n  },\n  {\n    "a": "1"\n  }\n]');
eq(SQL.inserts('', 't', ['a', 'b'], [['1', { $b: 'iVA=', n: 2 }]]), "INSERT INTO `t` (`a`, `b`) VALUES\n  ('1', X'8950');");
eq(SQL.format("select a, b from t left join u on t.id=u.id where a=1 and b=2 order by a"),
  "SELECT a, b\nFROM t\nLEFT JOIN u\n  ON t.id=u.id\nWHERE a=1\n  AND b=2\nORDER BY a\n");
console.log(`PASS: ${count} SQL helper checks.`);
