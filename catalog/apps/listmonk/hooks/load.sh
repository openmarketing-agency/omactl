#!/bin/sh
set -eu
test -s /dump/listmonk.dump
pg_restore -U listmonk -d listmonk --clean --if-exists --no-owner --exit-on-error /dump/listmonk.dump
