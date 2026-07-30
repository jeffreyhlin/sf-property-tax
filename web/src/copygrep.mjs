import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// resolve sources relative to this file, so the script works from any cwd
const HERE = dirname(fileURLToPath(import.meta.url));

// Patterns from the house style guide plus the no-ai-slop list. Each is a
// construction, not a word ban: the point is to look at every hit, not to
// auto-fix.
const RULES = [
  ['em-dash',              /—/,                                              'guide bans these outright'],
  ['announces-significance',/\b(worth (noting|naming|saying)|it('s| is) worth (noting|saying|remembering|pointing)|the (scale|point|thing) (here )?is|what('s| is) (striking|notable|remarkable))\b/i, 'state it, do not introduce it'],
  ['restates-the-obvious', /\b(which is why|which means that|and everything (below|above)|that is what .* means)\b/i, 'reader can already see it'],
  ['absolute-closer',      /\b(is|are|remains?) (critical|essential|vital|key|paramount)\b/i, 'say what it does instead'],
  ['faux-insight-setup',   /\b(the (real|deeper|underlying) (question|issue|problem|answer) is|here('s| is) the thing)\b/i, 'slop pattern'],
  ['importance-puffery',   /\b(crucial|pivotal|game-chang|revolutionary|unprecedented|profound)\w*\b/i, 'slop pattern'],
  ['weasel-attribution',   /\b(experts? (say|agree)|it is (widely )?(believed|thought|understood)|many (argue|believe)|studies show)\b/i, 'name who, or drop it'],
  ['fake-strong-verb',     /\b(delve|leverage|unlock|harness|empower|elevate|showcase|underscore|highlight the fact)\w*\b/i, 'slop pattern'],
  ['negative-listing',     /\bno \w+,? no \w+,? (and )?no \w+/i, 'listing absences for rhythm'],
  ['not-x-but-y',          /\bnot (just |merely |simply )?[a-z][\w'-]*,? but\b/i, 'max one per piece'],
  ['throat-clearing',      /^(In (today's|an era|a world)|As we|When it comes to|It goes without saying)/i, 'slop opener'],
  ['aphoristic-kicker',    /\b(that('s| is) the (point|whole point)|and that changes everything|therein lies)\b/i, 'no mic drops'],
];

// pull prose out of the sources: JSX text nodes and prose-looking literals
function harvest(file) {
  const src = fs.readFileSync(join(HERE, file), 'utf8');
  const out = [];
  const push = (line, text) => {
    const t = text.replace(/\s+/g, ' ').trim();
    // prose only: several words, a lowercase run, not an identifier or class list
    if (t.split(' ').length >= 5 && /[a-z]{3} [a-z]{3}/.test(t) && !/^[\w-]+( [\w-]+)*$/.test(t)) {
      out.push({ file, line, text: t });
    }
  };
  src.split('\n').forEach((l, i) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(l)) return;           // skip code comments
    // '—' alone is the null-value glyph in data cells, not prose
    l = l.replace(/["'`]—["'`]/g, "''");
    for (const m of l.matchAll(/>([^<>{}]{20,})</g)) push(i + 1, m[1]);
    for (const m of l.matchAll(/["'`]([^"'`\n]{25,})["'`]/g)) push(i + 1, m[1]);
  });
  return out;
}

const files = ['App.tsx', 'faq.ts', 'SankeyView.tsx'];
let copy = files.flatMap(harvest);
const nar = JSON.parse(fs.readFileSync(join(HERE, 'narration.json'), 'utf8'));
copy = copy.concat(nar.beats.map((b) => ({ file: 'narration.json', line: b.id, text: b.text })));

console.log(`scanned ${files.join(', ')}, narration.json`);
console.log(`${copy.length} prose strings\n`);

let hits = 0;
for (const [name, re, why] of RULES) {
  const found = copy.filter((c) => re.test(c.text));
  if (!found.length) continue;
  hits += found.length;
  console.log(`${name}  (${why})`);
  for (const f of found.slice(0, 6)) {
    console.log(`  ${f.file}:${f.line}`);
    console.log(`    ${f.text.slice(0, 150)}`);
  }
  console.log();
}
console.log(hits ? `${hits} to look at` : 'nothing flagged');
