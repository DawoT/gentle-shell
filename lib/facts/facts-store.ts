import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { FactsDatabase } from "./facts-types.ts";

export class FactsStore {
	private readonly storageDir: string;
	private readonly filePath: string;

	constructor(workspaceRoot: string, customDirName: string = ".pi") {
		this.storageDir = join(workspaceRoot, customDirName);
		this.filePath = join(this.storageDir, "facts.json");
	}

	async load(): Promise<FactsDatabase | null> {
		if (!existsSync(this.filePath)) {
			return null;
		}

		try {
			const content = await readFile(this.filePath, "utf8");
			const parsed = JSON.parse(content) as FactsDatabase;
			if (!parsed || typeof parsed !== "object" || !parsed.files) {
				return null;
			}
			return parsed;
		} catch {
			return null;
		}
	}

	async save(database: FactsDatabase): Promise<void> {
		await mkdir(this.storageDir, { recursive: true });

		const tmpFile = `${this.filePath}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
		const payload = JSON.stringify(database, null, 2);

		await writeFile(tmpFile, payload, "utf8");
		await rename(tmpFile, this.filePath);
	}
}
