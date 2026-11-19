#!/bin/sh
set -eu
umask 077
pg_dump -U listmonk -d listmonk -Fc -f /dump/listmonk.dump.tmp
mv /dump/listmonk.dump.tmp /dump/listmonk.dump
