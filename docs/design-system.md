# Antiphon Design System

Direction: **dark, dense, pro-audio instrument panel.** Confidence over
decoration; every pixel earns its place the way it does on a mixing console.

## Where the tokens live

- [apps/web/src/styles.css](../apps/web/src/styles.css) — Tailwind v4
  `@theme` variables: the full surface/border/text ladders, accent,
  semantics, 8-color track palette, IBM Plex font stacks, `vu`/`recpulse`
  keyframes, VU gradient utilities.
- [apps/web/src/ui/kit.tsx](../apps/web/src/ui/kit.tsx) — the component kit:
  `Panel`, `InsetDisplay`, `SectionLabel`, `MonoReadout`, `StatusPill`,
  `Badge`, `Button`, `Avatar`, `VUMeter`, `RecDot`, `Wordmark`.

**Rule: components never write raw hex.** New colors go through `@theme`;
new patterns go through the kit.

## Typography

| Use                                                    | Font                     |
| ------------------------------------------------------ | ------------------------ |
| UI chrome, names, labels                                | IBM Plex Sans (400–700)  |
| Every technical readout: timecode, seq, CHWM, dB, device info, badges, pills | IBM Plex Mono (400–600) |

Self-hosted via `@fontsource/*` — runtime Google Fonts is blocked under
COOP/COEP `require-corp`, and venue networks are unreliable anyway. Dense
sizes: body 12px, chrome 10–11px, labels 8–9.5px with letter-spacing.

## Color

Surfaces, deepest → most raised: `void #111213`, `bg #141516`,
`lane #161718`, `raised #1a1b1c`, `panel #1d1e1f`, `card #202122`,
`card-hi #242526`, wells `#0e0f10`. Hard dividers are `#0a0a0a`; borders
step `#2c2e30 → #2e3032 → #303234 → #333537 → #3a3c3e`.

Text ladder: `#f0f1f2 → #e8e9ea → #d6d7d8 → #c0c1c3 → #a5a7aa → #8b8d90 →
#6b6d70`.

Accent `#2E8BFF` (alternates kept as theme options: `#9A5CFF`, `#00C48F`,
`#FF7A45`). Semantics: record `#e5484d`, meter green `#3fbf6f`, meter
yellow `#d9c94b`, comment amber `#f2b84b`. Track palette (8): `#4fb8a8
#d9a441 #d96c7b #d97e4a #5b8dd9 #9a7bd9 #55aec8 #7bb661`.

## Signature patterns

- **Inset displays**: darker bg + 1px `edge-inset` border + 6px radius
  (timecode, BPM, snap controls).
- **Status pills**: mono, uppercase, 8.5px, bold, wide tracking; RECORDING
  is solid record-red with `recpulse` blink.
- **Avatars**: filled circles with initials, 2px surface-colored ring, tiny
  status dot bottom-right.
- **VU meters**: green→yellow→red gradient (60/85 vertical, 70/90
  horizontal), animated with the `vu` keyframes when simulated, scaled by
  real level when live.
- **Clip cards** (Phase 6): solid track-color header strip over a
  translucent track-color body, 1px matching border, 5px radius.
- **Radii are small**: 3–8px. Motion is utilitarian: `recpulse`, `vu`,
  fast hover transitions — no decorative animation.

## Process rule

Before ANY UI work, read this document and derive from the tokens and
patterns above — never ad-hoc styles.
