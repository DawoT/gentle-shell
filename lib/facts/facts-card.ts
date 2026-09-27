import { CARD_TONE, renderCard, type Card, type CardTheme } from "../shell-card.ts";
import type { FactsDatabase } from "./facts-types.ts";
import type { FactsDiagnostics } from "./facts-diagnostics.ts";

export interface FactsCardOptions {
  expanded?: boolean;
  collapseKey?: string;
  diagnostics?: FactsDiagnostics;
}

export function renderFactsCard(
  database: FactsDatabase | null,
  theme: CardTheme,
  width: number,
  options: FactsCardOptions = {},
): string[] {
  if (options.diagnostics && options.diagnostics.status !== "ready") {
    const diagnostics = options.diagnostics;
    return renderCard({
      title: "Facts",
      subtitle: diagnostics.status,
      tone: diagnostics.status === "unavailable" ? CARD_TONE.WARNING : CARD_TONE.INFO,
      glyph: "✿",
      body: [diagnostics.failure?.message ?? "Synchronizing the source index."],
    }, theme, width, { expanded: options.expanded ?? false, hint: options.collapseKey });
  }
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
      "Git-addressed symbol cache",
    ],
  };

  return renderCard(card, theme, width, {
    expanded: options.expanded ?? false,
    hint: options.collapseKey,
  });
}
