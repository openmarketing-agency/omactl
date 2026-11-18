#!/bin/sh
set -eu
cd /var/www/html
if ! wp core is-installed; then
  printf '%s\n' "$WORDPRESS_ADMIN_PASSWORD" | wp core install \
    --url="$PUBLIC_URL" --title="$WORDPRESS_SITE_TITLE" \
    --admin_user="$WORDPRESS_ADMIN_USER" --admin_email="$WORDPRESS_ADMIN_EMAIL" \
    --skip-email --prompt=admin_password
fi
wp core update-db
# Do not reset users, passwords, content, or site URLs on subsequent setup runs.
