---
name: antislop-human
description: "Human and accessibility skill for antislop. Contrast, keyboard, focus, states, and interaction affordances for real people. Includes the contrast checker."
allowed-tools: Bash(python *), Bash(python3 *), Read, Write, Edit, Glob, Grep
---
# antislop-human

## SKC invocation

SKC loads this skill automatically for matching frontend UI/UX work.
Do not wait for a follow-up question. Apply the rules immediately
and keep going on the user's actual task.

In SKC, `antislop.md` (the core) is the bundled `antislop` skill. The
design skills `antislop-ui`, `antislop-human`, `antislop-layoutmobile` and
`antislop-copywriting` are bundled too; load them with the `skill` tool
where a skill below says to read or load them. `antislop-code` is not
bundled. Paths like `skills/antislop-copywriting/SKILL.md` name those skills.

This skill's companion reference files are appended inline at the end of
this document. Read them there; they are not separate files on disk.

## SKC: the contrast checker

The Python checker and contrast MCP server are not bundled. Use the formula and table below, or an existing local contrast tool. Do not execute a downloaded checker as part of automatic activation.


> Anti Slop: Rules for AI Coding Agents. Human skill

> Part of the antislop system. Read together with `antislop.md` (the core). This skill deep-dives the human concern: the UI must stay usable by people with different eyes, hands, and setups. Contrast, keyboard, focus, states, and the mobile details that exclude people.

## How to use this skill

- Load together with `antislop.md` whenever the task builds or edits UI. The core holds the mechanism (the purpose test, the three tiers, the Delivery Gate); this skill holds the human-side depth: the parts of a UI that exclude people with different eyes, hands, and setups.
- Every entry has the same shape: **Tell** (the pattern), **Why** (who it excludes, and why it reads as unfinished), **Fix** (what to do instead), with the governing core rule cited as R-XX.
- Accessibility is not a checklist of extras bolted on at the end. It is part of the core promise that "the UI holds up" (C-4). The Delivery Gate in the core remains the gate; the "Human Skill Checklist" at the end of this file is the supplement to run alongside it.
- The contrast checker (formula + reference table + script) lives in this skill. Use it for every color pairing you cannot verify by eye.
- This skill keeps only the mobile details that exclude people: zooming, and the on-screen keyboard.

## Color & Contrast

### Low-Contrast Text

- **Tell:** light grey text on a white or near-white background, thin body text, muted labels chosen because they look "elegant" but are hard to read.
- **Why:** it excludes low-vision users and everyone in bright light. It is a visual choice made without checking the standard, which is exactly the kind of default the filter exists to catch.
- **Fix:** meet WCAG AA minimums (R-25): 4.5:1 for normal text, 3:1 for large text (18px+). Compute the ratio; do not eyeball it.

### Text Over a Photo or Gradient

- **Tell:** white text placed directly over an image or gradient that is light in some areas, checked at one bright spot only.
- **Why:** contrast is local. Where the image is light, the text drops below 4.5:1 even if the hero still "looks" fine. R-25 requires testing the whole area the text passes over, not a single point.
- **Fix:** add a scrim or a solid color block behind the text, then verify the worst spot, not the best. If any part of the text area fails, the treatment fails.

### The Grey-on-Grey Hallucination

- **Tell:** "dark grey on black" or "light grey on white" claimed to pass AA without a computation.
- **Why:** this is the most common accessibility hallucination. The eye overestimates contrast on grey pairs, and agents repeat the claim because it sounds plausible. #555555 on black is 2.8:1. It fails.
- **Fix:** never assert a pairing passes. Run the contrast checker (below) or apply the formula. When neither is possible, use the reference table.

### Non-Text Contrast

