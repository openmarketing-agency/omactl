#!/bin/sh
set -eu
umask 077
mysqldump --user=ghost --single-transaction --quick --skip-lock-tables \
  --no-tablespaces --set-gtid-purged=OFF ghost > /dump/ghost.sql.tmp
mv /dump/ghost.sql.tmp /dump/ghost.sql
