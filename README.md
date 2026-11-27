# Wink Database Workbench

An opt-in Apps package for browsing MySQL tables, previewing rows, and running read-only SQL.

## Install

Paste this repository's root URL into **Apps → Install from GitHub…**. The
root contains the v1 manifest and web assets; no bundling or native helper
installation is part of this package. In Wink you can also use
**Apps → Install Database Workbench…** as a shortcut to the same review.

Wink 0.9.3 provides the database bridge. The Blink Apps draft can accept the
same package, but does not provide a database bridge yet: the app opens and
explains that MySQL connections are unavailable.

Open **Apps → Database Workbench → Choose connection…** and select a local
MySQL server or an existing SSH forward on 127.0.0.1. Use a MySQL account
granted SELECT only. Wink needs PHP CLI with pdo_mysql (Homebrew or Herd).
Credentials stay in Wink; the app receives query results, capped at 200 rows.

The files under Sources and Resources, and wink-host.patch, document the
original bundled 0.1.0 prototype. They are not run by the plugin installer.
