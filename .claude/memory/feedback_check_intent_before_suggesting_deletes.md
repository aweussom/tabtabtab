---
name: feedback-check-intent-before-suggesting-deletes
description: "When proposing to delete files, connect the dots — say what replaced them or why they exist — instead of stopping at \"unreferenced\". Bare \"not used, delete\" reads as dismissive and stalls the user."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 6ab1d93c-cd84-461f-8427-dac2793dd62b
---

When you spot deletion candidates (untracked dupes, leftover scratch files, etc.), don't stop at "they're not referenced." Connect the dots in the recommendation:

- If the file looks like a source/raw version of something committed elsewhere, say so: "these look like the originals of `docs/screenshots/0X-*.png` — those are committed and referenced in README, so the originals can go."
- If there are several candidates that share a pattern, point at the pattern.
- Make it easy for the user to verify and say "yes" — not just "trust me."

**Why:** On 2026-05-15 a previous Claude session correctly identified that the `*Skjermbilde*.png` files at repo root were unused. The user reflexively pushed back ("they're used in README") because the recommendation didn't surface that `docs/screenshots/0X-*.png` were the *cleaned, committed* versions the README actually references. Both the user and a later Claude session re-investigated before realizing the original recommendation was correct. The verdict was right; the framing failed to land it.

**How to apply:** Before recommending deletion, do the 30-second check:
1. Glob for siblings/look-alikes by naming pattern.
2. If a "cleaned" version exists elsewhere (committed, different path, sane name), include that in the recommendation.
3. Phrase as a hypothesis the user can confirm, not a verdict.

"Unused = delete" is a literally-correct sentence that can still waste a back-and-forth. Always include the *why these specific ones* part.
