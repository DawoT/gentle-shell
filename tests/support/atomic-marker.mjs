// Shared atomic marker utilities for test fixtures.
//
// Watchers can observe a marker file between its creation and its write,
// reading empty or partial content. Writers therefore use write+rename (atomic
// within the filesystem) and readers validate content before resolving.
import { readFileSync, renameSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";

let counter = 0;

// Write `${dir}/${name}` atomically: the content lands in a uniquely named
// temp file, then renameSync publishes it in one filesystem step. Readers
// watching the directory can never see a created-but-incomplete marker.
export function atomicWriteMarker(dir, name, content) {
  const temp = join(dir, `${name}.tmp-${process.pid}-${counter++}`);
  writeFileSync(temp, content);
  renameSync(temp, join(dir, name));
}

// Resolve with the marker's trimmed content once the file exists AND its
// content passes options.validate (default: non-empty after trim). Polls via
// an initial direct check plus an fs.watch on the directory. The watcher and
// timeout timer are always cleaned up, whether the promise resolves or
// rejects. options.timeoutMs (default 20_000) rejects with an Error naming
// the marker.
export function waitForMarker(dir, name, options = {}) {
  const { timeoutMs = 20_000, validate = (content) => content !== "" } = options;
  return new Promise((resolve, reject) => {
    const watcher = watch(dir, () => { void check(); });
    const timer = setTimeout(() => finish(new Error(`Marker did not appear or never became valid within ${timeoutMs}ms: ${name}`)), timeoutMs);
    let settled = false;
    function finish(error, value) {
      if (settled) return;
      settled = true;
      watcher.close();
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    }
    async function check() {
      let content;
      try {
        content = readFileSync(join(dir, name), "utf8");
      } catch (error) {
        if (error?.code !== "ENOENT") finish(error);
        return;
      }
      // Incomplete or invalid content: keep waiting for the next write.
      const trimmed = content.trim();
      let valid;
      try {
        valid = validate(trimmed);
      } catch (error) {
        finish(error);
        return;
      }
      if (!valid) return;
      finish(undefined, trimmed);
    }
    void check();
  });
}
