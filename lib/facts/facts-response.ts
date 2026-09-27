export const paginationProperties = {
  cursor: {
    type: "string",
    maxLength: 128,
    description: "Continue an immutable result using nextCursor. Repeat the original query and filters; omit offset. Expires after five minutes or retention eviction.",
  },
  offset: {
    type: "integer",
    minimum: 0,
    description: "Result offset. Use nextOffset from the previous response.",
  },
  limit: {
    type: "integer",
    minimum: 1,
    maximum: 50,
    description: "Maximum results per page (default 10). The response budget may reduce this.",
  },
};

interface PageOptions {
  offset?: number;
  limit?: number;
}

export function pageFacts<T>(items: T[], options: PageOptions, format: (item: T) => string) {
  const offset = options.offset ?? 0;
  const limit = options.limit ?? 10;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
    throw new RangeError("offset must be a nonnegative integer and limit must be between 1 and 50");
  }
  const rows: string[] = [];
  let characters = 0;
  let truncated = false;
  for (const item of items.slice(offset, offset + limit)) {
    const full = format(item);
    const shortened = full.length > 6500;
    const row = shortened
      ? `${full.slice(0, 6400)}\n[Truncated: inspect the source for the complete declaration.]`
      : full;
    if (characters + row.length + 2 > 14500) break;
    rows.push(row);
    characters += row.length + 2;
    truncated ||= shortened;
  }
  const nextOffset = offset + rows.length < items.length ? offset + rows.length : null;
  const continuation = nextOffset === null ? "" : `\n\nMore results: repeat with offset=${nextOffset}.`;
  return {
    text: rows.join("\n\n") + continuation,
    details: {
      returned: rows.length,
      nextOffset,
      truncated,
    },
  };
}
