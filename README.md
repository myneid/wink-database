# Wink Database Workbench

A macOS prototype for browsing MySQL tables, previewing rows, and running SQL
from Wink. Connect to a local MySQL instance or an existing SSH forward on
127.0.0.1. Use an account granted SELECT only.

## Build with Wink

This is source for a bundled app, not a package that works via Wink’s
GitHub-link installer. Stock Wink lacks the database bridge. Use a clean
[Wink 0.9.2 checkout](https://github.com/myneid/wink/tree/v0.9.2). From this
repository, with `WINK_CHECKOUT` pointing at that checkout, run:

```sh
git -C "$WINK_CHECKOUT" apply --check "$PWD/wink-host.patch"
git -C "$WINK_CHECKOUT" apply "$PWD/wink-host.patch"
cp Sources/DatabaseWorkbench.swift "$WINK_CHECKOUT/Sources/"
cp Resources/database-query.php "$WINK_CHECKOUT/Resources/"
cp -R Resources/Plugins/org.blink.database "$WINK_CHECKOUT/Resources/Plugins/"
(cd "$WINK_CHECKOUT" && bash build.sh)
```

Open the resulting `build/Wink.app` and choose **Apps → Database Workbench**.
The helper needs PHP CLI with `pdo_mysql` (Homebrew or Herd). Credentials are
entered in a native dialog and kept in memory for the tab’s lifetime. Results
are capped at 200 rows. The prototype does not save passwords, create SSH
tunnels, or run in Blink on iOS.
