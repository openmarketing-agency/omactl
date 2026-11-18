#!/bin/sh
set -eu
pg_dump -U oma -d oma -Fc -f /dump/db.dump
