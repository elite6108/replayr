import { describe, expect, it } from "vitest";
import { canonicalTerm, prepareTerm, TermInputError, violatesTerms } from "./contentPolicy";

describe("content policy", () => {
  it("matches a word and rejects ordinary text that only shares letters", () => {
    const fuck = canonicalTerm("fuck");
    expect(fuck).toBe("fuck");
    expect(violatesTerms("what the fuck", ["fuck"])).toBe(true);
    expect(violatesTerms("have a good day", ["fuck"])).toBe(false);
    expect(violatesTerms("classic", ["ass"])).toBe(false);
    expect(violatesTerms("assassin", ["ass"])).toBe(false);
  });

  it("folds case, lookalikes, apostrophes, spaced letters, and long repeats", () => {
    expect(violatesTerms("FUCK", ["fuck"])).toBe(true);
    expect(violatesTerms("f0ck", ["fuck"])).toBe(false);
    expect(violatesTerms("f.u.c.k", ["fuck"])).toBe(true);
    expect(violatesTerms("f u c k", ["fuck"])).toBe(true);
    expect(violatesTerms("fu'ck", ["fuck"])).toBe(true);
    expect(violatesTerms("fuuuuck", ["fuck"])).toBe(true);
    expect(violatesTerms("n1gger", ["nigger"])).toBe(true);
  });

  it("matches a phrase in order and not the words alone when they are split", () => {
    expect(canonicalTerm("kill yourself")).toBe("kill yourself");
    expect(violatesTerms("I will kill yourself today", ["kill yourself"])).toBe(true);
    expect(violatesTerms("kill the yourself", ["kill yourself"])).toBe(false);
    expect(violatesTerms("kys", ["kys"])).toBe(true);
  });

  it("does not treat a doubled letter as a longer run", () => {
    expect(canonicalTerm("book")).toBe("book");
    expect(violatesTerms("book", ["bok"])).toBe(false);
    expect(violatesTerms("fuuck", ["fuck"])).toBe(false);
  });

  it("rejects terms that are too short to be safe", () => {
    expect(canonicalTerm("a")).toBeNull();
    expect(canonicalTerm("!!")).toBeNull();
    expect(canonicalTerm("as")).toBeNull();
    expect(() => prepareTerm({ term: "as", category: "other" })).toThrow(TermInputError);
  });

  it("stores the canonical key and a category", () => {
    expect(prepareTerm({ term: "  F.U.C.K. ", category: "profanity", note: "  seed  " })).toEqual({
      term: "F.U.C.K.",
      normalized: "fuck",
      category: "profanity",
      note: "seed",
    });
  });

  it("ignores an empty term list", () => {
    expect(violatesTerms("fuck", [])).toBe(false);
  });
});
