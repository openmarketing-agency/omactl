#!/bin/sh
set -eu
export MYSQL_PWD="$MYSQL_PASSWORD"
test -s /dump/ghost.sql
mysql --user=ghost ghost < /dump/ghost.sql
