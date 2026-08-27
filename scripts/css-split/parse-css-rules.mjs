/** Parse top-level CSS rules, preserving full text (including comments inside). */

export function parseTopLevelRules(src) {
  const rules = [];
  let i = 0;
  const n = src.length;

  const skipComment = () => {
    if (src[i] === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end < 0 ? n : end + 2;
      return true;
    }
    return false;
  };

  while (i < n) {
    // Skip only whitespace before a rule; keep leading comments attached
    // to the following rule so they are not dropped on split.
    while (i < n && /\s/.test(src[i])) i++;
    if (i >= n) break;

    const start = i;
    let inStr = null;
    let esc = false;

    while (i < n) {
      const ch = src[i];
      if (inStr) {
        if (esc) {
          esc = false;
          i++;
          continue;
        }
        if (ch === "\\") {
          esc = true;
          i++;
          continue;
        }
        if (ch === inStr) inStr = null;
        i++;
        continue;
      }
      if (ch === "'" || ch === '"') {
        inStr = ch;
        i++;
        continue;
      }
      if (src[i] === "/" && src[i + 1] === "*") {
        const end = src.indexOf("*/", i + 2);
        i = end < 0 ? n : end + 2;
        continue;
      }
      if (ch === "{") break;
      i++;
    }

    if (i >= n) {
      const trailer = src.slice(start).trim();
      if (trailer) {
        rules.push({
          kind: "trailer",
          prelude: trailer,
          text: src.slice(start),
          start,
          end: n,
        });
      }
      break;
    }

    const rawPrelude = src.slice(start, i);
    const prelude = rawPrelude
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .trim();
    let depth = 0;
    inStr = null;
    esc = false;

    while (i < n) {
      const ch = src[i];
      if (inStr) {
        if (esc) {
          esc = false;
          i++;
          continue;
        }
        if (ch === "\\") {
          esc = true;
          i++;
          continue;
        }
        if (ch === inStr) inStr = null;
        i++;
        continue;
      }
      if (ch === "'" || ch === '"') {
        inStr = ch;
        i++;
        continue;
      }
      if (skipComment()) continue;
      if (ch === "{") {
        depth++;
        i++;
        continue;
      }
      if (ch === "}") {
        depth--;
        i++;
        if (depth === 0) break;
        continue;
      }
      i++;
    }

    let kind = "style";
    if (prelude.startsWith("@media")) kind = "media";
    else if (
      prelude.startsWith("@keyframes") ||
      prelude.startsWith("@-webkit-keyframes")
    ) {
      kind = "keyframes";
    } else if (prelude.startsWith("@")) kind = "at";

    rules.push({
      kind,
      prelude,
      text: src.slice(start, i),
      start,
      end: i,
    });
  }

  return rules;
}

/** Normalize a rule for ordered comparison: trim, collapse interior whitespace outside strings. */
export function normalizeRuleText(text) {
  return text.replace(/\r\n/g, "\n").trim();
}

export function countDeclarations(ruleText) {
  // Count `;` that end declarations roughly (good enough for before/after).
  // Inside @media/@keyframes, still counts nested decls.
  let count = 0;
  let i = 0;
  const n = ruleText.length;
  let inStr = null;
  let esc = false;
  while (i < n) {
    const ch = ruleText[i];
    if (inStr) {
      if (esc) {
        esc = false;
        i++;
        continue;
      }
      if (ch === "\\") {
        esc = true;
        i++;
        continue;
      }
      if (ch === inStr) inStr = null;
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      inStr = ch;
      i++;
      continue;
    }
    if (ch === "/" && ruleText[i + 1] === "*") {
      const end = ruleText.indexOf("*/", i + 2);
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (ch === ";") count++;
    i++;
  }
  return count;
}

export function selectorKey(prelude) {
  return prelude.replace(/\s+/g, " ").trim();
}
