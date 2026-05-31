---
name: Sports Projector
description: Read-only sports projection workspace for line research and projection review.
colors:
  background: "#f4f6f2"
  surface: "#ffffff"
  surface-subtle: "#f8faf7"
  surface-strong: "#eef3ee"
  text: "#18212d"
  muted: "#697586"
  soft: "#475467"
  border: "#d8ded6"
  border-strong: "#b9c4b8"
  primary: "#2557d6"
  primary-strong: "#163ca1"
  primary-soft: "#e8efff"
  success: "#0f7b56"
  success-soft: "#e3f7ec"
  warning: "#b25f00"
  warning-soft: "#fff2dd"
  danger: "#c5342b"
  danger-soft: "#fff1ef"
  dark-background: "#101419"
  dark-surface: "#171d24"
  dark-surface-subtle: "#1d252d"
  dark-text: "#edf2f7"
typography:
  display:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "clamp(2rem, 3vw, 3.1rem)"
    fontWeight: 800
    lineHeight: 1
    letterSpacing: "0"
  headline:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "1.1rem"
    fontWeight: 800
    lineHeight: 1.2
  title:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "1rem"
    fontWeight: 800
    lineHeight: 1.25
  body:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "0.86rem"
    fontWeight: 800
    lineHeight: 1.25
    letterSpacing: "0"
rounded:
  sm: "6px"
  md: "7px"
  lg: "8px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "28px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.surface}"
    rounded: "{rounded.sm}"
    padding: "0 16px"
    height: "44px"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.sm}"
    padding: "0 16px"
    height: "44px"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.sm}"
    padding: "0 12px"
    height: "44px"
  panel:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.lg}"
    padding: "16px"
---

# Design System: Sports Projector

## 1. Overview

**Creative North Star: "The Projection Desk"**

Sports Projector should feel like a focused analyst workspace: quiet, dense, and inspectable. The design serves users who are comparing lines, projection outputs, live state, and caveats under time pressure. Visual confidence comes from hierarchy, source clarity, and consistent state language, not from betting hype.

The current system is a restrained product UI with warm-neutral light surfaces, a deep blue action accent, green and amber semantic states, compact panels, and a single Inter/system sans stack. Sports imagery is allowed only when it communicates an interaction or data state, such as a loading court, selected game, refresh motion, or projection update.

**Key Characteristics:**

- Dense but readable projection and schedule panels.
- Blue reserved for primary actions, selected states, and update focus.
- Green, amber, and red used as semantic state colors with text labels beside them.
- Small-radius controls and panels that feel utilitarian, not soft or promotional.
- Motion used for loading and refresh feedback, with reduced-motion alternatives.

## 2. Colors

The palette is restrained: warm-neutral surfaces carry the workspace, blue marks action and selection, and semantic colors communicate model or system state.

### Primary

- **Projection Blue**: The primary action and selected-state color. Use it for primary buttons, active navigation, selected games, and live projection update affordances.
- **Projection Blue Strong**: Hover and stronger emphasis for primary actions. Use sparingly so the base primary remains the recognizable action cue.
- **Projection Blue Soft**: Selection and hover backgrounds for game rows, live-game buttons, and other selectable surfaces.

### Secondary

- **Model Green**: Success, live, and positive availability state. Pair it with explicit text such as "LIVE", "Enabled", or "Success"; never rely on green alone.
- **Caution Amber**: Kicker labels, counts, and warning-adjacent emphasis. Use it as a small signal, not as a casino-gold brand color.
- **Risk Red**: Errors and unavailable states. Always pair with alert text and preserve contrast.

### Neutral

- **Field Background**: The light application canvas. It should stay quiet behind the data surfaces.
- **Panel Surface**: Primary card, panel, input, and table surface.
- **Subtle Surface**: Nested controls and metric groups inside panels.
- **Strong Surface**: Table headers and low-emphasis structural blocks.
- **Ink Text**: Primary reading color for headings, data, scores, and values.
- **Muted Text**: Secondary metadata, caveats, timestamps, and status detail.
- **Soft Text**: Labels and quieter controls that still need readable contrast.
- **Line Border**: Default panel, control, and table divider color.

### Named Rules

**The No Casino Rule.** Blue, green, amber, and red are semantic product colors. Do not shift amber into gold, do not add neon, and do not use saturated gambling palettes.

**The Evidence Color Rule.** Color may draw the eye to state, selection, or refresh, but labels and values must carry the meaning.

## 3. Typography

**Display Font:** Inter with system sans fallbacks  
**Body Font:** Inter with system sans fallbacks  
**Label/Mono Font:** Inter with system sans fallbacks

**Character:** The typography is functional and compact. Weight creates hierarchy, while size changes stay modest so tables, cards, and settings remain easy to scan.

### Hierarchy

