// Entry point for the markdown-render-speed-02 competition.
//
// Reads every case from cases.json in the input directory (MAKEFUN_INPUT_DIR,
// or /input inside the grading container), renders each case's Markdown to
// HTML with the fast renderer in ./parse.js, and writes the resulting HTML
// strings, in the same order, as a JSON array to html.json in the output
// directory (MAKEFUN_OUTPUT_DIR, or /output).

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const raw = readFileSync(join(inputDir, 'cases.json'), 'utf8');
const cases = JSON.parse(raw) as { id: string; markdown: string }[];

const html = new Array<string>(cases.length);
for (let i = 0; i < cases.length; i++) {
  html[i] = parse(cases[i].markdown);
}

writeFileSync(join(outputDir, 'html.json'), JSON.stringify(html));
