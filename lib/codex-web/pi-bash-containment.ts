import { randomBytes } from "node:crypto";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, rmdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createLocalBashOperations, type BashOperations } from "@earendil-works/pi-coding-agent";

interface CommandCgroup {
  procsPath: string;
  kill(): void;
  release(): void;
}

function createCommandCgroup(): CommandCgroup | undefined {
  if (process.platform !== "linux") return undefined;
  let path: string | undefined;
  try {
    const current = readFileSync("/proc/self/cgroup", "utf8")
      .split("\n")
      .find(line => line.startsWith("0::"))
      ?.slice(3);
    if (!current || !current.startsWith("/") || current.includes("..")) return undefined;
    path = join("/sys/fs/cgroup", current, `gentle-pi-command-${randomBytes(12).toString("hex")}`);
    mkdirSync(path, { mode: 0o700 });
    if (!existsSync(join(path, "cgroup.kill"))) {
      rmdirSync(path);
      return undefined;
    }
    accessSync(join(path, "cgroup.procs"), constants.W_OK);
  } catch {
    if (path) {
      try { rmdirSync(path); } catch {}
    }
    return undefined;
  }
  if (!path) return undefined;

  let released = false;
  return {
    procsPath: join(path, "cgroup.procs"),
    kill() {
      try { writeFileSync(join(path, "cgroup.kill"), "1"); } catch {}
    },
    release() {
      if (released) return;
      released = true;
      let attempts = 0;
      const remove = () => {
        try {
          rmdirSync(path);
        } catch {
          attempts += 1;
          if (attempts < 20) setTimeout(remove, 100).unref();
        }
      };
      remove();
    },
  };
}

export function hasDelegatedCommandCgroup(): boolean {
  const cgroup = createCommandCgroup();
  cgroup?.release();
  return cgroup !== undefined;
}

/** Keep Pi's shell, output and process-group behavior; add Linux descendant cleanup. */
export function createContainedBashOperations(base: BashOperations = createLocalBashOperations()): BashOperations {
  return {
    async exec(command, cwd, options) {
      if (options.signal?.aborted) return base.exec(command, cwd, options);
      const cgroup = createCommandCgroup();
      if (!cgroup) return base.exec(command, cwd, options);
      const wrapped = 'printf "%s\\n" "$$" > "$GENTLE_PI_COMMAND_CGROUP_PROCS" || exit 125\n' + command;
      const timeoutMs = options.timeout === undefined ? undefined : options.timeout * 1000;
      if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
        cgroup.release();
        throw new Error("Invalid timeout: must be a finite number of seconds");
      }
      if (timeoutMs !== undefined && timeoutMs > 2_147_483_647) {
        cgroup.release();
        throw new Error("Invalid timeout: maximum is 2147483.647 seconds");
      }
      const controller = new AbortController();
      let cancellation: "external" | "timeout" | undefined;
      const stop = (reason: "external" | "timeout") => {
        if (cancellation) return;
        cancellation = reason;
        cgroup.kill();
        controller.abort();
      };
      const onAbort = () => stop("external");
      options.signal?.addEventListener("abort", onAbort, { once: true });
      if (options.signal?.aborted) onAbort();
      const timer = timeoutMs === undefined ? undefined : setTimeout(() => stop("timeout"), timeoutMs);
      try {
        return await base.exec(wrapped, cwd, {
          ...options,
          signal: controller.signal,
          timeout: undefined,
          env: { ...options.env, GENTLE_PI_COMMAND_CGROUP_PROCS: cgroup.procsPath },
        });
      } catch (error) {
        if (cancellation === "timeout") throw new Error(`timeout:${options.timeout}`);
        throw error;
      } finally {
        if (timer) clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        cgroup.kill();
        cgroup.release();
      }
    },
  };
}
