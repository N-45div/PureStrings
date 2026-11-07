#!/bin/sh
# Starts PureStrings as the node user. A host's disk can be mounted at /data owned by root (a new Render disk
# can be), so while still root, hand that folder to node first; then drop root for good.
set -e
DATA=$(dirname "${PURESTRINGS_DB:-/data/purestrings.db}")
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA"
  chown -R node:node "$DATA"
  exec setpriv --reuid=node --regid=node --init-groups "$@"
fi
exec "$@"
