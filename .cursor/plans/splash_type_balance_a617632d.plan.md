---
name: Splash type balance
overview: Rebalance SplashGreeting title/subtitle size, weight, and width so the block reads evenly across breakpoints without changing the font family or copy.
todos:
  - id: update-greet-css
    content: Update .pxs-greet-title / .pxs-greet-sub clamps, weight, color, and max-width in SplashGreeting.tsx
    status: completed
isProject: false
---

# Splash greeting type balance

## Approach

Keep IBM Plex Sans and current copy. Fix the inverted-pyramid feel by (1) flattening the title’s `clamp` so it doesn’t swing too small/large across viewports, (2) lifting the subtitle size and contrast, and (3) constraining subtitle width so it wraps to ~title width.

Single file: [packages/pxs-studio/src/components/SplashGreeting.tsx](packages/pxs-studio/src/components/SplashGreeting.tsx)

## Changes

Update the `.pxs-greet-title` / `.pxs-greet-sub` rules inside the component’s `CSS` string:

```css
.pxs-greet-title {
  font-size: clamp(1.5rem, 1.2rem + 1.2vw, 2rem); /* ~24 → 32px */
  font-weight: var(--a2ui-font-medium, 500);
  letter-spacing: -0.02em;
  line-height: var(--a2ui-leading-tight);
  color: var(--a2ui-text-primary);
  margin: 0;
}
.pxs-greet-sub {
  font-size: clamp(0.9375rem, 0.85rem + 0.35vw, 1.125rem); /* ~15 → 18px */
  font-weight: var(--a2ui-font-normal, 400);
  color: var(--a2ui-text-secondary); /* was tertiary */
  line-height: 1.4;
  margin: 0;
  max-width: 28ch; /* wrap long tagline to match title width */
}
```

Leave gap, chips, and greeting copy as-is (`SHOW_CHIPS` stays false).

## Verify

- New-user splash (`?new`): title and two-line subtitle form a balanced centered block; subtitle not wider than title.
- Returning splash: “Welcome back…” + resume line still reads calmly at medium weight.
- Spot-check ~375px, ~1024px, and ~1440px — title should feel present but not jumpy; subtitle readable without looking like a caption under a shout.
