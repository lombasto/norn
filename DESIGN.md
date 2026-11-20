---
name: Norn
description: The dashboard for one owner's local agent lanes and runs. Live, records-backed, two looks (norn and classic), light and dark.
colors:
  norn-night-bg: "#0b0e1a"
  norn-night-panel: "#151c30"
  norn-night-soft: "#1f2b45"
  norn-night-line: "#2e3f5f"
  norn-night-ink: "#d3e2ec"
  norn-night-mute: "#93aec6"
  norn-night-accent: "#9eecc9"
  norn-night-accent-bg: "#0e2b30"
  norn-night-ok: "#94b44c"
  norn-night-run: "#93aec6"
  norn-night-warn: "#eec24a"
  norn-night-bad: "#e2683f"
  norn-night-codex: "#a0569a"
  norn-night-gold: "#eec24a"
  norn-day-bg: "#e9dcbc"
  norn-day-panel: "#f7f0dc"
  norn-day-line: "#c9b48c"
  norn-day-ink: "#241a14"
  norn-day-mute: "#433021"
  norn-day-accent: "#17504f"
  norn-day-accent-bg: "#9eecc9"
  norn-day-ok: "#34431c"
  norn-day-run: "#2e3f5f"
  norn-day-warn: "#6e430f"
  norn-day-warn-bg: "#fff0a8"
  norn-day-bad: "#a5302e"
  classic-light-bg: "#f6f7f9"
  classic-light-panel: "#ffffff"
  classic-light-soft: "#eef1f4"
  classic-light-line: "#e3e6ea"
  classic-light-ink: "#1b1f24"
  classic-light-mute: "#5d6672"
  classic-light-accent: "#0e7490"
  classic-light-accent-bg: "#e0f5f9"
  classic-light-ok: "#166534"
  classic-light-run: "#1d4ed8"
  classic-light-warn: "#854d0e"
  classic-light-bad: "#b91c1c"
  classic-light-codex: "#6d28d9"
  classic-dark-bg: "#121417"
  classic-dark-panel: "#1a1d21"
  classic-dark-soft: "#22262b"
  classic-dark-line: "#2b3036"
  classic-dark-ink: "#e6e8eb"
  classic-dark-mute: "#9aa3ad"
  classic-dark-accent: "#22d3ee"
  classic-dark-ok: "#4ade80"
  classic-dark-run: "#7aa2ff"
  classic-dark-warn: "#facc15"
  classic-dark-bad: "#f87171"
  classic-dark-codex: "#b794f6"
typography:
  body:
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "14px"
    lineHeight: 1.45
    fontFeature: "tnum"
  small:
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "12px"
  mono:
    fontFamily: "ui-monospace, Consolas, monospace"
    fontSize: "12.5px"
  title:
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "15px"
    fontWeight: 650
  label:
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "12px"
    letterSpacing: "0.06em"
  number:
    fontFamily: "ui-monospace, Consolas, monospace"
    fontSize: "22px"
    fontWeight: 700
  pixel-heading:
    fontFamily: "Silkscreen, ui-monospace, monospace"
    fontSize: "16px"
    fontWeight: 400
    letterSpacing: "0em"
rounded:
  control: "6px"
  banner: "8px"
  card: "10px"
  chip: "10px"
  norn: "0px"
spacing:
  hair: "2px"
  xs: "4px"
  sm: "6px"
  md: "8px"
  lg: "10px"
  xl: "14px"
  page-y: "18px"
  page-x: "20px"
  norn-art-px: "2px"
components:
  button:
    backgroundColor: "{colors.classic-light-soft}"
    textColor: "{colors.classic-light-ink}"
    rounded: "{rounded.control}"
    padding: "4px 10px"
  button-primary:
    backgroundColor: "{colors.classic-light-accent}"
    textColor: "{colors.classic-light-panel}"
    rounded: "{rounded.control}"
    padding: "4px 10px"
  filter-chip-on:
    backgroundColor: "{colors.classic-light-panel}"
    textColor: "{colors.classic-light-run}"
    rounded: "{rounded.control}"
    padding: "3px 10px"
  chip-needs:
    backgroundColor: "{colors.classic-light-accent-bg}"
    textColor: "{colors.classic-light-accent}"
    rounded: "{rounded.chip}"
    padding: "1px 8px"
  card:
    backgroundColor: "{colors.classic-light-panel}"
    rounded: "{rounded.card}"
    padding: "14px 16px"
  nav-tab-selected:
    textColor: "{colors.classic-light-ink}"
    padding: "9px 12px"
  norn-card:
    backgroundColor: "{colors.norn-night-panel}"
    rounded: "{rounded.norn}"
    padding: "4px 8px"
  norn-nav-tab-selected:
    backgroundColor: "{colors.norn-night-accent}"
    textColor: "{colors.norn-night-bg}"
    rounded: "{rounded.norn}"
