/**
 * Objectionable-text matching.
 *
 * This module is the specification. The Postgres functions in
 * `private.moderation_tokens` and `private.canonical_term` follow the same
 * steps so a direct Supabase write cannot bypass the Worker. Change both
 * together.
 *
 * Steps:
 * 1. Trim.
 * 2. Unicode NFKC.
 * 3. Lowercase.
 * 4. Remove zero-width characters.
 * 5. Map common lookalikes (0→o, 1→i, 3→e, 4→a, 5→s, 7→t, @→a, $→s, !→i).
 * 6. Remove apostrophes so "fu'ck" matches "fuck".
 * 7. Split on every remaining non-letter.
 * 8. Collapse a run of 3 or more of the same letter to one. Doubles stay,
 *    so "book" is not treated as "bok".
 * 9. A run of 3 or more single-letter tokens is also kept joined, so
 *    "f.u.c.k" matches "fuck".
 * Matching is whole tokens or a consecutive phrase, never a substring.
 */

export const OBJECTIONABLE_TEXT = "That text isn't allowed on Replayr.";

export const TERM_CATEGORIES = ["profanity", "slur", "sexual", "threat", "other"] as const;
export type TermCategory = (typeof TERM_CATEGORIES)[number];

const TERM_MIN_LETTERS = 3;
const TERM_MAX_RAW = 64;
const TERM_MIN_RAW = 2;
const TERM_MAX_KEY = 80;
const NOTE_MAX = 200;

const ZERO_WIDTH = /[\u200B-\u200D\uFEFF\u2060]/g;
const APOSTROPHES = /['\u2018\u2019\u2032`]/g;
const LEET: Record<string, string> = {
  "0": "o",
  "1": "i",
  "3": "e",
  "4": "a",
  "5": "s",
  "7": "t",
  "@": "a",
  $: "s",
  "!": "i",
};

export function isTermCategory(value: string): value is TermCategory {
  return (TERM_CATEGORIES as readonly string[]).includes(value);
}

export function moderationTokens(input: string): string[] {
  const folded = input.trim().normalize("NFKC").toLowerCase().replace(ZERO_WIDTH, "");
  let mapped = "";
  for (const char of folded) mapped += LEET[char] ?? char;
  mapped = mapped.replace(APOSTROPHES, "");

  const rough = mapped
    .split(/[^a-z]+/)
    .filter(Boolean)
    .map(collapseRuns);
  const tokens = [...rough];
  let singles = "";
  const flush = () => {
    if (singles.length >= TERM_MIN_LETTERS) tokens.push(collapseRuns(singles));
    singles = "";
  };
  for (const token of rough) {
    if (token.length === 1) singles += token;
    else flush();
  }
  flush();
  return tokens;
}

export function canonicalTerm(input: string): string | null {
  const kept: string[] = [];
  for (const token of moderationTokens(input)) {
    if (token.length < TERM_MIN_LETTERS) continue;
    if (kept[kept.length - 1] !== token) kept.push(token);
  }
  if (kept.length === 0) return null;
  const key = kept.join(" ");
  if (key.replace(/ /g, "").length < TERM_MIN_LETTERS || key.length > TERM_MAX_KEY) return null;
  return key;
}

export function violatesTerms(text: string, normalizedTerms: readonly string[]): boolean {
  if (normalizedTerms.length === 0) return false;
  const tokens = moderationTokens(text);
  if (tokens.length === 0) return false;
  for (const term of normalizedTerms) {
    const parts = term.split(" ").filter(Boolean);
    if (parts.length === 0 || parts.length > tokens.length) continue;
    for (let start = 0; start <= tokens.length - parts.length; start += 1) {
      let matched = true;
      for (let offset = 0; offset < parts.length; offset += 1) {
        if (tokens[start + offset] !== parts[offset]) {
          matched = false;
          break;
        }
      }
      if (matched) return true;
    }
  }
  return false;
}

export type PreparedTerm = {
  term: string;
  normalized: string;
  category: TermCategory;
  note: string | null;
};

/** Validates a staff-entered term. Does not check the database for duplicates. */
export function prepareTerm(input: { term?: unknown; category?: unknown; note?: unknown }): PreparedTerm {
  if (typeof input.term !== "string") throw new TermInputError("Enter the word or phrase to block.");
  const term = input.term.trim().replace(/\s+/g, " ");
  if (term.length < TERM_MIN_RAW || term.length > TERM_MAX_RAW) {
    throw new TermInputError("Terms must be 2–64 characters.");
  }
  if (/[\u0000-\u001f]/.test(term)) throw new TermInputError("Terms cannot include line breaks.");
  const normalized = canonicalTerm(term);
  if (!normalized) throw new TermInputError("Use a word or phrase of at least 3 letters.");
  if (typeof input.category !== "string" || !isTermCategory(input.category)) {
    throw new TermInputError("Choose a category.");
  }
  let note: string | null = null;
  if (input.note != null && input.note !== "") {
    if (typeof input.note !== "string") throw new TermInputError("The note must be text.");
    note = input.note.trim();
    if (note.length > NOTE_MAX) throw new TermInputError("Notes must be 200 characters or fewer.");
    if (!note) note = null;
  }
  return { term, normalized, category: input.category, note };
}

export class TermInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TermInputError";
  }
}

function collapseRuns(token: string): string {
  return token.replace(/([a-z])\1{2,}/g, "$1");
}