- **Display** (800, `clamp(2rem, 3vw, 3.1rem)`, line-height 1): App title only. Avoid using hero-scale type inside panels.
- **Headline** (800, `1.1rem`, line-height 1.2): Section headings such as Settings, live games, and projection panels.
- **Title** (800, `1rem`, line-height 1.25): Card titles, metric group labels, and compact panel headings.
- **Body** (400, `1rem`, line-height 1.5): Standard readable copy, caveats, and explanatory text. Keep longer prose under 75ch.
- **Label** (800, `0.86rem`, no letter spacing): Form labels, button labels, and field labels. Uppercase is reserved for very short state tags and table headings.

### Named Rules

**The One Family Rule.** Use the existing Inter/system sans stack across the product. Do not introduce display fonts, sportsbook scripts, or decorative type.

**The Compact Confidence Rule.** Increase weight before increasing size inside panels. This is a working tool, not a landing page.

## 4. Elevation

The system uses a hybrid of tonal layering, borders, and one soft ambient shadow for major panels and top-level navigation controls. Elevation should separate work areas without making surfaces feel like marketing cards.

### Shadow Vocabulary

- **Panel Ambient** (`0 20px 60px rgb(24 33 45 / 8%)`): Top-level panels, the control panel, live panel, projection panel, and header nav buttons.
- **Dark Panel Ambient** (`0 20px 60px rgb(0 0 0 / 28%)`): Dark-mode equivalent for top-level panels.
- **Micro Emphasis** (`0 10px 26px rgb(24 33 45 / 8%)`): Small highlighted score total treatment only.
- **Sports Feedback Glow** (`0 5px 14px rgb(178 95 0 / 28%)`): Animated loading ball feedback only.

### Named Rules

**The Work Surface Rule.** Use borders and tonal fills before adding shadow. Shadows belong to top-level structure or active feedback, not every nested metric tile.

## 5. Components

### Buttons

- **Shape:** Small-radius rectangle (6px) with a 44px minimum height.
- **Primary:** Projection Blue background with white text, used for actions that execute a search or apply a tracked line.
- **Hover / Focus:** Hover deepens the blue. Focus uses the shared 3px focus ring and must remain visible in light and dark mode.
- **Secondary / Navigation:** Secondary buttons stay white with border and ink text. Navigation buttons use the same shape and become blue only when active or hovered.

### Chips

- **Style:** Pills use full-radius corners only for compact count and live-status indicators.
- **State:** Count pills use amber text on amber-soft background. Live badges use green text on green-soft background with explicit `LIVE` text.

### Cards / Containers

- **Corner Style:** Top-level panels use an 8px radius. Nested panels and cards use 7px. Metric tiles use 6px.
- **Background:** Top-level panels use the panel background. Nested form rows, projection cards, and metric groups use subtle surface.
- **Shadow Strategy:** Only top-level panels receive the ambient panel shadow. Nested cards use borders and tonal layering.
- **Border:** Use the default border for structure and the primary border only for selected or hovered selectable items.
- **Internal Padding:** Panels use 16px. Nested cards use 12px to 14px.

### Inputs / Fields

- **Style:** 44px minimum height, 6px radius, strong border, white surface, ink text.
- **Focus:** Shared 3px blue focus ring. Do not replace it with color-only border changes.
- **Error / Disabled:** Disabled controls use opacity reduction. Errors appear as red-soft alert rows with red text and alert semantics.

### Navigation

- **Style:** The top header uses two button-like view controls for Workspace and Settings. Active and hover states share the same blue border and text treatment.
- **Mobile:** Header controls stack into a grid and full-width buttons below 720px.

### Projection Workspace

The signature surface is the projection/detail workspace: search controls, live board, projection detail, results table, and mobile result cards. Selection should be visible through border shift, background tint, and ARIA-selected state. Projection update states should use motion only for refresh feedback and should honor reduced-motion preferences.

## 6. Do's and Don'ts

### Do:

- **Do** keep the product precise, analytical, and restrained.
- **Do** pair every live, error, success, or advised-line state with text, iconography, structure, or values so color is never the only signal.
- **Do** use subtle sports/data graphics only for interaction feedback: transitions, button pushes, refresh states, selected games, loading states, and projection updates.
- **Do** preserve the existing 6px to 8px radius vocabulary for controls, cards, and panels.
- **Do** keep projection assumptions, confidence, and caveats close to any advised line.

### Don't:

- **Don't** use casino aesthetics, sportsbook hype, neon gambling visuals, fake certainty, or anything that makes the product feel like a tout service.
- **Don't** add decorative sports clutter that does not explain interaction, data state, or projection changes.
- **Don't** introduce gradient text, glassmorphism, oversized hero metrics, or promotional landing-page composition into the workspace.
- **Don't** use amber as casino gold or green as a wagering encouragement color.
- **Don't** hide uncertainty, caveats, or model limitations behind celebratory styling.
