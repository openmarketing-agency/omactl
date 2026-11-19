#!/bin/sh
set -eu
cd /var/www/html
wp option update home "$PUBLIC_URL"
wp option update siteurl "$PUBLIC_URL"
