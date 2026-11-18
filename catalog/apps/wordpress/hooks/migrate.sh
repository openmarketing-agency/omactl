#!/bin/sh
set -eu
# Site content and wp-config.php belong to the persistent site volume.
cd /var/www/html
rm -rf wp-admin wp-includes
cp -a /usr/src/wordpress/wp-admin /usr/src/wordpress/wp-includes .
for file in /usr/src/wordpress/*; do
  test -f "$file" || continue
  case "${file##*/}" in wp-config.php|wp-config-sample.php) continue ;; esac
  cp -a "$file" .
done
chown -R www-data:www-data wp-admin wp-includes
