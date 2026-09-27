import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CandidateViewRegistry } from "../lib/review-candidate-view.ts";
import { injectReviewFactsImpact } from "../lib/review-facts-impact.ts";

function fixture(t: test.TestContext, lenses: string[] = ["review-risk"]) {
  const root = mkdtempSync(join(tmpdir(), "review-facts-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("init", "-b", "main");
  writeFileSync(join(root, "api.ts"), 'export const value = 1;');
  writeFileSync(join(root, "consumer.ts"), 'import { value } from "./api"; export const copy = value;');
  git("add", ".");
  git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "base");
  writeFileSync(join(root, "api.ts"), 'export const value = 2;');
  const registry = new CandidateViewRegistry();
  const view = registry.create({ contributorRoot: root });
  registry.bind({ token: view.token, lineageId: "facts-review", selectedLenses: lenses });
  const cleanupTokens = [view.token];
  t.after(() => {
    for (const token of cleanupTokens) registry.cleanup(token);
    rmSync(root, { recursive: true, force: true });
  });
  return { root, registry, view, cleanupTokens };
}

const input = () => ({ agent: "review-risk", task: "Review the changes.", mode: "task" });

test("review dispatch includes bounded advisory evidence from its frozen trees", async (t) => {
  const { registry, view } = fixture(t);
  const request = input();
  await injectReviewFactsImpact(request, registry);
  assert.match(request.task, /Facts impact/);
  assert.match(request.task, /consumer.ts/);
  assert.ok(request.task.includes(view.candidateTree));
  assert.match(request.task, /does not expand.*scope/i);
  assert.ok(Buffer.byteLength(request.task) - Buffer.byteLength(input().task) <= 4096);
});

test("analysis failure is advisory but candidate drift still blocks dispatch without mutating input", async (t) => {
  const { registry, root } = fixture(t);
  const unavailable = input();
  await injectReviewFactsImpact(unavailable, registry, { analyze: async () => { throw new Error("missing parser"); } });
  assert.match(unavailable.task, /Facts impact unavailable/);
  const changed = input();
  await assert.rejects(injectReviewFactsImpact(changed, registry, { analyze: async () => {
    writeFileSync(join(root, "api.ts"), 'export const value = 3;');
    throw new Error("parser unavailable");
  } }), /candidate|binding|drift/i);
  assert.deepEqual(changed, input());
});

test("non-review actors remain unchanged and do not trigger Facts analysis", async () => {
  const request = { agent: "explore", task: "Inspect", mode: "task" };
  await injectReviewFactsImpact(request, null, { analyze: async () => { throw new Error("must not run"); } });
  assert.equal(request.task, "Inspect");
});

test("review advisory never enlarges the controller context budget", async (t) => {
  const { injectReviewCandidateView } = await import("../lib/review-candidate-view.ts");
  const { registry } = fixture(t);
  const request = input();
  injectReviewCandidateView(request, registry, "x".repeat(10000));
  assert.match(request.task, /context budget/);
  assert.ok(Buffer.byteLength(request.task) - Buffer.byteLength(input().task) <= 4096);
});

test("cancellation and lineage replacement never publish prepared context", async (t) => {
  const { registry, view, cleanupTokens } = fixture(t);
  const request = input();
  const controller = new AbortController();
  await assert.rejects(injectReviewFactsImpact(request, registry, { signal: controller.signal, analyze: async () => {
    controller.abort(new Error("cancelled"));
    throw new Error("cancelled");
  } }), /cancelled/);
  assert.deepEqual(request, input());
  await assert.rejects(injectReviewFactsImpact(request, registry, { analyze: async () => {
    const replacement = registry.create({ contributorRoot: view.contributorRoot });
    cleanupTokens.push(replacement.token);
    registry.bind({ token: replacement.token, lineageId: "different-lineage", selectedLenses: ["review-risk"] });
    throw new Error("unavailable");
  } }), /binding|lineage/);
  assert.deepEqual(request, input());
});

test("dispatch detects mutation of the actor array during asynchronous analysis", async (t) => {
  const { registry } = fixture(t, ["review-risk", "review-readability"]);
  const request = { agents: ["review-risk"], task: "Review the changes.", mode: "task" };
  await assert.rejects(injectReviewFactsImpact(request, registry, { analyze: async () => {
    request.agents.push("review-readability");
    throw new Error("unavailable");
  } }), /input changed/);
  assert.equal(request.task, "Review the changes.");
});
