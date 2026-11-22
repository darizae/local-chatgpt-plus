#!/bin/sh
# Start the Mac build using the existing package lifecycle and tunnel supervisor.
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
exec npm start