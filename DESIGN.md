---
version: alpha
colors:
  background: "#f7f8fa"
  foreground: "#26323d"
  muted: "#657482"
  accent: "#006cac"
  border: "#d7dee5"
  error: "#b42318"
typography:
  body:
    fontFamily: "system-ui, sans-serif"
    fontSize: "13px"
  code:
    fontFamily: "monospace"
    fontSize: "11px"
rounded:
  control: "5px"
spacing:
  panel: "16px"
  section: "20px"
components:
  review:
    description: "One source-labelled review card per proposal with explicit hunk decisions."
---

# CodeAuditor design

## Overview

An editor-native review desk for developers. Product register, English interface, local workflow. The signature is a source-labelled review rail: code, context reasons and explicit decisions remain visible together. No marketing banners, decorative charts, remote fonts or model-performance claims.

## Colors

VS Code theme tokens are the runtime authority. `media/panel.css` maps `--ca-*` to host foreground/background/input/button/focus/diff/scrollbar tokens; the values above are light-theme fallbacks only. Dark and high-contrast modes follow the editor. State is always labelled, never colour alone.

## Typography

Use the editor's UI font for controls and its code font for source, paths and tool activity. A restrained 24px empty-state title gives way to dense 11–13px working content. No downloaded font files.

## Layout

The webview owns one bounded content scroller between status and composer. At 300px and below controls wrap; no hunk decision becomes inaccessible. The composer and Stop action remain in stable positions. Source blocks wrap with full content available in the native diff editor.

## Elevation & Depth

Flat panels with host-token borders. No shadows or ornamental gradients.

## Shapes

5px control radius and compact review grouping. Source belongs in code blocks, not pill badges.

## Components

Native buttons, labelled textarea, polite status, inline error, context list, activity list and review cards. Native VS Code commands own editor selection, input and diff windows; the webview does not reproduce host dialogs. Both sidebar and inline paths use the same proposal engine.

## Do's and Don'ts

Use plain action labels: Start task, Stop, Accept hunk, Reject hunk, Apply reviewed changes. Preserve typed drafts. Respect IME composition, visible focus, reduced motion and forced-colors. Never render model output as executable HTML. Never auto-scroll users away from material they are reviewing.
