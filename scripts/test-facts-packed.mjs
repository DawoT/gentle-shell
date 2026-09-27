import { execFile } from "node:child_process";
import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await mkdtemp(join(tmpdir(), "facts-packed-"));
const consumer = join(temporary, "consumer");
const home = join(temporary, "home");
const pack = join(temporary, "pack");
let npm = "npm";
let npmPrefix = [];
for (const candidate of [
  join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
  resolve(dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js"),
]) {
  try {
    await access(candidate);
    npm = process.execPath;
    npmPrefix = [candidate];
    break;
  } catch {
    // Try the next standard Node installation location, then PATH.
  }
}
try {
  await Promise.all([mkdir(consumer), mkdir(home), mkdir(pack)]);
  const env = {
    PATH: process.env.PATH,
    SYSTEMROOT: process.env.SYSTEMROOT,
    HOME: home,
    USERPROFILE: home,
    TMPDIR: temporary,
    TEMP: temporary,
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_CACHE_HOME: join(home, "cache"),
    GENTLE_PI_AGENT_HOME: join(home, "agent"),
    PI_OFFLINE: "1",
    NODE_ENV: "production",
    npm_config_userconfig: join(home, "npmrc"),
    npm_config_cache: join(home, "npm-cache"),
  };
  await writeFile(env.npm_config_userconfig, "");
  const options = { env, timeout: 180_000, maxBuffer: 4 * 1024 * 1024 };
  console.error("facts-packed: packing workspace");
  const packed = await exec(npm, [...npmPrefix, "pack", "--ignore-scripts", "--json", "--pack-destination", pack], { ...options, cwd: root });
  const tarball = join(pack, JSON.parse(packed.stdout)[0].filename);
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const sdkVersion = manifest.devDependencies["@earendil-works/pi-coding-agent"];
  await writeFile(join(consumer, "package.json"), JSON.stringify({ name: "facts-consumer", private: true, type: "module" }));
  console.error("facts-packed: installing production dependencies in isolation");
  await exec(npm, [...npmPrefix, "install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", tarball, `@earendil-works/pi-coding-agent@${sdkVersion}`], { ...options, cwd: consumer });
  await copyFile(join(root, "tests", "support", "facts-packed-session.mjs"), join(consumer, "probe.mjs"));
  console.error("facts-packed: loading extension in a real Pi session");
  const result = await exec(process.execPath, ["probe.mjs"], { ...options, cwd: consumer, timeout: 60_000 });
  process.stdout.write(result.stdout);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
