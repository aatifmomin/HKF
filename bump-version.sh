#!/bin/sh
# Stamp a new build id across version.js and every local import.
#
#   ./bump-version.sh              -> uses today's date, e.g. 2026-08-19a
#   ./bump-version.sh 2026-08-20b  -> uses the id you give
#
# Run this after ANY edit to a .js file, then redeploy. Without it, browsers
# that already have the old files will keep using them.

set -e
NEW="${1:-$(date +%Y-%m-%d)a}"

# The version stamp itself
sed -i.bak -E "s/export const BUILD_ID = \".*\";/export const BUILD_ID = \"$NEW\";/" version.js

# Every local import: ./thing.js  ->  ./thing.js?v=NEW   (leaves CDN URLs alone)
for f in *.js index.html; do
  sed -i.bak -E "s|(\"\./[A-Za-z0-9_-]+\.js)(\?v=[^\"]*)?\"|\1?v=$NEW\"|g" "$f"
  sed -i.bak -E "s|(src=\"[A-Za-z0-9_-]+\.js)(\?v=[^\"]*)?\"|\1?v=$NEW\"|g" "$f"
done
rm -f ./*.bak

echo "Stamped build $NEW"
grep -c "?v=$NEW" ./*.js index.html | sed 's/^/  /'
