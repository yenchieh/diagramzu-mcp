// Card 164 — the PURE text layer of the page tools. No HTTP, no clock, no
// client: every rule here is a function of its arguments, which is why
// apps/web/tests/unit/mcpPageText.test.ts is the primary gate for it and the
// tool tests only prove the wiring.
//
// WHY ANY OF THIS LIVES IN THE PACKAGE. go-api serves a page as one string;
// `outline` and `section` are views OF that string, and computing them here
// costs one GET instead of a new endpoint per view. The rules below are a PORT
// of services/go-api/internal/handlers/pagetext.go (card 162) and have to stay
// one: the TITLE an agent reads comes from the server's rules, so an outline
// computed by different rules would name sections the page does not have.
// Each ported rule says which Go function it mirrors.

/** One heading in a page's outline. */
export interface PageHeading {
  /** 1–6, from the number of leading `#`. */
  level: number;
  /** The heading text, with any ATX closing sequence stripped. */
  text: string
  /** A slug unique within the page: how `section` addresses this heading. */
  anchor: string;
  /** 0-based index of the heading's line in the normalised body. */
  line: number;
}

export interface PageEdit {
  oldText: string;
  newText: string;
}

/**
 * The result of applying an `edits` list.
 *
 * `reason` rather than a magic count, because "your oldText was empty" and
 * "your oldText matched twice" are different mistakes and an agent that is told
 * the wrong one fixes the wrong thing.
 */
export type EditResult =
  | { ok: true; text: string }
  | { ok: false; index: number; reason: "empty" }
  | { ok: false; index: number; reason: "noop" }
  | { ok: false; index: number; reason: "count"; count: number };

export type SectionResult =
  | { ok: true; heading: PageHeading; text: string }
  | { ok: false; reason: "unknown" | "ambiguous"; headings: PageHeading[] };

// ── normalisation ───────────────────────────────────────────────────────────

/**
 * The SAME normalisation go-api applies before storing, comparing and counting
 * (`normalizePageBody`): line endings collapse to LF, then NFC.
 *
 * It matters on BOTH sides of a match. The stored body is already LF+NFC, but
 * an `oldText` an agent produces may be neither — a span copied out of a
 * Windows editor, or macOS's decomposed "é" — and matching it literally would
 * report a baffling "0 matches" for text the human can see on the page.
 */
export function normalizePageText(s: string): string {
  let out = s;
  if (out.includes("\r")) out = out.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return out.normalize("NFC");
}

// ── structure (ported from pagetext.go) ─────────────────────────────────────

/** `^ {0,3}(#{1,6})[ \t]+(.*)$` — CommonMark ATX. Mirrors go's atxH1Re, widened to all six levels. */
const ATX_RE = /^ {0,3}(#{1,6})[ \t]+(.*)$/;
/** Mirrors go's fenceRe: up to three spaces, then three or more backticks or tildes. */
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
/** Mirrors go's atxClosingRe: a trailing run of `#` is not part of the text. */
const ATX_CLOSING_RE = /[ \t]+#+[ \t]*$/;

/**
 * Where the body proper starts, skipping a LEADING YAML front-matter block.
 *
 * Mirrors go's parseFrontMatter: "leading" means `---\n` at index 0; the block
 * ends at the first line that is exactly `---` or `...`; an UNTERMINATED block
 * is NOT front matter at all (a document that opens with a thematic break must
 * not have its whole text swallowed), in which case this returns 0.
 */
function frontMatterEnd(body: string): number {
  if (!body.startsWith("---\n")) return 0;
  const lines = body.split("\n");
  let consumed = lines[0]!.length + 1;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    const terminated = i < lines.length - 1;
    consumed += line.length + (terminated ? 1 : 0);
    if (line.replace(/[ \t]+$/, "") === "---" || line.replace(/[ \t]+$/, "") === "...") {
      return consumed;
    }
    if (!terminated) return 0; // ran off the end with no closing marker
  }
  return 0;
}

/**
 * A GitHub-style anchor, deduped by the caller.
 *
 * HAN AND KANA ARE KEPT. Stripping everything non-ASCII would give every CJK
 * heading an empty anchor, which is the one thing that must not happen: the
 * anchor is how an agent asks for a section back, and this product's pages are
 * written in four languages.
 *
 * NOTE, and it is a real one: card 163 computes anchors for the reader's [TOC]
 * in parallel with this card and the two were written without seeing each
 * other. They may differ. Nothing breaks if they do — `section` also matches a
 * heading's TEXT, which is what an agent naturally has — but reconciling them
 * is a follow-up, and until then an anchor printed here is this server's own.
 */
function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, "")
    .trim()
    .replace(/\s+/g, "-");
  return slug === "" ? "section" : slug;
}

