#!/usr/bin/env node
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
const mode = readFileSync('mode', 'utf8');
process.on('SIGTERM', () => {
  writeFileSync('terminated.tmp', 'yes');
  renameSync('terminated.tmp', 'terminated');
  if (mode === 'delayed') {
    setTimeout(() => { writeFileSync('done.tmp', 'yes'); renameSync('done.tmp', 'done'); process.exit(0); }, 100);
  }
});
let starttime = 'unknown';
try { starttime = readFileSync('/proc/self/stat', 'utf8').split(') ').pop().split(' ')[19]; } catch {}
// Readers watch for this file's creation; write+rename so they never observe
// a created-but-still-empty marker.
writeFileSync('ready.tmp', `${process.pid} ${starttime}`);
renameSync('ready.tmp', 'ready');
if (mode === 'overflow') process.stdout.write('x'.repeat(1024 * 1024 + 1));
setInterval(() => {}, 1000);
