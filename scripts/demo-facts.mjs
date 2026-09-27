import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import gentleFacts from "../extensions/gentle-facts.ts";

const expectedSignature = "function settlementTotal(items: readonly SettlementItem[], feeBasisPoints: number): number";

function fixtureSource() {
  const lines = [
    "export interface SettlementItem {",
    "  grossCents: number;",
    "  refundedCents: number;",
    "}",
    "",
    "export const settlementProfiles = [",
  ];
  for (const country of ["PE", "CO", "CL", "MX", "AR", "BR", "UY", "EC"]) {
    for (let riskBand = 1; riskBand <= 6; riskBand += 1) {
      lines.push(
        "  {",
        `    country: "${country}",`,
        `    riskBand: ${riskBand},`,
        `    feeBasisPoints: ${100 + riskBand * 25},`,
        `    settlementDays: ${riskBand + 1},`,
        "  },",
      );
    }
  }
  lines.push(
    "];",
    "",
    "/** Return settlement cents after refunds and the supplied processing fee. */",
    `export ${expectedSignature} {`,
    "  const netCents = items.reduce((total, item) => {",
    "    return total + Math.max(0, item.grossCents - item.refundedCents);",
    "  }, 0);",
    "  return Math.round(netCents * (1 - feeBasisPoints / 10000));",
    "}",
    "",
  );
  return lines.join("\n");
}

function harness() {
  const tools = new Map();
  const handlers = new Map();
  const pi = {
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
  };
  return {
    pi,
    tools,
    async emit(event, context) {
      for (const handler of handlers.get(event) ?? []) {
        await handler({}, context);
      }
    },
  };
}

const milliseconds = (start) => Math.round((performance.now() - start) * 100) / 100;