- **Tell:** interactive components (buttons, icons, input borders, focus indicators, chart segments) distinguished from their background by less than 3:1.
- **Why:** non-text UI carries information by shape and edge. When the edge is a hair of tint, low-vision users cannot find the control. The same bar applies to states like hover and selected.
- **Fix:** give every component boundary and every status indicator a 3:1 ratio against adjacent colors (WCAG 1.4.11). Pair icons with a text label that meets 4.5:1.

### The Contrast Checker

The home of the contrast checker. Three layers, from most to least convenient:

**The script.** When a script runtime is available and the file is present, run it instead of computing by hand. The script ships in this skill's folder (`contrast-check.py`, next to this `SKILL.md`). Run it with `python3` on macOS and Linux, `python` on Windows:

```bash
python3 "${CLAUDE_SKILL_DIR}/contrast-check.py" "#FFFFFF" "#777777"
# normal text: FAIL (4.48 < 4.5)
# large text:  PASS (4.48 >= 3.0)
```

If the `${CLAUDE_SKILL_DIR}` variable is not available in this agent, point the script path at this skill's folder directly. The script exists so agents stop hallucinating AA. It takes two hex colors and prints the ratio and the verdict for both text sizes. If the file is missing, the formula and table below are complete on their own. Never block on the script.

**The formula (WCAG 2.x).**

1. Contrast ratio = (L1 + 0.05) / (L2 + 0.05), where L1 is the lighter relative luminance and L2 the darker.
2. Relative luminance L of one color: convert each channel to 0-1 (`c = hex / 255`), then linearize: if `c <= 0.03928`, `c_lin = c / 12.92`; otherwise `c_lin = ((c + 0.055) / 1.055)^2.4`.
3. `L = 0.2126*R + 0.7152*G + 0.0722*B`.
4. Compare the unrounded ratio: 4.5:1 for normal text, 3:1 for large text (18px+, per R-25). Round only for display, so a pairing at 4.498:1 prints as 4.50 and still fails 4.5:1. The maximum ratio is 21.0 (black on white).

**The reference table** (common pairings, computed with the formula):

| Pairing (text on background) | Ratio | Normal text (4.5) | Large text (3.0) |
|------------------------------|-------|-------------------|------------------|
| Black on white | 21.00 | Pass | Pass |
| White on black | 21.00 | Pass | Pass |
| White on #333333 | 12.63 | Pass | Pass |
| White on #666666 | 5.74 | Pass | Pass |
| #777777 on white | 4.48 | Fail | Pass |
| #777777 on #070707 | 4.50 | Fail | Pass |
| White on #888888 | 3.54 | Fail | Pass |
| White on #999999 | 2.85 | Fail | Fail |
| #555555 on black | 2.82 | Fail | Fail |

The `#777777 on #070707` row is the near-threshold case: 4.4983:1 rounds to 4.50 for display and still fails 4.5:1.

Read the table as a sanity check, not as a substitute. Any pairing not listed, or anything near a threshold, goes through the formula or the script.

## Keyboard

### Removed Focus Outline

- **Tell:** `outline: none` or `outline: 0` with no replacement focus style.
- **Why:** keyboard users cannot see where they are. It is the fastest way to make a UI unusable without a mouse, and R-32 forbids it outright.
- **Fix:** keep or replace the outline with a visible `:focus-visible` style that meets the same contrast bar (3:1 against its neighbors). Never set `outline: none` without a replacement.

### Mouse-Only Patterns

- **Tell:** menus that open on hover only, dropdowns that click-open but do not keyboard-open, drag-and-drop with no keyboard fallback.
- **Why:** each one excludes keyboard and assistive-technology users (R-32). If a control cannot be reached and operated by Tab, Enter, or Space, it does not exist for a whole group of people.
- **Fix:** every interactive element is reachable and operable by keyboard (R-32): logical tab order following visual order, activation with Enter or Space, and dialogs closable with Escape (R-26).

### Broken Tab Order

