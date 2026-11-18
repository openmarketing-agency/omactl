#!/bin/sh
set -eu
test -s /dump/wordpress.sql
export MYSQL_PWD="$MARIADB_PASSWORD"
mariadb --user=wordpress wordpress < /dump/wordpress.sql