---

# Design System: Norn

<!-- Documented from the code as it is (engine/dash/index.html <style>, engine/dash/norn/norn.css, norn/assets.mjs,
     norn/palette.hex) before the Lanes / Runs redesign. The CSS is normative; this file describes it. Written headless:
     the North Star and the colour names are inferred from the product's own vocabulary, not chosen in an interview. -->

## Overview

**Creative North Star: "Threads and Beads"**

The Norns spin each life as a thread, and Norn shows work the same way. A lane is a thread and a run is a bead on it. The
three Norns stand for time: Urd is what was, Verdandi is what is, Skuld is what shall be. The dashboard is an operator's
console for one person watching many threads at once. It is dense, tabular and live. Numbers line up in tabular figures and
always carry units. Every status is a shape and a word as well as a colour.

There are two looks over one structure. **norn** (the default) is a pixel kit. Every colour comes from one locked 32-colour
palette. Panels are 9-slice frames at a whole-pixel art scale, headings are set in the Silkscreen pixel face, and seven state
tokens are drawn as pixel art. It has a night ground and a day ground. **classic** is a plain system-UI look with soft grey
panels, 10 px corners and one cyan accent, in light and dark. The look changes only the frame and the style. Ids, words, URLs
and layout are the same in both.

The surface is calm. Nothing moves on a timer. The state stream redraws only what changed. Motion lives only under
`:root.norn.motion`, which is set only when there is no quiet hold, no reduced-motion preference, and the page is visible.

**Key Characteristics:**
- Dense tables and trees, tabular numerals, numbers with units, UTC times with a `Z`.
- One accent colour, used only for "needs you". It is never the "bad" colour.
- Status = universal shape + word + colour. The seven tokens are running (play), done (check), handoff (arrows),
  stopped (stop), parked (pause), needs you (!) and idle (ring).
- Both looks and both grounds are first-class. Every chip passes WCAG AA in all four.
- Phone first-class: 390 px with no sideways scroll, and a bottom bar under 700 px.

## Colors

The palette is functional. Neutrals carry the structure, and six state hues carry meaning. In the norn look every value is
one entry of `palette.hex`: the night ramp for dark, the day ramp (parchment) for light.

