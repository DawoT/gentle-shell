#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { atomicWriteMarker } from './atomic-marker.mjs';
const mode = readFileSync('mode', 'utf8');
process.on('SIGTERM', () => {
  atomicWriteMarker('.', 'terminated', 'yes');
  if (mode === 'delayed') {
    setTimeout(() => { atomicWriteMarker('.', 'done', 'yes'); process.exit(0); }, 100);
  }
});
let starttime = 'unknown';
try { starttime = readFileSync('/proc/self/stat', 'utf8').split(') ').pop().split(' ')[19]; } catch {}
// Readers watch for this file's creation; atomic rename so they never observe
// a created-but-still-empty marker. Content format ('pid starttime') is
// parsed by the parent test and must not change.
atomicWriteMarker('.', 'ready', `${process.pid} ${starttime}`);
if (mode === 'overflow') process.stdout.write('x'.repeat(1024 * 1024 + 1));
setInterval(() => {}, 1000);
