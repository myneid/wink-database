# Wink Database Workbench

Browse MySQL tables, preview rows, and run read-only SQL in Wink.

## Install

In a Wink build with the database bridge, choose **Apps → Install Database
Workbench…**, or paste this repository's root URL into **Install from GitHub…**.
Review the requested database permission and confirm the install. Stock
Wink 0.9.2 does not include the bridge.

Open **Apps → Database Workbench → Choose connection…** and select a local
MySQL server or an existing SSH forward on 127.0.0.1. Use a MySQL account
granted SELECT only. Wink needs PHP CLI with pdo_mysql (Homebrew or Herd).
Credentials stay in Wink; the app receives query results, capped at 200 rows.

The files under Sources and Resources, and wink-host.patch, document the
original bundled 0.1.0 prototype. They are not run by the plugin installer.
