#!/bin/sh
set -eu
traefik healthcheck --ping
