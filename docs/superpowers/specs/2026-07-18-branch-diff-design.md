# Branch Diff View — Design Spec

**Date:** 2026-07-18
**Status:** Approved
**Sub-project:** 2 of 4 (demo mode → **branch diff** → time-travel replay → live capture stream)

## Goal

"Git diff for LLM outputs." Select any two captured nodes and see, side by
side, what changed in the prompt and what changed in the response — with
word-level highlighting — plus a token comparison. Turns eyeball-scrolling
across two branches into a single readable view.

## Behavior

### Selection

- NodePanel gains a **⇄ Compare** button next to **Fork from here**.
- Clicking it enters compare mode: a banner appears over the canvas —
  "Comparing from `<id>` — click another node" — with a Cancel button.
- Clicking any other node opens the compare modal for (first, second).
- Clicking the same node, pressing Escape, or Cancel exits compare mode.

### Compare modal

Full-screen modal, two columns (A = first selected, B = second):

- **Column headers:** node id, model badge, upstream, timestamp.
- **Prompt delta:** the last `user` message from each side's request,
  rendered as a word-level diff (removals struck-through red, additions
  green). This is "what you changed when you forked."
- **Response diff:** the assistant text of each response, word-level diff
  with the same color convention.
- **Tokens:** table of prompt / completion / total for A and B plus a
  delta column (B − A, signed).

### Diff engine — `dashboard/src/lib/diff.js`

- Word-level LCS diff. Pure ESM, zero new dependencies.
- Exported as `wordDiff(a, b)` → array of `{ type: 'same'|'add'|'del',
  text }` segments (whitespace preserved between words).
- Lives in the dashboard because Vite serves source as ESM only (CJS source
  is unsupported in dev). Root jest tests the exact shipped file by
  stripping `export` keywords and evaluating it — one implementation,
  tested as shipped.
- Guard: if either side exceeds 3000 words, return null — the modal then
  renders plain side-by-side text without highlighting (avoids O(n·m) DP
  blowup on giant outputs).
- Usefulness guard (CompareView): when less than 15% of the diffed text is
  common, render plain side-by-side instead — a pane that is one solid
  highlight explains less than plain text.

### Server changes

None. The dashboard already holds full node data from `/api/graph`.

## Error handling

- Nodes with no assistant text (pure tool-call turns) render the tool-call
  JSON as plain text on that side; diff still runs over the extracted text.
- Missing usage on either side → token row shows "—" and no delta.

## Testing

- **Jest (`tests/diff.test.js`):** identical inputs → single `same` segment;
  pure insertion; pure deletion; replacement; empty sides; >3000-word input
  returns null; whitespace/newline preservation.
- **Playwright manual pass:** run `forkmind demo`, compare the wrong-fix
  leaf vs the winning leaf, verify highlights and token deltas, screenshot.

## Out of scope

- Cost estimation (price tables rot).
- Latency comparison (not in the capture schema).
- Comparing whole branches / multi-node lineages (this compares two nodes).
- Character-level (intra-word) diff refinement.