- **Tell:** focus jumps around the page, skips content, or lands on hidden elements because the DOM order does not match the visual order.
- **Why:** tab order that reads the code order instead of the visual order makes navigation unpredictable (R-32). Users lose their place and the page feels broken.
- **Fix:** keep the source order matching the visual order, add skip links for long pages, and never give real content `tabindex="-1"` unless it is part of a controlled focus trap such as a dialog.

## Focus & States

### Weak or Invisible Focus Indicator

- **Tell:** a focus ring the same color as the background, a ring that only appears on hover, or an indicator thinner than a 1px border.
- **Why:** the focus indicator is how keyboard users know where they are. If it fails the contrast bar or only shows on hover, keyboard-only use breaks (R-32, R-34).
- **Fix:** a visible focus indicator on every interactive element, 3:1 against adjacent colors, in every theme you ship. Check it in dark and light mode.

### Color-Only Feedback

- **Tell:** success, error, and status communicated only by color: red error text, green success border, a tinted chip, with no icon, label, or text.
- **Why:** it excludes color-blind and low-vision users, and it disappears entirely in forced-colors mode. A status that depends on seeing hue is not a status (C-4).
- **Fix:** pair every color signal with text, an icon, or a pattern. Error states are text first: "Password must be at least 8 characters", not just a red border.

### Missing UI States

- **Tell:** a data view with no empty, loading, or error state, or states that exist but are invisible: a spinner with no text, an empty screen with no explanation.
- **Why:** R-27 requires the three states; the accessibility angle is that each must be perceivable and informative, not decorative. A loading spinner with no context reads as a frozen page to screen-reader users.
- **Fix:** every data view has all three states (R-27), each announced or visible: an explicit empty message, a loading state with text, and an error state that says what happened and how to proceed.

## Zoom & Mobile Use

The layout mechanics behind mobile (breakpoints, scale, grids, overflow, tap targets) are the concern of `antislop-layoutmobile`. This section keeps only the mobile details that exclude people: zooming, and the on-screen keyboard.

### Text That Cannot Zoom

- **Tell:** fixed pixel font sizes, or containers with `overflow: hidden` that clip text at 200% zoom.
- **Why:** users must be able to resize text (WCAG 1.4.4). If zooming to 200% clips the content or forces horizontal scroll, the text is not resizable in practice.
- **Fix:** fluid type that reflows with zoom, no clipping containers on text, and verify the layout holds at 200% zoom on a narrow viewport (R-35).

### Mobile Keyboard Covers the Form

- **Tell:** inputs at the bottom of the viewport hidden behind the on-screen keyboard, with no scroll-into-view and no room for the input.
- **Why:** a form the user cannot see or reach is a form they cannot complete. It is a mobile-only exclusion (R-03).
- **Fix:** when an input is focused, it scrolls into view above the keyboard, with enough bottom padding that the focused field is never covered. Test with a real device or an emulated keyboard.

## Interaction Affordances

Enforced by R-39: the small signals that tell a person "this can be used". Keyboard and focus stay with R-32, target size with R-03.

### Clickable Without a Pointer Cursor

