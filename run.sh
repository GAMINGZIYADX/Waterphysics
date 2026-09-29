#!/bin/sh
# Run the bullet vs. water balloon simulation on Linux (or macOS):  ./run.sh   or   sh run.sh
# Starts a local server with Python 3 and opens the page in your browser. Press Ctrl+C to stop.
cd "$(dirname "$0")" || exit 1
for py in python3 python; do
  if command -v "$py" >/dev/null 2>&1 && "$py" -c 'import sys; sys.exit(sys.version_info < (3, 7))' 2>/dev/null; then
    exec "$py" run.py "$@"
  fi
done
echo "Python 3.7 or newer was not found, so the page will open straight from disk instead."
if command -v xdg-open >/dev/null 2>&1; then
  xdg-open water_balloon.html
elif command -v open >/dev/null 2>&1; then
  open water_balloon.html
else
  echo "Open water_balloon.html in Chrome, Edge or Firefox."
fi
