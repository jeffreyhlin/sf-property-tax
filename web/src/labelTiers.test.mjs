import { WebMercatorViewport } from '@deck.gl/core';
import { cullToScreen, fmtUsd, blockOf } from './labelTiers.ts';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  ' + extra : '')); }
};

const SIZE = [1280, 720];
const vp = new WebMercatorViewport({
  width: SIZE[0], height: SIZE[1],
  longitude: -122.4425, latitude: 37.758, zoom: 12, pitch: 0, bearing: 0,
});
const project = (pos) => vp.project(pos);
const at = (x, y) => ({ position: vp.unproject([x, y]).slice(0, 2) });

// chrome resembling the real app: topbar across the top, legend bottom-left,
// dock bottom-centre, parcel panel down the right
const RECTS = [
  [0, 0, 1280, 60],
  [104, 700, 334, 825],
  [560, 820, 950, 872],
  [960, 70, 1266, 700],
];

console.log('cullToScreen');
ok('keeps a label in open space', cullToScreen([at(500, 400)], project, { size: SIZE, rects: RECTS }).length === 1);
ok('drops a label under the topbar', cullToScreen([at(500, 30)], project, { size: SIZE, rects: RECTS }).length === 0);
ok('drops a label under the right-hand panel', cullToScreen([at(1100, 300)], project, { size: SIZE, rects: RECTS }).length === 0);
ok('drops a label just inside the pad of a rect', cullToScreen([at(940, 300)], project, { size: SIZE, rects: RECTS }).length === 0);
ok('keeps a label clear of the pad', cullToScreen([at(900, 300)], project, { size: SIZE, rects: RECTS }).length === 1);
ok('drops a label clipped by the left edge', cullToScreen([at(10, 400)], project, { size: SIZE, rects: RECTS }).length === 0);
ok('drops a label clipped by the bottom edge', cullToScreen([at(500, 715)], project, { size: SIZE, rects: RECTS }).length === 0);

// the bug this whole detour was about
const many = [at(500, 400), at(500, 30), at(1100, 300), at(10, 400)];
ok('a zero-size surface culls nothing rather than everything',
   cullToScreen(many, project, { size: [0, 0], rects: RECTS }).length === 4);
ok('a tiny surface culls nothing rather than everything',
   cullToScreen(many, project, { size: [120, 90], rects: RECTS }).length === 4);
ok('no rects means only edge clipping applies',
   cullToScreen(many, project, { size: SIZE, rects: [] }).length === 3);
ok('mixed set keeps only the open-space label',
   cullToScreen(many, project, { size: SIZE, rects: RECTS }).length === 1);

console.log('\nfmtUsd');
ok('$0 renders as nothing', fmtUsd(0) === '');
ok('sub-thousand collapses', fmtUsd(131) === '<$1k', `got ${fmtUsd(131)}`);
ok('thousands', fmtUsd(65032) === '$65k', `got ${fmtUsd(65032)}`);
ok('millions keep a decimal', fmtUsd(4_100_000) === '$4.1M', `got ${fmtUsd(4_100_000)}`);
ok('tens of millions drop it', fmtUsd(241_300_000) === '$241M', `got ${fmtUsd(241_300_000)}`);
ok('billions', fmtUsd(2_000_000_000) === '$2.0B', `got ${fmtUsd(2_000_000_000)}`);

console.log('\nblockOf');
ok('APN to block', blockOf('2765001') === '2765');
ok('lettered lot', blockOf('2765001B') === '2765');
ok('punctuation stripped', blockOf('2765-001') === '2765');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
