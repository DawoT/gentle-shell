#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
const mode = readFileSync('mode', 'utf8');
process.on('SIGTERM', () => {
  writeFileSync('terminated', 'yes');
  if (mode === 'delayed') {
    setTimeout(() => { writeFileSync('done', 'yes'); process.exit(0); }, 100);
  }
});
writeFileSync('ready', String(process.pid));
if (mode === 'overflow') process.stdout.write('x'.repeat(1024 * 1024 + 1));
setInterval(() => {}, 1000);
