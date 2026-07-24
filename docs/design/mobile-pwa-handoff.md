# Handoff delta: mobile layout + PWA install

Applies on top of the trips-first redesign already implemented (`docs/design/README.md`). Two changes: **mobile-friendly layout** (collapsed header + bottom tab bar under 760px, fluid paddings) and **PWA installability** (manifest + service worker + icons). Reference: the updated `Travel HQ Prototype.dc.html` in this folder (resize the window to see both layouts; logic at the bottom of the file).

## 1. Files to copy verbatim → repo `public/`
- `public/manifest.webmanifest` — start_url/scope are `/` (Vite serves `public/` at root)
- `public/sw.js` — network-first, cache fallback; enough for install + offline shell. Bump `CACHE` on deploy or wire to your build hash later.
- `public/icons/icon-192.png`, `public/icons/icon-512.png` — dark ground + accent paper plane, maskable-safe

## 2. `index.html`
- Change `theme-color` `#0a0d12` → `#161826` (must match the token ground)
- Add in `<head>`:
```html
<link rel="manifest" href="/manifest.webmanifest" />
<link rel="apple-touch-icon" href="/icons/icon-192.png" />
```

## 3. `src/client/main.tsx` — register the worker
```ts
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}
```
(PROD-only so dev HMR never fights a cached shell.)

## 4. `Shell.tsx` — add bottom tabs
Keep the existing top nav for desktop. Add a `BottomTabs` sibling under `<main>`:
```tsx
import { House, SuitcaseRolling, TrayArrowDown, CheckSquare, Users } from "@phosphor-icons/react";

const TABS = [
  { href: "/", label: "Today", Icon: House },
  { href: "/trips", label: "Trips", Icon: SuitcaseRolling },
  { href: "/import", label: "Import", Icon: TrayArrowDown },
  { href: "/checklist", label: "Checklist", Icon: CheckSquare },
  { href: "/people", label: "People", Icon: Users },
];

export function BottomTabs() {
  const [location] = useLocation();
  return (
    <nav className="bottom-tabs">
      {TABS.map(({ href, label, Icon }) => {
        const active = href === "/" ? location === "/" : location.startsWith(href);
        return (
          <Link key={href} href={href} aria-current={active ? "page" : undefined}>
            <Icon size={20} weight={active ? "fill" : "regular"} />
            <span>{label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
```
Settings/Cards stay reachable via desktop nav only for now (mobile: behind the avatar later).

## 5. `styles.css` additions
```css
.bottom-tabs { display: none; }

@media (max-width: 760px) {
  /* header collapses to brand + avatar */
  .top-nav a:not(.nav-brand):not(.btn), .top-nav .btn { display: none; }
  .top-nav { padding: 6px 16px; }
  .nav-user { width: 32px; height: 32px; font-size: 13px; }

  /* room for the tab bar */
  .page { padding: clamp(16px, 4vw, 26px) clamp(14px, 3.5vw, 28px) 110px; }

  .bottom-tabs {
    position: fixed; inset: auto 0 0 0; z-index: 40;
    display: flex;
    border-top: 1px solid var(--color-divider);
    background: color-mix(in srgb, var(--color-bg) 92%, transparent);
    backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px);
    padding: 4px 6px calc(4px + env(safe-area-inset-bottom, 0px));
  }
  .bottom-tabs a {
    flex: 1; min-height: 48px;
    display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px;
    border-radius: var(--radius-sm);
    color: var(--color-neutral-400); font-size: 10px; letter-spacing: .02em; text-decoration: none;
  }
  .bottom-tabs a[aria-current="page"] { color: var(--color-accent); }
  .bottom-tabs a:active { background: color-mix(in srgb, var(--color-accent) 12%, transparent); }

  /* toasts clear the tab bar */
  .toast { bottom: 86px; }
}
```

## 6. Layout fixes everywhere (both breakpoints)
- Any `repeat(auto-fit, minmax(Npx, 1fr))` grid → `minmax(min(Npx, 100%), 1fr)` so cards never overflow a narrow viewport (trips grid 380px, import grid 420px).
- Hero panels: padding `clamp(16px, 3.5vw, 22px) clamp(16px, 3.5vw, 24px)`.
- Hit targets on mobile ≥ 44px (tab bar rows are 48px).
- Verify at 390px: home (both tripActive states), import (all three tabs), toasts.

## Acceptance
- Lighthouse PWA installable pass on the deployed origin (HTTPS via Cloudflare — already satisfied).
- Desktop install (Chrome/Edge address-bar icon) opens a standalone window on `/`.
- No horizontal scroll at 390px; bottom tabs never overlap content or toasts.
