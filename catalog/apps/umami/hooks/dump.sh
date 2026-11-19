#!/bin/sh
set -eu
umask 077
pg_dump -U umami -d umami -Fc -f /dump/umami.dump.tmp
mv /dump/umami.dump.tmp /dump/umami.dump
