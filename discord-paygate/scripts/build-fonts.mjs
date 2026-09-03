#!/usr/bin/env node
// Rebuild assets/fonts/*.ttf from the site's variable web fonts.
//
//   pip install fonttools brotli && node scripts/build-fonts.mjs
//
// Why this exists: sharp/librsvg render SVG text through fontconfig, which
// wants real installed font files. The site ships woff2 variable fonts, which
// fontconfig handles poorly, so we cut fixed-weight TTF instances. Families
// are renamed ("Dues Grotesk"/"Dues Sans") because the OFL forbids shipping a
// modified font under its original name.
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const CUTS = [
  ['public/spacegrotesk-latin.woff2', 'assets/fonts/SpaceGrotesk-Bold.ttf', 700, 'Dues Grotesk', 'Bold'],
  ['public/dmsans-latin.woff2', 'assets/fonts/DMSans-Regular.ttf', 400, 'Dues Sans', 'Regular'],
  ['public/dmsans-latin.woff2', 'assets/fonts/DMSans-Bold.ttf', 700, 'Dues Sans', 'Bold'],
];

mkdirSync('assets/fonts', { recursive: true });
const py = `
import sys
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer
src, dst, wght, family, sub = sys.argv[1], sys.argv[2], float(sys.argv[3]), sys.argv[4], sys.argv[5]
f = TTFont(src); f.flavor = None
axes = {a.axisTag: (a.minValue, a.maxValue) for a in f['fvar'].axes}
w = max(axes['wght'][0], min(wght, axes['wght'][1]))
inst = instancer.instantiateVariableFont(f, {'wght': w}, inplace=False, updateFontNames=False)
n = inst['name']
for nid, val in ((1, family), (2, sub), (4, family + ' ' + sub), (6, (family + '-' + sub).replace(' ', ''))):
    n.setName(val, nid, 3, 1, 0x409); n.setName(val, nid, 1, 0, 0)
inst.save(dst)
print(dst, family, sub, int(w))
`;
for (const [src, dst, wght, family, sub] of CUTS) {
  const out = execFileSync('python3', ['-c', py, src, dst, String(wght), family, sub], { encoding: 'utf8' });
  console.log('[fonts]', out.trim());
}
console.log('[fonts] install with: sudo cp assets/fonts/*.ttf /usr/share/fonts/dues/ && sudo fc-cache -f');
