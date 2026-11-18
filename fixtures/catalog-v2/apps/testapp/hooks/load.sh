#!/bin/sh
set -eu
pg_restore -U oma -d oma --clean --if-exists --no-owner /dump/db.dump
