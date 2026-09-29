#!/bin/sh
# Assemble the single-file app: water_balloon.html
cd "$(dirname "$0")"
OUT="${1:-water_balloon.html}"   # optional output path (default: next to this script)
{
  cat src/head.html
  printf '<script id="shared-src">\n'; cat src/shared.js; printf '</script>\n'
  printf '<script type="text/plain" id="sim-src">\n'; cat src/membrane.js; printf '\n'; cat src/sim.js; printf '</script>\n'
  printf '<script>\n'
  for f in glsl_common glsl_scene glsl_trace glsl_fx glsl_caustic glsl_rubber spray render app_core app_ui; do cat "src/$f.js"; printf '\n'; done
  printf '</script>\n</body>\n</html>\n'
} > "$OUT"
if grep -n '</script' src/*.js >/dev/null 2>&1; then echo "WARNING: </script inside sources"; fi
wc -c "$OUT"
