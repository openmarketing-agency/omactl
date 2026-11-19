#!/bin/sh
set -eu
test -s /dump/umami.dump
pg_restore -U umami -d umami --clean --if-exists --no-owner --exit-on-error /dump/umami.dump