/** Capture real extension output; no model, browser, live repository or Pi process is involved. */
export async function captureFactsDemo() {
  const cwd = await mkdtemp(join(tmpdir(), "gentle-facts-demo-"));
  const host = harness();
  const context = { cwd, hasUI: false };
  try {
    const git = (...args) => execFileSync("git", args, { cwd, stdio: "ignore", timeout: 15000 });
    git("init", "-b", "main");
    await writeFile(join(cwd, ".gitignore"), ".pi/\n");
    await writeFile(join(cwd, "settlement.ts"), fixtureSource());
    git("add", ".");
    git("-c", "user.name=Facts Demo", "-c", "user.email=demo@example.invalid", "commit", "-m", "owned synthetic settlement fixture");

    gentleFacts(host.pi);
    const coldStarted = performance.now();
    await host.emit("session_start", context);
    const coldIndexMs = milliseconds(coldStarted);

    const readStarted = performance.now();
    const source = await readFile(join(cwd, "settlement.ts"), "utf8");
    const fullFileReadMs = milliseconds(readStarted);
    // Independent fixture contract: exact authored declaration, not a second Facts query.
    const baselineSignature = source.match(/^export (function settlementTotal\([^\n]+\): number) \{$/m)?.[1];
    assert.equal(baselineSignature, expectedSignature);

    const queryStarted = performance.now();
    const result = await host.tools.get("facts_query").execute("demo", { file: "settlement.ts", name: "settlementTotal" }, undefined, undefined, context);
    const queryWithRefreshMs = milliseconds(queryStarted);
    assert.equal(result.details.status, "ready");
    assert.equal(result.details.returned, 1);
    const output = result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
    const factsSignature = output.match(/Signature: ([^\n]+)/)?.[1];
    assert.equal(factsSignature, expectedSignature);
    const sourceLines = source.split("\n");
    const declarationLine = sourceLines.findIndex((line) => line === `export ${expectedSignature} {`) + 1;
    assert.ok(output.includes(`lines ${declarationLine}-`));
    const sourceBytes = Buffer.byteLength(source, "utf8");
    const responseBytes = Buffer.byteLength(output, "utf8");
    const implementationFiles = ["extensions/gentle-facts.ts", "lib/facts/facts-service.ts", "lib/facts/facts-ts-extractor.ts", "scripts/demo-facts.mjs"];
    const implementationHash = createHash("sha256");
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    for (const path of implementationFiles) {
      implementationHash.update(path);
      implementationHash.update(await readFile(join(root, path)));
    }
    return {
      generatedAt: new Date().toISOString(),
      node: process.version,
      platform: process.platform,
      tool: "facts_query extension handler (local harness, no model)",
      fixture: "owned synthetic settlement module; 48 country/risk profiles",
      sourceSha256: createHash("sha256").update(source).digest("hex"),
      implementationSha256: implementationHash.digest("hex"),
      implementationFiles,
      sourceBytes,
      responseBytes,
      coldIndexMs,
      fullFileReadMs,
      queryWithRefreshMs,
      estimatedContextReductionTokens: Math.trunc((sourceBytes - responseBytes) / 4),
      correctness: { expectedSignature, baselineSignature, factsSignature, declarationLine },
      output,
      baselineExcerpt: sourceLines.slice(0, 12).join("\n"),
      limitations: [
        "Single synthetic fixture/sample; no production latency or adoption guarantee.",
        "Full-file baseline is an actual read, not an observed agent strategy; range reads may use fewer bytes.",
        "Cold indexing is measured separately. Warm facts_query time includes its actual refresh; file read is filesystem-warm.",
        "Bytes/4 is a heuristic, not a tokenizer, billed savings, model timing or monetary ROI.",
        "Cast timestamps are presentation timing, not measured task latency. No model/provider/SDK session is invoked.",
      ],
    };
  } finally {
    try {
      await host.emit("session_shutdown", context);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }
}

export function renderFactsDemo(report) {
  const frames = [
    [0, "\u001b[2J\u001b[Hgentle-facts | verified declaration discovery\r\nSynthetic fixture, real extension handler, no model calls.\r\n30-second presentation timing; measured durations appear separately.\r\n"],
    [3, "$ read full settlement.ts\r\n"],
    [5, `${report.baselineExcerpt}\n[Display excerpt; actual full-file read measured ${report.sourceBytes} UTF-8 bytes.]\n`],
    [9, `Independent declaration check: ${report.correctness.baselineSignature}\nActual full-file read: ${report.fullFileReadMs} ms (filesystem-warm).\n`],
    [13, `$ facts_query { file: "settlement.ts", name: "settlementTotal" }\n`],
    [16, `${report.output}\n`],
    [21, `Verified: same authored signature and declaration line ${report.correctness.declarationLine}.\nActual cold index: ${report.coldIndexMs} ms. Warm query + refresh: ${report.queryWithRefreshMs} ms.\nContext: full file ${report.sourceBytes} bytes; Facts response ${report.responseBytes} bytes.\n`],
    [25, `Heuristic context reduction: ~${report.estimatedContextReductionTokens} tokens (bytes/4); not billed savings.\nFull-file baseline is a comparison assumption, not observed agent behavior.\n`],
    [29, "No model latency, dollar ROI or merge outcome claims.\nReproduce: node --experimental-strip-types scripts/demo-facts.mjs\n"],
  ];
  const header = {
    version: 2,
    width: 112,
    height: 28,
    timestamp: Math.floor(Date.parse(report.generatedAt) / 1000),
    title: "gentle-facts: verified context comparison",
    env: { TERM: "xterm-256color" },
  };
  const events = frames.map(([time, text]) => {
    // Terminal recordings require carriage return as well as line feed.
    return JSON.stringify([time, "o", text.replace(/\r?\n/g, "\r\n")]);
  });
  return `${[JSON.stringify(header), ...events].join("\n")}\n`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 0 && (args.length !== 2 || args[0] !== "--output-dir")) {
    throw new Error("Usage: node --experimental-strip-types scripts/demo-facts.mjs [--output-dir DIRECTORY]");
  }
  const outputDir = args.length ? resolve(args[1]) : resolve(dirname(fileURLToPath(import.meta.url)), "../docs/evidence");
  const report = await captureFactsDemo();
  await mkdir(outputDir, { recursive: true });
  await writeFile(join(outputDir, "gentle-facts-demo.cast"), renderFactsDemo(report));
  await writeFile(join(outputDir, "gentle-facts-demo.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ outputDir, sourceBytes: report.sourceBytes, responseBytes: report.responseBytes, coldIndexMs: report.coldIndexMs, queryWithRefreshMs: report.queryWithRefreshMs }, null, 2));
}
