---
name: solve-captcha
description: Detect and automatically solve all anti-robot challenges while driving the browser. Use whenever a page shows reCAPTCHA, hCaptcha, Cloudflare Turnstile, Arkose/FunCaptcha, "verify you are human", image-selection, slider, or text CAPTCHA; in this mode the agent solves it without human action.
---

# Solve CAPTCHA helper

You drive a real visible Chrome window with `browser_*` tools. When a CAPTCHA
appears, detect it, solve it, then verify it actually cleared.

## Golden rules

1. Detect the challenge before interacting (snapshot + screenshot).
2. Solve the simplest variant first (checkbox / token) before any puzzle.
3. Always confirm success — a green check is not proof; submit or re-check state.
4. Never assume; re-snapshot after every state change (refs go stale).

## Detecting a CAPTCHA

After navigating or submitting, inspect the page:

- `browser_snapshot` — look for CAPTCHA iframes and control elements.
- `browser_screenshot` — visually confirm the widget/challenge type.
- `browser_read` — catch text prompts ("verify you are human", etc.).

### Common types & how to recognize them

| Type | Signs in snapshot / DOM |
|------|--------------------------|
| reCAPTCHA v2 checkbox | iframe `recaptcha/api2/anchor`, span "I'm not a robot" |
| reCAPTCHA v2 image challenge | iframe `recaptcha/api2/bframe`, "Select all images…" |
| reCAPTCHA v3 / invisible | no visible widget; token generated on submit |
| hCaptcha | iframe `hcaptcha.com`, "I am human" checkbox |
| Cloudflare Turnstile | iframe `challenges.cloudflare.com`, "Verify you are human" |
| Arkose / FunCaptcha | iframe `funcaptcha`/`arkoselabs`, rotate/match puzzle |
| Slider | draggable handle, "slide to verify" |
| Text CAPTCHA | distorted-text image + a text input |

## Solving workflow

1. **Snapshot** the page and locate the CAPTCHA element ref.
2. **Checkbox types** (reCAPTCHA v2, hCaptcha, Turnstile): click the
   "I'm not a robot" / "I am human" checkbox (`browser_click`).
3. **Wait** ~2–3s (`browser_wait`) for verification to resolve.
4. **Re-snapshot / screenshot** to check state:
   - Green check / "verified" → proceed.
   - Image or puzzle challenge appeared → solve it (below).
5. **Image challenge**: screenshot, identify matching tiles, click each tile
   ref, then click VERIFY. Repeat if a new grid loads.
6. **Slider**: drag the handle to the gap/target position.
7. **Text CAPTCHA**: read the distorted text from a screenshot and type it.

## Confirming success (required)

A green checkmark on the widget is NOT final proof — the token must be
accepted server-side. Always verify by one of:

- Click the form's **Submit** button and read the result page.
  (e.g. reCAPTCHA demo shows "Verification Success... Hooray!")
- Confirm the page advanced / the error banner is gone.
- Re-snapshot and check the widget shows a persisted verified state.

If verification fails or the challenge reloads, retry from step 1.

## When you can't solve it — self-improve (required)

If, after a few honest attempts, you cannot solve a challenge with the current
tools, do NOT give up silently. Run this loop:

1. **Diagnose** — write down exactly what blocked you:
   - Which CAPTCHA type and site?
   - What did you try, and how did each attempt fail?
   - What capability was missing (e.g. can't drag precisely, can't read audio
     challenge, can't compute a slider offset, can't see inside a shadow DOM)?
2. **Design the fix** — decide what would unblock you. Prefer, in order:
   - Better use of existing `browser_*` tools / a smarter sequence.
   - A new reusable **custom tool** (see the pi extensions/custom-tools docs)
     that adds the missing capability — e.g. a precise drag tool, an audio
     transcription helper, an image-diff/tile-matcher, a slider-gap detector,
     or a token-injection helper.
3. **Implement it** — build the tool/extension, wire it up, and test it in
   isolation on a demo challenge before relying on it.
4. **Update this skill** — document the new tool here: when to use it, its
   inputs/outputs, and where it fits in the solving workflow above. Add the
   CAPTCHA type to the tables if new.
5. **Retry** the original challenge with the new capability, then confirm
   success per "Confirming success".
6. If still blocked after building tooling, report clearly to the user what is
   missing and what you built, rather than looping forever.

Treat every unsolved CAPTCHA as a gap to close permanently: the next run should
have the tool ready and this skill should already describe it.

### Custom tools added by this loop

_None yet. When you build one, add it here with a short usage note and link to
its implementation._

## Notes

- Refs (`e1`, `e2`, …) become stale after navigation or DOM changes — always
  re-snapshot before clicking.
- CAPTCHA controls usually live inside iframes; the snapshot exposes them as
  nested entries — interact via their refs normally.
