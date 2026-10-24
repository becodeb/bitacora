#!/bin/sh
# Runs as root (the runtime image's default user), only to make sure
# DATA_DIR — the bind-mounted attachments directory — exists and is
# writable by the unprivileged `node` user, then drops to that user
# before actually running the server. See the Dockerfile's `su-exec`
# comment for why this keeps PID 1 as the node process itself.
set -eu

DATA_DIR="${DATA_DIR:-/data/attachments}"

mkdir -p "$DATA_DIR"
chown -R node:node "$DATA_DIR"

exec su-exec node "$@"
