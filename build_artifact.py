# Artifact variant: same page without its own document skeleton (the host wraps it).
import re, sys
src = open('water_balloon.html', encoding='utf-8').read()
out = src
out = out.replace('<!doctype html>\n', '', 1)
out = out.replace('<html lang="en">\n', '', 1)
out = out.replace('<head>\n', '', 1)
out = out.replace('<meta charset="utf-8">\n', '', 1)
out = out.replace('<meta name="viewport" content="width=device-width, initial-scale=1">\n', '', 1)
out = out.replace('</head>\n', '', 1)
out = out.replace('<body>\n', '', 1)
out = re.sub(r'</body>\s*</html>\s*$', '', out)
assert '<title>' in out[:8192]
assert '<html' not in out and '<body' not in out and '<head' not in out and '<!doctype' not in out.lower()
open(sys.argv[1], 'w', encoding='utf-8').write(out)
print('artifact', len(out))
