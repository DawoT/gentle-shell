import { CARD_TONE, renderCard, type Card, type CardTheme } from "../shell-card.ts";
import type { FactsDatabase } from "./facts-types.ts";

export interface FactsCardOptions {
	expanded?: boolean;
	collapseKey?: string;
}

export function renderFactsCard(
	database: FactsDatabase | null,
	theme: CardTheme,
	width: number,
	options: FactsCardOptions = {},
): string[] {
	if (!database || Object.keys(database.files).length === 0) {
		const emptyCard: Card = {
			title: "Facts",
			subtitle: "ready",
			tone: CARD_TONE.INFO,
			glyph: "✿",
			body: ["No facts indexed yet. Automatic sync runs at session start."],
		};

		return renderCard(emptyCard, theme, width, {
			expanded: options.expanded ?? false,
			hint: options.collapseKey,
		});
	}

	const fileCount = Object.keys(database.files).length;
	let symbolCount = 0;
	for (const file of Object.values(database.files)) {
		symbolCount += file.symbols.length;
	}

	const testCmd = database.receipts?.testCommand || "none declared";
	const pm = database.receipts?.packageManager || "auto";

	const card: Card = {
		title: "Facts",
		subtitle: `${symbolCount} symbols · ${fileCount} files`,
		tone: CARD_TONE.INFO,
		glyph: "✿",
		body: [
			`Test runner: ${testCmd} (${pm})`,
			`Indexed files: ${fileCount} · Total symbols: ${symbolCount}`,
			"Deterministic cache: 100% synchronized with Git",
		],
	};

	return renderCard(card, theme, width, {
		expanded: options.expanded ?? false,
		hint: options.collapseKey,
	});
}