### Primary
- **Needs-You Mint** (norn night #9eecc9 / norn day #17504f / classic #0e7490 light, #22d3ee dark): the one accent. It marks
  only what waits for the owner: the Inbox count, the "needs" chip, a selected norn nav tab, the primary button. It is never
  used for decoration or for errors.

### State hues
- **Done Moss** (norn night #94b44c / day #34431c; classic #166534 / #4ade80): ok, done, applied, in force.
- **Running Steel** (norn night #93aec6 / day #2e3f5f; classic #1d4ed8 / #7aa2ff): in progress. It also marks pressed filter
  chips and the current bottom-bar tab in classic.
- **Waiting Amber** (norn night #eec24a / day #6e430f; classic #854d0e / #facc15): warn, handoff, answered, parked. It is
  also the banner ground.
- **Stopped Ember** (norn night #e2683f / day #a5302e; classic #b91c1c / #f87171): bad, stopped, lost, no-result, overruled.
- **Codex Heather** (#a0569a both norn grounds; classic #6d28d9 / #b794f6): the Codex executor chip.

### Neutral
- **Night Ground / Parchment** (#0b0e1a / #e9dcbc; classic #121417 / #f6f7f9): the page ground.
- **Panel** (#151c30 / #f7f0dc; classic #1a1d21 / #ffffff): cards, tables, header, nav.
- **Soft** (#1f2b45 / #e9dcbc; classic #22262b / #eef1f4): controls, idle chips, table heads, zebra rows.
- **Line** (#2e3f5f / #c9b48c; classic #2b3036 / #e3e6ea): every border and divider.
- **Ink / Mute** (#d3e2ec, #93aec6 / #241a14, #433021; classic #e6e8eb, #9aa3ad / #1b1f24, #5d6672): text and secondary text.

### Norn colours on the nav (RM-18)
- History = Urd, Work = Verdandi, Inbox / Plan / Roadmap = Skuld, applied as `.tone-*` classes. Health takes its worst state.

### Named Rules
**The One Accent Rule.** The accent means "needs you" and nothing else. An error never reads as a highlight.

**The Palette Lock Rule.** In the norn look there is no `rgba`, `hsl`, `color-mix`, named colour or opacity below 1. Each
classic fade is redrawn as a solid palette entry.

**The Word Beside the Colour Rule.** A chip always carries its word. Colour alone never carries a state.

## Typography

**Body Font:** the system UI stack (system-ui, -apple-system, Segoe UI, Roboto, sans-serif)
**Label/Mono Font:** ui-monospace, Consolas, monospace, for ids, paths, tokens and code
**Display Font (norn look only):** Silkscreen 400/700, vendored woff2, for headings and nav at 8 art px (16 px at the 2 px scale)

**Character:** a working console, not an editorial page. The body is small and dense, and numbers are tabular. In the norn
look the pixel face appears only on frames and headings, while body text stays the system font for legibility.

### Hierarchy
- **Title** (650, 15 px): the header wordmark text in classic.
- **Section label** (600, 12 px, 0.06em, uppercase, mute): card headings in classic. In norn: Silkscreen 16 px uppercase.
- **Table head** (600, 12 px, mute): column heads, never wrapping on a wide screen.
- **Body** (400, 14 px / 1.45, tabular numerals): every row and paragraph.
- **Small** (12 px): sub-lines, legends, "showing n of m".
- **Mono** (12.5 px): run and record ids, paths, commands.
- **Big number** (700, 22 px; 18 px under 700 px): the summary numbers of a dense page.

### Named Rules
**The Pixel Face Stays on the Frame Rule.** Silkscreen sets headings, nav labels and the drawer title only. It is never used
for body text, tables or numbers.

## Layout

- **Page.** A sticky header (project switcher, status, Look, Theme, Pause, Run tick). Under it the nav bar, then `main` with
  18 px / 20 px padding, up to 1500 px wide and centred.
- **Nav today.** A row of 7 destinations. Work, Health and History open a second row of their pages. The Slop and Context
  pages add a third row of sub-views (`subviewPage`). This is the "nested tabs" problem the redesign removes.
- **Dense-page pattern** (`subviews.mjs`): a summary of at most 4 numbers, then 3 or 4 sub-views, then the chosen part,
  capped at 40 rows with "show more".
- **Breakpoints.** 1100 px (tables tighten), 720 px and 700 px (phone: the bottom bar, the summary grid drops to 2 columns,
  optional columns hide), 600 px.
- **Phone.** Under 700 px a fixed 58 px bottom bar shows Home, Inbox, Runs, Plan and More. More opens the full bar. Every page
  must avoid sideways scrolling at 390 px (tested). Tables either hide optional columns or turn into stacked rows.
- **Rhythm.** Gaps step through 2 / 4 / 6 / 8 / 10 / 14 / 16 px. Cards pad 14 px / 16 px, and table cells pad 8 px / 10 px.
  The norn look multiplies art sizes by `--px` (2 device px per art px) so its frames sit on whole pixels.

## Elevation & Depth

Flat by default. Depth comes from tone: the page ground, then a panel, then a soft control, with 1 px lines between them.
Classic uses one soft shadow (`0 4px 16px rgba(0,0,0,.14)`) only for floating things: the drawer, popovers and
SloppaChoppa's speech bubble. The norn look has no shadows at all. Its frames carry the depth: carved 9-slice panels for
cards, woven panels for dense tables, and an accent-framed panel for "needs you" cards and open questions.

### Named Rules
**The Float-Only Shadow Rule.** A shadow means "this floats over the page" (drawer, popover, bubble). Resting surfaces never
cast one.

## Shapes

- **Classic:** gently rounded. Controls 6 px, banners 8 px, cards and tables 10 px, chips 10 px (a pill at 12 px text).
- **Norn:** square. Every radius is 0. Frames are 9-slice art with an 8 art px border, and images render pixelated.
- **State tokens:** seven universal shapes at 16 art px on chips and 24 art px on cards: play, check, two arrows, stop
  square, pause bars, "!", and a ring. They are drawn in the frame's palette, and they must pass a blind-label test (a
  stranger names the state from the shape alone).

## Components

### Buttons
- **Shape:** 6 px corners in classic, square in norn. 1 px line border, soft fill, 4 px / 10 px padding.
- **Primary:** accent fill with on-accent text. Reserved for the one action that answers or sends.
- **Ghost:** transparent fill, for secondary acts (Archive, Unarchive).
- **Link button (`.lnk`):** text-only, for in-row navigation and "show more".

### Chips
- **Style:** 1 px / 8 px padding, 12 px 600 text, a pill in classic and square in norn, background = the state's `-bg` and
  text = the state colour. In norn a state token is drawn before the word.
- **State:** running, done / ok, handoff / warn, parked, stopped / bad, needs, idle. The executor chips are claude (run hue),
  codex (heather) and own-account (prov: soft with a line).

### Filter chips (`.hf`)
- Toggle buttons in a labelled group with `aria-pressed`. When pressed they take the run hue on the run background, with a
  count in bold. Used by Lanes (show, type) and Runs (state, kind, project, window).

### Cards / Containers
- **Card:** panel fill, 1 px line, 10 px corners, 14 px / 16 px padding. The heading is an uppercase 12 px label.
- **Table card:** the same frame with `overflow: hidden`, an `h3` bar and a full-width table. Zebra rows use `--zebra`.
- **Tree (`.tree` / `.node`):** the Runs grid. One row per run on a 9-column grid at full width, which drops to 3 columns on a
  phone. Children are indented under a caret.
- **Banner:** a warn-ground strip with an 8 px radius, for one line of context above a list.

### Navigation
- **Classic:** text tabs with a 2 px bottom rule when selected (ink, 600). The count badge is an accent pill.
- **Norn:** Silkscreen labels. The selected tab is filled with its Norn tone (`--g`) and drawn in inverse ink.
- **Phone:** the fixed bottom bar with a glyph and a 10.5 px uppercase label. The current tab gets a 3 px top rule. The count
  badge sits on the glyph.

### Drawer
- A right-side sheet `min(620px, 94vw)` wide, holding the live run feed and record details. Its shadow is the only one on the
  page in classic.

### Signature: SloppaChoppa
- A pixel orc. A 32 px bust in the header (a 16 px axe in a 44 px target on a phone) carries a quiet count badge. A 96 px
  animated stage with one speech bubble sits bottom-right. It animates only under `.motion`.

### Signature: the Map (to be folded into Lanes)
- **norn:** the Well, a tree over a well with lanes on a ring of stakes, rendered on change only. The Tapestry is the dense
  one-row-per-lane weave.
- **classic:** an SVG of lane bands, run nodes and dependency edges, with zoom.

## Do's and Don'ts

### Do:
- **Do** put a word in every chip and a unit on every number (`12 min`, `48k`, `3.2 %`).
- **Do** take every colour in the norn look from `palette.hex`, and every size from a whole multiple of `--px`.
- **Do** keep "needs you" one count from `terms.mjs` `needsYou`, shown the same everywhere.
- **Do** check every page at 390 px for sideways scroll, in both looks and both grounds.
- **Do** redraw on state-stream events only.

### Don't:
- **Don't** use the accent for anything but "needs you", and never for an error.
- **Don't** add a timer, polling loop or idle animation. Under a quiet hold or reduced motion, nothing moves.
- **Don't** add a fifth sub-view or summary number to a dense page (`SUB_MAX = 4`).
- **Don't** add a dependency, framework or build step to the dashboard.
- **Don't** give the two looks different structure, ids or words. A look changes only the frame and the style.
- **Don't** draw a status icon that needs its label to be understood.
