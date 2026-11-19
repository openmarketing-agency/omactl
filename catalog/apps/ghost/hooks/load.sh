#!/bin/sh
set -eu
test -s /dump/ghost.sql
mysql --user=ghost ghost < /dump/ghost.sql
