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
- Blog posts have right-sidebar scroll-driven animations + ELI10 panels (see below)

## Writing Style Rules

When generating blog content or any user-facing copy for this site, follow these rules to keep the writing natural and human-sounding:

### Hard rules (never do these)
- **Never use em dashes** (the long dash: —). Use periods, commas, semicolons, colons, or just restructure the sentence instead.
- **Never use "delve", "tapestry", "landscape", "leverage", "utilize", "facilitate", "aforementioned", "endeavor", "realm", "lingua franca"** or similar overused AI words. Use plain English.
- **Never open with "In today's...", "In the world of...", "In an era of..."** or similar throat-clearing phrases. Start with something specific.
- **Never use "without further ado", "let's dive in", "let's unpack this"** or similar filler transitions.
- **Never use the "[Noun]: [observation]" sentence pattern** (e.g., "The irony: most apps don't need this"). It's a signature AI construction. Reword naturally.
- **Never use "Here's where it gets interesting"** or variants. Find a specific way to transition instead.
- **Never start sentences with "Here's what/why/how"** more than once per article. Rephrase as "What that looks like..." or just state the point directly.

### Soft rules (prefer these)
- Vary sentence length. Mix short punchy sentences with longer ones. Don't let every sentence be the same rhythm.
- Use contractions naturally (I'm, don't, it's, can't). Formal writing without contractions reads robotic.
- Prefer simple words over fancy ones. "Use" not "utilize". "Help" not "facilitate". "Start" not "commence".
- Use "but" and "and" to start sentences when it helps the flow.
- In lists, don't start every bullet the same way. Vary the structure.
- Add personal opinions, small asides, and informal language where appropriate. Blogs should sound like a person talking, not a press release.
- Use parenthetical asides naturally (like this) instead of em dashes for interjections.
- When using colons in list items for label:description pairs, use a bold label followed by a period or the description on the same line. Don't use em dashes as separators.
- Don't repeat the same rhetorical device (e.g., "Every X. Every Y. Every Z.") more than once per article. Readers notice patterns.
- When structuring numbered lists of arguments (e.g., "The 7 problems with X"), don't make every item perfectly parallel. Real writers get messier: combine related points, make some longer than others, break the pattern.
- Avoid the setup-setup-punch tricolon rhythm ("It's not X. It's not Y. It's Z.") more than once per article. Vary how you land your points.

## Scroll-Driven Sidebar Animations

Each blog post can have a right-sidebar component that combines an SVG animation with an ELI10 (Explain Like I'm 10) panel. Both update as the reader scrolls through article sections.

### How it works
- Components live in `src/components/` (e.g., `StorageEvolution.astro`, `ProtocolEvolution.astro`, `PosixEvolution.astro`)
- Injected via named Astro slot `<Component slot="right-sidebar" />` in `src/pages/blog/[...slug].astro`
- BlogPost layout has a 3-column grid: TOC (left) | Content (center) | Sidebar (right)
- Sidebar is `hidden lg:block` (desktop only), sticky with `max-h-[calc(100vh-8rem)] overflow-y-auto`
- Uses IntersectionObserver (`rootMargin: "-15% 0px -75% 0px"`) to detect which H2/H3 heading is in view
- Each heading's text content is matched to a stage number via string matching
- `setStage()` updates the SVG (`.active`/`.past` classes), metrics panel, stage dots, and ELI10 text

### Component structure (inside the sticky div)
1. **Title label** - e.g., "Protocol Evolution"
2. **SVG animation** - viewBox `200x230`, stages shown/hidden via opacity/transform transitions
3. **Metrics panel** - contextual numbers (throughput, latency, etc.) that change per stage
4. **Stage dots** - progress indicator showing which stage is active
5. **ELI10 panel** - kid-friendly explanation that fades and updates per stage

### When creating a new sidebar animation
- Create a single `.astro` component with all HTML, `<style>`, and `<script>` self-contained
- Define stages as SVG groups with class `[prefix]-stage` (e.g., `proto-stage`, `evo-stage`)
- Map H2/H3 heading text to stage numbers in the script's `stageMap`
- Include metrics data array and ELI10 data array (one entry per stage)
- Use unique ID prefixes per component to avoid collisions (e.g., `proto-metric-value`, `posix-eli10-text`)
- Add `.changing` class for ELI10 fade-out, remove after 200ms `setTimeout` with new text
- Respect `prefers-reduced-motion: reduce` by disabling transitions and animations
- Register the component in `[...slug].astro` with a conditional based on `post.id`

### ELI10 writing rules
- Write as if explaining to a 10-year-old. Use analogies from everyday life (toys, school, food, libraries).
- Keep each entry to 2-3 sentences max. Short and punchy.
- Be genuinely funny when possible. Dad jokes welcome.
- Each entry should actually explain the concept the reader is currently scrolling through, not just be cute.
- Avoid technical jargon. If you must use a technical term, immediately explain it in kid terms.
- Vary the analogies. Don't reuse the same metaphor domain (e.g., "library") across multiple stages in the same post.