/** Every heading in the body, outside front matter and outside fenced code. */
export function pageOutline(body: string): PageHeading[] {
  const normalised = normalizePageText(body);
  const start = frontMatterEnd(normalised);
  const lines = normalised.slice(start).split("\n");
  const skippedLines = start === 0 ? 0 : normalised.slice(0, start).split("\n").length - 1;

  const out: PageHeading[] = [];
  // FOLD 1, S3 — `taken` is the set of anchors ALREADY EMITTED, and the
  // candidate is tested against it rather than against a per-base counter.
  // With a counter, headings `foo`, `foo`, `foo-1` produced `foo`, `foo-1`,
  // `foo-1` — a duplicate, which breaks the uniqueness this type promises and
  // makes `section` unable to address the second one. GitHub's slugger does the
  // same walk, and gives `foo`, `foo-1`, `foo-1-1`.
  const nextIndex = new Map<string, number>();
  const taken = new Set<string>();
  // Fences are tracked by their opener's CHARACTER and LENGTH: a ``` block
  // closes on ``` or longer, never on ~~~ (go's firstATXH1, verbatim).
  let fenceChar = "";
  let fenceLen = 0;

  lines.forEach((line, i) => {
    const fence = FENCE_RE.exec(line);
    if (fence) {
      const marker = fence[1]!;
      if (fenceLen === 0) {
        fenceChar = marker[0]!;
        fenceLen = marker.length;
      } else if (marker[0] === fenceChar && marker.length >= fenceLen) {
        fenceChar = "";
        fenceLen = 0;
      }
      return;
    }
    if (fenceLen !== 0) return;
    const m = ATX_RE.exec(line);
    if (!m) return;
    const text = m[2]!.replace(ATX_CLOSING_RE, "").trim();
    if (text === "") return;
    const base = slugify(text);
    let n = nextIndex.get(base) ?? 0;
    let anchor = n === 0 ? base : `${base}-${n}`;
    while (taken.has(anchor)) {
      n++;
      anchor = `${base}-${n}`;
    }
    nextIndex.set(base, n + 1);
    taken.add(anchor);
    out.push({ level: m[1]!.length, text, anchor, line: skippedLines + i });
  });
  return out;
}

/**
 * One section: its heading line through the line before the next heading of the
 * SAME OR A HIGHER level. Sub-headings therefore belong to their parent.
 *
 * `selector` is a heading's exact text (case-insensitively), or its anchor. An
 * anchor is unique by construction; a TEXT that matches more than one heading is
 * REFUSED rather than resolved to the first — guessing which "Rollout" the agent
 * meant is how an edit lands in the wrong half of a document.
 */
export function pageSection(body: string, selector: string): SectionResult {
  const normalised = normalizePageText(body);
  const headings = pageOutline(normalised);
  const want = selector.trim();
  const wantLower = want.toLowerCase();

  // The ANCHOR match is case-SENSITIVE, and that is what keeps the ambiguity
  // rule working. Anchors are generated lowercase, so an agent that passes one
  // passes it verbatim; matching case-insensitively made the heading TEXT
  // "Rollout" collide with the first duplicate's anchor "rollout" and resolved
  // silently to it, instead of refusing a name that fits two headings.
  const byAnchor = headings.filter((h) => h.anchor === want);
  const byText = headings.filter((h) => h.text.toLowerCase() === wantLower);
  const matches = byAnchor.length > 0 ? byAnchor : byText;

  if (matches.length === 0) return { ok: false, reason: "unknown", headings };
  if (matches.length > 1) return { ok: false, reason: "ambiguous", headings: matches };

  const heading = matches[0]!;
  const lines = normalised.split("\n");
  const next = headings.find((h) => h.line > heading.line && h.level <= heading.level);
  const end = next ? next.line : lines.length;
  return { ok: true, heading, text: lines.slice(heading.line, end).join("\n").replace(/\n+$/, "\n") };
}

// ── the `edits` engine (D1(b)) ──────────────────────────────────────────────

/**
 * Count occurrences of `needle`, counting OVERLAPPING ones.
 *
 * Overlapping on purpose: "aa" occurs twice in "aaa" by this count, and twice
 * means AMBIGUOUS, which means refused. The non-overlapping count would be 1
 * and would pick a span the agent did not unambiguously name — the opposite of
 * what this rule is for.
 */
function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + 1)) count++;
  return count;
}

/**
 * Apply every edit IN ORDER, each against the text the previous one produced.
 *
 * THE RULE, and the whole reason this function exists: each `oldText` must
 * match EXACTLY ONCE. Zero means the agent is editing text that is not there;
 * more than one means it has not said which occurrence it meant. Both are
 * refusals, and a refusal writes NOTHING — not the edits that did match, not a
 * partial body. A "best effort" apply here is a silent data loss with a
 * cheerful success message on top.
 *
 * Order is load-bearing and tested: edit 2 may legitimately match text edit 1
 * produced, which is how an agent rewrites a span and then refines it.
 */
export function applyPageEdits(body: string, edits: PageEdit[]): EditResult {
  let text = normalizePageText(body);
  for (let i = 0; i < edits.length; i++) {
    const oldText = normalizePageText(edits[i]!.oldText);
    const newText = normalizePageText(edits[i]!.newText);
    if (oldText === "") return { ok: false, index: i, reason: "empty" };
    // FOLD 1, R3a — an edit whose newText EQUALS its oldText changes nothing,
    // but the PATCH it produced still bumped the page's revision, moved
    // `updated_by` to the agent and could trigger an auto snapshot. "I changed
    // nothing" and "I wrote a new revision that is identical" are different
    // facts, and the second one invalidates every baseRevision a human editor
    // is holding. Compared AFTER normalisation, so a CRLF-vs-LF pair is still a
    // no-op.
    if (oldText === newText) return { ok: false, index: i, reason: "noop" };
    const count = countOccurrences(text, oldText);
    if (count !== 1) return { ok: false, index: i, reason: "count", count };
    const at = text.indexOf(oldText);
    // Spliced by INDEX, never String.replace: a `$&` or `$1` in newText would
    // otherwise be interpreted as a replacement pattern and silently rewrite
    // the agent's text.
    text = text.slice(0, at) + newText + text.slice(at + oldText.length);
  }
  return { ok: true, text };
}
