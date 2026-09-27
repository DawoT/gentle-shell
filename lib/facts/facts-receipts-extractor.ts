import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExecutionReceipts } from "./facts-types.ts";

export async function extractExecutionReceipts(workspaceRoot: string): Promise<ExecutionReceipts> {
	const receipts: ExecutionReceipts = {
		dependencies: {},
		devDependencies: {},
	};

	const pkgPath = join(workspaceRoot, "package.json");
	if (!existsSync(pkgPath)) {
		return receipts;
	}

	try {
		const raw = await readFile(pkgPath, "utf8");
		const pkg = JSON.parse(raw);

		// 1. Detect package manager
		let pm = "npm";
		if (typeof pkg.packageManager === "string") {
			receipts.packageManager = pkg.packageManager;
			pm = pkg.packageManager.split("@")[0] || "npm";
		} else if (existsSync(join(workspaceRoot, "pnpm-lock.yaml"))) {
			receipts.packageManager = "pnpm";
			pm = "pnpm";
		} else if (existsSync(join(workspaceRoot, "yarn.lock"))) {
			receipts.packageManager = "yarn";
			pm = "yarn";
		} else if (existsSync(join(workspaceRoot, "bun.lockb")) || existsSync(join(workspaceRoot, "bun.lock"))) {
			receipts.packageManager = "bun";
			pm = "bun";
		} else if (existsSync(join(workspaceRoot, "package-lock.json"))) {
			receipts.packageManager = "npm";
			pm = "npm";
		}

		// 2. Resolve verified commands
		const scripts = pkg.scripts || {};
		if (scripts.test) {
			receipts.testCommand = pm === "npm" ? "npm test" : `${pm} test`;
		}
		if (scripts.build) {
			receipts.buildCommand = `${pm} run build`;
		}
		if (scripts.lint) {
			receipts.lintCommand = `${pm} run lint`;
		}

		// 3. Collect dependencies
		if (pkg.dependencies && typeof pkg.dependencies === "object") {
			receipts.dependencies = { ...pkg.dependencies };
		}
		if (pkg.devDependencies && typeof pkg.devDependencies === "object") {
			receipts.devDependencies = { ...pkg.devDependencies };
		}
	} catch {
		// Return empty receipts on JSON error
	}

	return receipts;
}