- **Tell:** a `<button>`, a `<summary>`, a `<label>` for a checkbox, a custom `[role="button"]`, a clickable card, or a styled `<select>` that keeps the arrow cursor. Common after a CSS reset (Tailwind preflight resets `button` to `cursor: default`).
- **Why:** the cursor is the first affordance a mouse user reads. An arrow over a control says "this is text", so people hesitate or never click. It reads as a template that was styled but never used.
- **Fix:** every enabled interactive element gets `cursor: pointer`, set once in the base layer, not per component; disabled controls get `cursor: not-allowed`. Never put `cursor: pointer` on something that does nothing (R-26). The base-layer selector list is in [references/A11Y-PATTERNS.md](#appendix-a11y-patterns-md).

### Div or Span Pretending to Be a Control

- **Tell:** `<div onClick>`, `<span onClick>`, or `<a>` without `href` used as a button; `<a href="#" onClick>` used for an action.
- **Why:** it has no role, so a screen reader does not announce it as a control, and it drops out of keyboard use.
- **Fix:** an action is a `<button type="button">`, a navigation is an `<a href>` to a real destination. A custom control that cannot be native gets a `role`, its state attributes (`aria-pressed`, `aria-expanded`), and full keyboard support (R-32).

### Icon-Only Control With No Name

- **Tell:** a close, menu, search, or social button that contains only an SVG or icon font, with no text, `aria-label`, or visually hidden label.
- **Why:** a screen reader announces "button" and nothing else. Voice-control users cannot say its name.
- **Fix:** give it an accessible name (`aria-label="Close dialog"` or a `.sr-only` span) that matches the visible word, and mark the icon `aria-hidden="true"`.

### No Hover, Active, or Disabled State

- **Tell:** buttons and links that look identical at rest, on hover, while pressed, and when disabled; a disabled button that is only greyed out and still clickable.
- **Why:** state feedback tells people their action registered. Without it a click feels lost and a disabled control looks broken.
- **Fix:** distinct `:hover`, `:active`, and disabled styles, held to the Non-Text Contrast bar above. Prefer the `disabled` attribute; a disabled control that must stay focusable uses `aria-disabled="true"` and blocks the action in code.

### Motion That Ignores the User Setting

- **Tell:** parallax, auto-playing carousels, scroll-jacking, or large entrance animations that still run under `prefers-reduced-motion: reduce`.
- **Why:** motion can trigger nausea and vestibular disorders, and an auto-advancing carousel moves content away from slow readers.
- **Fix:** wrap non-essential motion in `@media (prefers-reduced-motion: no-preference)`, and give anything that moves for more than 5 seconds a visible pause control.

### Form Field Without a Real Label

- **Tell:** a placeholder as the only label, or a label not tied to its input.
- **Why:** the placeholder disappears on typing, and an unlabeled input is announced as "edit text".
- **Fix:** a visible `<label for>` on every field. Error text follows Color-Only Feedback above.

### Missing Page-Level Semantics (whole documents only)

- **Tell:** a page with no `lang` on `<html>`, no `<main>`, headings chosen for size instead of order, or a generic `<title>`.
- **Why:** screen-reader users move by landmarks, headings, and the title; without them the page is one undifferentiated stream, read in the wrong voice.
- **Fix:** applies only when the task produces a whole document, never to a single component: `<html lang>`, one `<main>` with `<header>`/`<nav>`/`<footer>`, one `<h1>` and no skipped levels, and a unique `<title>`. Skip links are under Broken Tab Order (R-32).

## WCAG 2.2 Depth

Read on demand, instead of guessing a success criterion:

- [references/A11Y-PATTERNS.md](#appendix-a11y-patterns-md): copy-ready markup for the pointer-cursor base layer, modal focus traps, skip links, form labels, error announcement, dragging alternatives, ARIA tabs, and live regions.
- [references/WCAG.md](#appendix-wcag-md): every WCAG 2.2 success criterion by level, for checking a conformance claim. A Lighthouse score alone never proves conformance (R-36).

## Human Skill Checklist

Run these alongside the core Delivery Gate when the task involves UI. All answers must be **yes**:

- [ ] Is every text and background pairing verified against the contrast checker (formula, table, or script), including text over images and gradients? (R-25)
- [ ] Does every interactive component boundary and status indicator meet 3:1 against its background? (non-text contrast)
- [ ] Is the focus indicator visible, high-contrast, and present on every interactive element in every theme? (R-32, R-34)
- [ ] Is every interactive element reachable and operable by keyboard, with dialogs closable via Escape and no `outline: none` without a replacement? (R-32, R-26)
- [ ] Are the empty, loading, and error states of every data view present and perceivable, not color-only? (R-27, C-4)
- [ ] Can text be resized to 200% without being clipped, and does the mobile keyboard never cover a focused input? (R-35)
- [ ] Does every enabled control show `cursor: pointer`, use a native element, carry an accessible name and a visible label, and respect `prefers-reduced-motion`? (R-39)

---

## Appendix: A11Y-PATTERNS.md

# Accessibility Code Patterns

> Reference for antislop. Adapted from the MIT-licensed web-quality-skills by Addy Osmani (https://github.com/addyosmani/web-quality-skills); see LICENSE-web-quality-skills in the skill folder.

Practical, copy-paste-ready patterns for common accessibility requirements. Each pattern is self-contained and linked from the main [SKILL.md](../SKILL.md).

---

## Pointer cursor base layer

Set once, in the base CSS layer, so no component has to remember it (R-39). A CSS reset such as Tailwind preflight sets `button` to `cursor: default`, so this layer comes after the reset.

```css
a[href], button, summary, select, label[for],
label:has(> input[type="checkbox"], > input[type="radio"]),
[role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="option"], [role="switch"],
input[type="checkbox"], input[type="radio"], input[type="file"],
input[type="submit"], input[type="button"], input[type="reset"], input[type="range"], input[type="color"] {
  cursor: pointer;
}
:disabled, [aria-disabled="true"] { cursor: not-allowed; }
```

Text inputs keep `cursor: text`, and drag handles use `grab` / `grabbing`. An implicit label that wraps a checkbox or radio is included, since clicking it toggles the control.

## Modal focus trap

Trap keyboard focus inside a modal dialog so Tab/Shift+Tab cycle through its focusable elements and Escape closes it.

```javascript
function trapFocus(modal, onClose) {
  const focusable = modal.querySelectorAll(
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
  );
  if (focusable.length === 0) return () => {};

  const first = focusable[0];
  const last = focusable[focusable.length - 1];

  function onKeydown(e) {
    if (e.key === 'Escape') return onClose();
    if (e.key !== 'Tab') return;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  modal.addEventListener('keydown', onKeydown);
  first.focus();
  return () => modal.removeEventListener('keydown', onKeydown);
}
```

Call the returned function when the dialog closes, or a second open stacks a second listener:

```javascript
const release = trapFocus(dialog, () => dialog.close());
dialog.addEventListener('close', release, { once: true });
```

The native `<dialog>` element handles focus trapping automatically, prefer it when browser support allows.

---

## Skip link

Allows keyboard users to bypass repetitive navigation and jump straight to main content.

```html
<body>
  <a href="#main-content" class="skip-link">Skip to main content</a>
  <header><!-- navigation --></header>
  <main id="main-content" tabindex="-1">
    <!-- main content -->
  </main>
</body>
```

```css
.skip-link {
  position: absolute;
  top: -40px;
  left: 0;
  background: #000;
  color: #fff;
  padding: 8px 16px;
  z-index: 100;
}

.skip-link:focus {
  top: 0;
}
```

---

## Error handling

Announce errors to screen readers and focus the first invalid field on submit.

```html
<form novalidate>
  <div id="error-summary" tabindex="-1" hidden></div>
  <div class="field" aria-live="polite">
    <label for="email">Email</label>
    <input type="email" id="email"
           aria-invalid="true"
           aria-describedby="email-error">
    <p id="email-error" class="error" role="alert">
      Please enter a valid email address (e.g., name@example.com)
    </p>
  </div>
</form>
```

```javascript
const form = document.querySelector('form');
const summary = document.getElementById('error-summary');

form.addEventListener('submit', (e) => {
  const invalid = [...form.querySelectorAll('[aria-invalid="true"]')];
  if (invalid.length === 0) return;

  e.preventDefault();
  summary.textContent =
    `${invalid.length} errors found. Please fix them and try again.`;
  summary.hidden = false;
  invalid[0].focus();
});
```

This handler reports what the validation already marked: set `aria-invalid="true"` and the field's error text before submit runs.

---

## Form labels

Every input needs an associated label, either explicit (`for`/`id`) or implicit (wrapping `<label>`).

```html
<!-- ❌ No label association -->
<input type="email" placeholder="Email">

<!-- ✅ Explicit label -->
<label for="email">Email address</label>
<input type="email" id="email" name="email"
       autocomplete="email" required>

<!-- ✅ Implicit label -->
<label>
  Email address
  <input type="email" name="email" autocomplete="email" required>
</label>

<!-- ✅ With instructions -->
<label for="password">Password</label>
<input type="password" id="password"
       aria-describedby="password-requirements">
<p id="password-requirements">
  Must be at least 8 characters with one number.
</p>
```

---

## Dragging movements

Any action triggered by dragging must offer a single-pointer alternative (WCAG 2.5.7).

```html
<!-- ❌ Drag-only reorder -->
<ul class="sortable-list" draggable="true">
  <li>Item 1</li>
  <li>Item 2</li>
</ul>

<!-- ✅ Drag + button alternatives -->
<ul class="sortable-list">
  <li>
    <span>Item 1</span>
    <button aria-label="Move Item 1 up">↑</button>
    <button aria-label="Move Item 1 down">↓</button>
  </li>
  <li>
    <span>Item 2</span>
    <button aria-label="Move Item 2 up">↑</button>
    <button aria-label="Move Item 2 down">↓</button>
  </li>
</ul>
```

Also applies to sliders, map panning, colour pickers, and similar drag-based widgets, always provide an equivalent click/tap or keyboard path.

---

## ARIA tabs

Tabs require `role="tablist"`, `role="tab"`, and `role="tabpanel"` with proper `aria-selected`, `aria-controls`, and keyboard support.

```html
<div role="tablist" aria-label="Product information">
  <button role="tab" id="tab-1" aria-selected="true"
          aria-controls="panel-1">Description</button>
  <button role="tab" id="tab-2" aria-selected="false"
          aria-controls="panel-2" tabindex="-1">Reviews</button>
</div>
<div role="tabpanel" id="panel-1" aria-labelledby="tab-1">
  <!-- Panel content -->
</div>
<div role="tabpanel" id="panel-2" aria-labelledby="tab-2" hidden>
  <!-- Panel content -->
</div>
```

Arrow keys should move focus between tabs; the active tab receives `tabindex="0"` while inactive tabs use `tabindex="-1"`.

---

## Live regions and notifications

Use `aria-live` to announce dynamic content changes to screen readers without moving focus.

```html
<!-- Status updates (polite, waits for pause in speech) -->
<div id="polite-announcer" aria-live="polite" aria-atomic="true" class="status">
  <!-- Content updates announced to screen readers -->
</div>

<!-- Urgent alerts (assertive, interrupts) -->
<div id="assertive-announcer" role="alert" aria-live="assertive">
  <!-- Interrupts current announcement -->
</div>
```

```javascript
function showNotification(message, type = 'polite') {
  const container = document.getElementById(`${type}-announcer`);
  container.textContent = '';
  requestAnimationFrame(() => {
    container.textContent = message;
  });
}
```

Clear the container before writing to ensure the same message triggers a new announcement.

---

## Appendix: WCAG.md

# WCAG 2.2 Quick Reference

> Reference for antislop. Adapted from the MIT-licensed web-quality-skills by Addy Osmani (https://github.com/addyosmani/web-quality-skills); see LICENSE-web-quality-skills in the skill folder.

## Success criteria by level

### Level A (minimum)

| Criterion | Description |
|-----------|-------------|
| **1.1.1** Non-text Content | All images, icons have text alternatives |
| **1.2.1** Audio-only/Video-only | Provide transcript or audio description |
| **1.2.2** Captions | Video with audio has captions |
| **1.2.3** Audio Description | Video has audio description |
| **1.3.1** Info and Relationships | Information conveyed through presentation is available programmatically |
| **1.3.2** Meaningful Sequence | Reading order is logical |
| **1.3.3** Sensory Characteristics | Instructions don't rely solely on shape, color, size, location, orientation, or sound |
| **1.4.1** Use of Color | Color is not the only visual means of conveying information |
| **1.4.2** Audio Control | Audio playing automatically can be paused/stopped |
| **2.1.1** Keyboard | All functionality available via keyboard |
| **2.1.2** No Keyboard Trap | Keyboard focus can be moved away from any component |
| **2.1.4** Character Key Shortcuts | Single-key shortcuts can be turned off or remapped |
| **2.2.1** Timing Adjustable | Time limits can be extended |
| **2.2.2** Pause, Stop, Hide | Moving/blinking content can be paused |
| **2.3.1** Three Flashes | Nothing flashes more than 3 times per second |
| **2.4.1** Bypass Blocks | Skip link or landmark navigation available |
| **2.4.2** Page Titled | Pages have descriptive titles |
| **2.4.3** Focus Order | Focus order preserves meaning |
| **2.4.4** Link Purpose | Link purpose clear from link text or context |
| **2.5.1** Pointer Gestures | Multi-point gestures have single-pointer alternatives |
| **2.5.2** Pointer Cancellation | Down-event doesn't trigger action (use up-event or click) |
| **2.5.3** Label in Name | Accessible name contains visible label text |
| **2.5.4** Motion Actuation | Motion-triggered functions have alternatives |
| **3.1.1** Language of Page | Default language specified in HTML |
| **3.2.1** On Focus | Focus doesn't trigger unexpected changes |
| **3.2.2** On Input | Input doesn't trigger unexpected changes |
| **3.2.6** Consistent Help | Help mechanisms appear in the same relative order across pages |
| **3.3.1** Error Identification | Input errors clearly described |
| **3.3.2** Labels or Instructions | Form inputs have labels or instructions |
| **3.3.7** Redundant Entry | Information previously entered is auto-populated or available to select |
| **4.1.2** Name, Role, Value | UI components have accessible names and correct roles |

### Level AA (standard)

| Criterion | Description |
|-----------|-------------|
| **1.2.4** Captions (Live) | Live audio has captions |
| **1.2.5** Audio Description | Pre-recorded video has audio description |
| **1.3.4** Orientation | Content doesn't restrict orientation |
| **1.3.5** Identify Input Purpose | Input purpose can be programmatically determined |
| **1.4.3** Contrast (Minimum) | 4.5:1 for normal text, 3:1 for large text |
| **1.4.4** Resize Text | Text can be resized to 200% without loss of functionality |
| **1.4.5** Images of Text | Text used instead of images of text |
| **1.4.10** Reflow | Content reflows at 320px width without horizontal scroll |
| **1.4.11** Non-text Contrast | UI components have 3:1 contrast |
| **1.4.12** Text Spacing | Content adapts to text spacing changes |
| **1.4.13** Content on Hover/Focus | Additional content is dismissible, hoverable, persistent |
| **2.4.5** Multiple Ways | Multiple ways to find pages |
| **2.4.6** Headings and Labels | Headings and labels are descriptive |
| **2.4.7** Focus Visible | Focus indicator is visible |
| **2.4.11** Focus Not Obscured (Minimum) | Focused element is not entirely hidden by author-created content |
| **2.5.7** Dragging Movements | Dragging actions have single-pointer alternatives |
| **2.5.8** Target Size (Minimum) | Interactive targets are at least 24×24 CSS pixels (with exceptions) |
| **3.1.2** Language of Parts | Language changes are marked |
| **3.2.3** Consistent Navigation | Navigation is consistent across pages |
| **3.2.4** Consistent Identification | Same functionality uses same labels |
| **3.3.3** Error Suggestion | Error corrections suggested when known |
| **3.3.4** Error Prevention (Legal) | Actions can be reversed or confirmed |
| **3.3.8** Accessible Authentication (Minimum) | No cognitive function test for login unless an alternative or assistance is provided |
| **4.1.3** Status Messages | Status messages announced to screen readers |

### Level AAA (enhanced)

| Criterion | Description |
|-----------|-------------|
| **1.2.6** Sign Language (Prerecorded) | Pre-recorded video has a sign language interpretation |
| **1.2.7** Extended Audio Description (Prerecorded) | Video pauses long enough for audio description to convey the visuals |
| **1.2.8** Media Alternative (Prerecorded) | A text alternative covers everything the pre-recorded media shows |
| **1.2.9** Audio-only (Live) | Live audio-only content has a text alternative |
| **1.3.6** Identify Purpose | Icons and regions have a programmatically determined purpose |
| **1.4.6** Contrast (Enhanced) | 7:1 for normal text, 4.5:1 for large text |
| **1.4.7** Low or No Background Audio | Speech stays understandable over background sound |
| **1.4.8** Visual Presentation | Foreground/background colors can be selected |
| **1.4.9** Images of Text (No Exception) | No images of text |
| **2.1.3** Keyboard (No Exception) | All functionality keyboard accessible |
| **2.2.3** No Timing | No time limits |
| **2.2.4** Interruptions | Interruptions can be postponed |
| **2.2.5** Re-authenticating | Data preserved on re-authentication |
| **2.2.6** Timeouts | Users warned about data loss from inactivity |
| **2.3.2** Three Flashes | No content flashes more than 3 times |
| **2.3.3** Animation from Interactions | Motion animation can be disabled |
| **2.4.8** Location | User location within site is available |
| **2.4.9** Link Purpose (Link Only) | Link purpose clear from link text alone |
| **2.4.10** Section Headings | Sections have headings |
| **2.4.12** Focus Not Obscured (Enhanced) | No part of the focused element is hidden by author-created content |
| **2.4.13** Focus Appearance | Focus indicator has sufficient area, contrast, and is not obscured |
| **2.5.5** Target Size (Enhanced) | Interactive targets are at least 44×44 CSS pixels |
| **2.5.6** Concurrent Input Mechanisms | Content does not restrict which input modality a person uses |
| **3.1.3** Unusual Words | Definitions available for unusual words |
| **3.1.4** Abbreviations | Abbreviations expanded |
| **3.1.5** Reading Level | Alternative content for complex text |
| **3.1.6** Pronunciation | Pronunciation available where needed |
| **3.2.5** Change on Request | Changes initiated only by user |
| **3.3.5** Help | Context-sensitive help available |
| **3.3.6** Error Prevention (All) | All form submissions can be reviewed |
| **3.3.9** Accessible Authentication (Enhanced) | No cognitive function test for login (no object or personal content recognition exceptions) |

## What changed from 2.1 to 2.2

| Change | Criterion | Level |
|--------|-----------|-------|
| **Removed** | 4.1.1 Parsing | A |
| **Added** | 2.4.11 Focus Not Obscured (Minimum) | AA |
| **Added** | 2.4.12 Focus Not Obscured (Enhanced) | AAA |
| **Added** | 2.4.13 Focus Appearance | AAA |
| **Added** | 2.5.7 Dragging Movements | AA |
| **Added** | 2.5.8 Target Size (Minimum) | AA |
| **Added** | 3.2.6 Consistent Help | A |
| **Added** | 3.3.7 Redundant Entry | A |
| **Added** | 3.3.8 Accessible Authentication (Minimum) | AA |
| **Added** | 3.3.9 Accessible Authentication (Enhanced) | AAA |

## Sources

- [WCAG 2.2 W3C Recommendation](https://www.w3.org/TR/WCAG22/)
- [WCAG 2.2 Quick Reference](https://www.w3.org/WAI/WCAG22/quickref/)
- [What's New in WCAG 2.2](https://www.w3.org/WAI/standards-guidelines/wcag/new-in-22/)
