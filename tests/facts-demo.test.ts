import assert from "node:assert/strict";
import test from "node:test";
import { captureFactsDemo, renderFactsDemo } from "../scripts/demo-facts.mjs";

test("Facts demo records real tool output and labels presentation timing and estimates", async () => {
  const report = await captureFactsDemo();
  assert.equal(report.tool, "facts_query extension handler (local harness, no model)");
  assert.equal(report.correctness.baselineSignature, report.correctness.factsSignature);
  assert.equal(report.correctness.expectedSignature, report.correctness.factsSignature);
  assert.equal(report.responseBytes, Buffer.byteLength(report.output, "utf8"));
  assert.ok(report.sourceBytes > report.responseBytes);
  assert.ok(report.coldIndexMs >= 0 && report.queryWithRefreshMs >= 0 && report.fullFileReadMs >= 0);
  const lines = renderFactsDemo(report).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(lines[0].version, 2);
  assert.ok(lines.at(-1)[0] <= 30);
  assert.ok(lines.slice(1).every((event, index, events) => event[1] === "o" && (index === 0 || event[0] >= events[index - 1][0])));
  const terminalOutput = lines.slice(1).map((event) => event[2]).join("");
  assert.doesNotMatch(terminalOutput, /(?<!\r)\n/);
  const output = terminalOutput.replace(/\r\n/g, "\n");
  assert.match(output, /presentation timing/);
  assert.match(output, /not billed savings/);
  assert.match(output, /cold index/);
  assert.ok(output.includes(report.output));
});
