#!/usr/bin/env node
/**
 * Inject structured data into index.html from the same sources the app renders.
 *
 * The FAQ lives in src/faq.ts, inside a modal, inside a JS bundle: invisible to
 * anything that does not run the app. FAQPage JSON-LD in the static HTML is how
 * search and answer engines get the same words readers do, and generating it
 * from faq.ts at build time means the two cannot drift, which is how the FAQ
 * previously ended up promising an opt-out the site no longer offered.
 *
 * Runs as prebuild. Rewrites the block between the seo:jsonld markers in place.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const HTML = join(HERE, '..', 'index.html');
const ORIGIN = 'https://sf-property-tax.netlify.app';

// faq.ts is TypeScript, and type-stripping imports need Node 22.6+ while
// Netlify's CLI builds ran this under 20 and failed. The data is a plain
// literal, so extract it from the source text instead: everything from the
// first '[' after the FAQ declaration to the matching close.
const faqSrc = readFileSync(join(HERE, '..', 'src', 'faq.ts'), 'utf8');
const declAt = faqSrc.indexOf('export const FAQ');
const start = faqSrc.indexOf('[', declAt);
const end = faqSrc.lastIndexOf('];');
if (declAt < 0 || start < 0 || end < 0) {
  console.error('gen-seo: could not locate the FAQ literal in faq.ts');
  process.exit(1);
}
const FAQ = new Function('return ' + faqSrc.slice(start, end + 1))();

const faqPage = {
  '@context': 'https://schema.org',
  '@type': 'FAQPage',
  mainEntity: FAQ.map((item) => ({
    '@type': 'Question',
    name: item.q,
    acceptedAnswer: { '@type': 'Answer', text: item.a },
  })),
};

const dataset = {
  '@context': 'https://schema.org',
  '@type': 'Dataset',
  name: 'San Francisco Prop 13 property tax gap, by parcel',
  description:
    'Estimated gap between assessed (taxed) value and market value for about 207,000 San Francisco parcels, derived from DataSF assessor secured tax rolls (2007 to present), the city parcel map, and the SF Assessor-Recorder public index of recorded documents.',
  url: ORIGIN + '/',
  license: 'https://opendatacommons.org/licenses/pddl/1-0/',
  creator: { '@type': 'Person', name: 'Jeff Lin' },
  spatialCoverage: 'San Francisco, California',
  isBasedOn: [
    'https://data.sfgov.org/Housing-and-Buildings/Assessor-Historical-Secured-Property-Tax-Rolls/wv5m-vpq2',
    'https://data.sfgov.org/Geographic-Locations-and-Boundaries/Parcels-Active-and-Retired/acdm-wktn',
  ],
};

const app = {
  '@context': 'https://schema.org',
  '@type': 'WebApplication',
  name: 'SF Property Tax Gap',
  url: ORIGIN + '/',
  applicationCategory: 'Reference',
  operatingSystem: 'Any',
  offers: { '@type': 'Offer', price: '0' },
  description:
    'Interactive map of the Prop 13 gap between taxed and market value across every San Francisco parcel, with per-parcel tax history and recorded deeds.',
};

const script = (o) => `    <script type="application/ld+json">${JSON.stringify(o)}</script>`;
const block = [script(faqPage), script(dataset), script(app)].join('\n');

const html = readFileSync(HTML, 'utf8');
const START = '<!-- seo:jsonld: generated from src/faq.ts by scripts/gen-seo.mjs; do not edit by hand -->';
const END = '<!-- /seo:jsonld -->';
const i = html.indexOf(START);
const j = html.indexOf(END);
if (i < 0 || j < 0) {
  console.error('gen-seo: markers not found in index.html');
  process.exit(1);
}
const next = html.slice(0, i + START.length) + '\n' + block + '\n    ' + html.slice(j);
writeFileSync(HTML, next);
console.log(`gen-seo: ${FAQ.length} FAQ entries -> FAQPage + Dataset + WebApplication JSON-LD`);
