#!/bin/sh
# Starts MCNetwork. Needs Node.js 22 or newer. The data (servers, settings) lives in the "data" folder next to this file.
cd "$(dirname "$0")" && exec node mcnetwork.js --data "$(pwd)/data" "$@"
