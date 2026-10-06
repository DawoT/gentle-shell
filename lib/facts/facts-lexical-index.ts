import type { FactsDatabase } from "./facts-types.ts";

export type LexicalKind = "symbol" | "path" | "docstring";

export interface LexicalMatch {
  kind: LexicalKind;
  file: string;
  /** Symbol name for symbol/docstring matches. */
  name?: string;
  /** The exact original-case text that matched: the evidence for this hit. */
  match: string;
  score: number;
}

export interface LexicalSearchOptions {
  limit?: number;
}

interface LexicalEntry {
  kind: LexicalKind;
  file: string;
  name?: string;
  lower: string;
  text: string;
}

export interface LexicalIndex {
  dbRef: FactsDatabase;
  entries: LexicalEntry[];
  byLowerText: Map<string, number[]>;
  prefixes: Map<string, number[]>;
  trigrams: Map<string, number[]>;
  trigramSets: (Set<string> | null)[];
}

const MAX_PREFIX_LENGTH = 64;
const TRIGRAM_THRESHOLD = 0.35;
const SCORE_EXACT = 1;
const SCORE_PREFIX = 0.75;
const SCORE_TOKEN = 0.6;
const SCORE_TRIGRAM = 0.5;

function trigramsOf(lower: string): Set<string> {
  const set = new Set<string>();
  if (lower.length < 3) {
    set.add(lower);
    return set;
  }
  for (let i = 0; i <= lower.length - 3; i++) set.add(lower.slice(i, i + 3));
  return set;
}

function tokenize(lower: string): string[] {
  return lower.split(/[^a-z0-9]+/i).filter((token) => token.length > 0);
}

/**
 * Per-generation lexical discovery index (gaps GF-P2-004): entries for symbol
 * names, paths and docstrings with exact, prefix, token and ranked trigram
 * fuzzy search. Every match carries the exact original-case text it matched
 * plus its file (and symbol name), so agents can follow up with exact
 * structural queries. Semantic/embedding search is deliberately out of scope.
 * Exact and prefix lookups are O(result); token and fuzzy scans rank all
 * candidate entries and are bounded by the caller's limit after ranking.
 */
export function buildLexicalIndex(db: FactsDatabase): LexicalIndex {
  const entries: LexicalEntry[] = [];
  const byLowerText = new Map<string, number[]>();
  const prefixes = new Map<string, number[]>();
  const trigrams = new Map<string, number[]>();
  const trigramSets: (Set<string> | null)[] = [];
  const push = (kind: LexicalKind, file: string, text: string, name?: string) => {
    const lower = text.toLowerCase();
    const index = entries.length;
    entries.push({ kind, file, name, lower, text });
    const exact = byLowerText.get(lower);
    if (exact) exact.push(index);
    else byLowerText.set(lower, [index]);
    const prefixLength = Math.min(lower.length, MAX_PREFIX_LENGTH);
    for (let length = 1; length <= prefixLength; length++) {
      const prefix = lower.slice(0, length);
      const bucket = prefixes.get(prefix);
      if (bucket) bucket.push(index);
      else prefixes.set(prefix, [index]);
    }
    if (lower.length >= 3) {
      const set = trigramsOf(lower);
      trigramSets[index] = set;
      for (const trigram of set) {
        const list = trigrams.get(trigram);
        if (list) list.push(index);
        else trigrams.set(trigram, [index]);
      }
    } else {
      trigramSets[index] = null;
    }
  };
  for (const [path, facts] of Object.entries(db.files)) {
    push("path", path, path);
    for (const symbol of facts.symbols) {
      push("symbol", path, symbol.name, symbol.name);
      if (symbol.docstring) push("docstring", path, symbol.docstring, symbol.name);
    }
  }
  return { dbRef: db, entries, byLowerText, prefixes, trigrams, trigramSets };
}

/** Ranks candidates: exact > prefix > token > trigram, then a deterministic kind/file/name order. */
function rank(candidates: Map<number, number>, entries: LexicalEntry[], limit: number | undefined): LexicalMatch[] {
  const ranked = [...candidates.entries()]
    .sort((a, b) => b[1] - a[1] || entries[a[0]].kind.localeCompare(entries[b[0]].kind) ||
      entries[a[0]].file.localeCompare(entries[b[0]].file, "en") ||
      (entries[a[0]].name ?? "").localeCompare(entries[b[0]].name ?? "", "en") ||
      a[0] - b[0])
    .map(([index, score]) => ({ entry: entries[index], score }));
  const matches = ranked.map(({ entry, score }) => ({
    kind: entry.kind,
    file: entry.file,
    ...(entry.name ? { name: entry.name } : {}),
    match: entry.text,
    score: Math.round(score * 1e4) / 1e4,
  }));
  return limit !== undefined ? matches.slice(0, limit) : matches;
}

export function lexicalSearch(index: LexicalIndex, query: string, options: LexicalSearchOptions = {}): LexicalMatch[] {
  const lower = query.trim().toLowerCase();
  if (!lower) return [];
  const candidates = new Map<number, number>();
  const consider = (entryIndex: number, score: number) => {
    const previous = candidates.get(entryIndex);
    if (previous === undefined || score > previous) candidates.set(entryIndex, score);
  };

  // Exact matches.
  for (const entryIndex of index.byLowerText.get(lower) ?? []) consider(entryIndex, SCORE_EXACT);

  // Prefix matches via the precomputed prefix map.
  for (const entryIndex of index.prefixes.get(lower) ?? []) {
    if (index.entries[entryIndex].lower.startsWith(lower)) consider(entryIndex, SCORE_PREFIX);
  }

  // Token matches: every whitespace/alphanumeric token must appear.
  const tokens = tokenize(lower);
  if (tokens.length > 0) {
    for (let i = 0; i < index.entries.length; i++) {
      const entry = index.entries[i];
      if (tokens.every((token) => entry.lower.includes(token))) consider(i, SCORE_TOKEN);
    }
  }

  // Trigram fuzzy: candidates sharing at least one trigram, ranked by Jaccard.
  const queryTrigrams = trigramsOf(lower);
  const overlap = new Map<number, number>();
  for (const trigram of queryTrigrams) {
    for (const entryIndex of index.trigrams.get(trigram) ?? []) {
      overlap.set(entryIndex, (overlap.get(entryIndex) ?? 0) + 1);
    }
  }
  for (const [entryIndex, shared] of overlap) {
    const entrySet = index.trigramSets[entryIndex];
    if (!entrySet) continue;
    const union = queryTrigrams.size + entrySet.size - shared;
    const jaccard = union > 0 ? shared / union : 0;
    if (jaccard >= TRIGRAM_THRESHOLD) consider(entryIndex, SCORE_TRIGRAM * jaccard);
  }

  return rank(candidates, index.entries, options.limit);
}
