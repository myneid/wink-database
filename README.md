# Wink Database Workbench

A TablePlus-style MySQL and MariaDB client that runs as a Wink app. Connect
directly or through any of your Wink and Blink SSH hosts, browse and edit
tables, change structure, and run SQL.

## Install

In Wink choose **Apps → Install Database Workbench…**, or paste this
repository's URL into **Apps → Install from GitHub…**. In Blink (Apps, ⌘⇧A),
choose **Install from GitHub…** and paste the same URL. It runs on Wink 0.9.4
or newer and on Blink builds with the Apps `database` capability; nothing else
needs installing (the hosts speak MySQL natively). Older Wink builds get a
single read-only connection.

## Opening it

In Wink, choose it from the **Apps** menu. In Blink, tap it in Settings ›
Apps or type `dbw` at the prompt: it opens full screen in a new tab (close the
tab to quit). `dbw <connection name>` connects straight away, as does
`apps open dbw <connection name>`.

## Connections

- **New Connection** opens Wink's native form: name, environment
  (local/development/testing/staging/production), host, port, user, password,
  database, *Over SSH*, read-only and SSL. Paste a URL into its URL field to
  fill everything in.
- **Import from URL…** takes `mysql://user:password@host:3306/db`,
  `mariadb://…`, `jdbc:mysql://…`, a `DATABASE_URL=…` line, or a TablePlus
  `mysql+ssh://sshuser@sshhost/user:password@127.0.0.1:3306/db` URL. Options:
  `?ssh=alias`, `ssl=true` / `sslmode=REQUIRED`, `readonly=1`, `env=production`,
  `name=…`, `statusColor=…`. If your clipboard holds a URL, it's prefilled.
- **Over SSH** lists your hosts. Wink tunnels with its own ssh config (Blink's
  hosts and keys, `~/.ssh/config`, jump hosts); Blink uses its own SSH client
  with your Blink keys (jump hosts aren't supported there yet).
  With SSH, *Host* is the database host as seen from that server (usually
  `127.0.0.1`).
- Passwords are kept in the Keychain and never reach this app's web page. **Copy URL…** in a connection's ⋯ menu exports it, with or without the
  password.

## Using it

| | |
| --- | --- |
| Tables, views, routines | Sidebar with filter (⌘K); right-click for structure, export, rename, truncate, drop |
| Open anything | ⌘P: tables, views, routines, saved queries, other databases |
| Data | Paging, sort by header, filters (⌘F) including *any column* and raw `WHERE` |
| Editing | Double-click or type to edit, Tab/Return to move, ⌘Z undo, ⌘⌫ delete rows, ＋ Row, paste from spreadsheets; **Preview SQL** and **Commit** (⌘S) in one transaction |
| Values | Long text and BLOBs open in a viewer (JSON formatting, hex); right-click → Edit Row… |
| Structure | Columns, indexes, foreign keys and DDL; add/edit/drop columns, indexes and foreign keys |
| SQL | Highlighting, autocomplete (tables, columns, aliases), ⌘↩ runs the statement at the cursor or the selection, ⇧⌘↩ runs all, `DELIMITER` support, Explain, Format, ⌘/ comments |
| Results | Several result tabs plus Messages; results from one table with its primary key are editable |
| History | Query history and saved queries (☆ Save) |
| Export | Copy rows, pages or whole tables as CSV, JSON or SQL `INSERT` |
| Safety | Production connections confirm writes and commits; `UPDATE`/`DELETE` without `WHERE`, `DROP` and `TRUNCATE` always ask; read-only connections block writes |
| Other | ⌥⌘N new query, ⌥⌘W close tab, ⇧⌘[ ⇧⌘] switch tabs, ⌘R refresh, ⌘. stop query |

## Development

The app is plain HTML, CSS and JavaScript (no build step): `sql.js` (SQL
helpers), `grid.js` (result grid), `editor.js` (SQL editor) and `app.js`.

```bash
node tests/sql.test.cjs
```

To work on it in a browser against a real server, run the development host. It
stands in for the host bridge and builds a small helper from Wink's shared
Swift MySQL client (expects a Wink checkout at `../wink`, or set
`WINK_SOURCES`):

```bash
node dev/mock-host.mjs
```

Then open http://127.0.0.1:8790. The development host keeps connections,
passwords included, in `dev/.connections.json` (git-ignored) and has no SSH
tunnels. Sample: `[{"id":"local","host":"127.0.0.1","port":3306,"user":"root","password":"","database":""}]`. The bridge API is documented in Wink's `docs/plugins.md`.
