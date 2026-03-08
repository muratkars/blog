# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Personal website and blog built with Astro 5, Tailwind CSS 4, and MDX. Deployed to GitHub Pages.

## Commands

- `pnpm dev` - Start dev server (localhost:4321)
- `pnpm build` - Production build
- `pnpm preview` - Preview production build

## Architecture

- **Astro 5** with content collections (glob loader) and MDX
- **Tailwind CSS 4** via `@tailwindcss/vite` (not the deprecated `@astrojs/tailwind`)
- Blog posts support two types: `standard` (plain Markdown) and `story` (MDX with scroll components)
- Content config lives in `src/content.config.ts`
- Scroll storytelling uses vanilla JS Intersection Observer, no framework islands

## Writing Style Rules

When generating blog content or any user-facing copy for this site, follow these rules to keep the writing natural and human-sounding:

### Hard rules (never do these)
- **Never use em dashes** (the long dash: —). Use periods, commas, semicolons, colons, or just restructure the sentence instead.
- **Never use "delve", "tapestry", "landscape", "leverage", "utilize", "facilitate", "aforementioned", "endeavor", "realm"** or similar overused AI words. Use plain English.
- **Never open with "In today's...", "In the world of...", "In an era of..."** or similar throat-clearing phrases. Start with something specific.
- **Never use "without further ado", "let's dive in", "let's unpack this"** or similar filler transitions.

### Soft rules (prefer these)
- Vary sentence length. Mix short punchy sentences with longer ones. Don't let every sentence be the same rhythm.
- Use contractions naturally (I'm, don't, it's, can't). Formal writing without contractions reads robotic.
- Prefer simple words over fancy ones. "Use" not "utilize". "Help" not "facilitate". "Start" not "commence".
- Use "but" and "and" to start sentences when it helps the flow.
- In lists, don't start every bullet the same way. Vary the structure.
- Add personal opinions, small asides, and informal language where appropriate. Blogs should sound like a person talking, not a press release.
- Use parenthetical asides naturally (like this) instead of em dashes for interjections.
- When using colons in list items for label:description pairs, use a bold label followed by a period or the description on the same line. Don't use em dashes as separators.
