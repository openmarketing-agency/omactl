#!/bin/sh
set -eu
umask 077
export MYSQL_PWD="$MARIADB_PASSWORD"
mariadb-dump --user=wordpress --single-transaction --quick --skip-lock-tables \
  --routines --triggers wordpress > /dump/wordpress.sql.tmp
mv /dump/wordpress.sql.tmp /dump/wordpress.sql
