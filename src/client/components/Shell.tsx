import type { ReactNode } from "react";
import { Link, useLocation } from "wouter";
import {
  CheckSquare,
  House,
  PaperPlaneTilt,
  SuitcaseRolling,
  TrayArrowDown,
  Users,
} from "@phosphor-icons/react";

const NAV = [
  { href: "/", label: "Today" },
  { href: "/trips", label: "Trips" },
  { href: "/checklist", label: "Checklist" },
  { href: "/people", label: "People" },
  { href: "/cards", label: "Cards" },
  { href: "/settings", label: "Settings" },
];

export function Shell({
  children,
  identity,
}: {
  children: ReactNode;
  /**
   * From `GET /api/me`; null/undefined until it resolves. Typed structurally
   * rather than importing `Identity`, so this task does not depend on Task 3's
   * `api/types.ts` existing yet — the real `Identity` satisfies this shape.
   */
  identity?: { email: string; role: string } | null;
}) {
  const [location] = useLocation();

  return (
    <>
      <nav className="top-nav" aria-label="Primary">
        <Link
          href="/"
          className="nav-brand"
          style={{ display: "flex", alignItems: "center", gap: 8, marginRight: "auto" }}
        >
          <PaperPlaneTilt size={20} color="var(--color-accent)" weight="regular" />
          <span style={{ fontSize: 16, fontWeight: 500 }}>Travel HQ</span>
        </Link>

        {/* No inline color/textDecoration/fontSize here: `.top-nav a` in
            styles.css owns them, and an inline `color` would outrank the
            `[aria-current='page']` accent rule, leaving the active page
            announced to screen readers but invisible to everyone else. */}
        {NAV.map(({ href, label }) => (
          <Link
            key={href}
            href={href}
            aria-current={location === href ? "page" : undefined}
          >
            {label}
          </Link>
        ))}

        <Link
          href="/import"
          className="btn btn-secondary"
          aria-current={location === "/import" ? "page" : undefined}
        >
          <TrayArrowDown size={16} />
          Import
        </Link>

        {identity && (
          <span className="nav-user" title={identity.email}>
            {identity.email.slice(0, 1).toUpperCase()}
          </span>
        )}
      </nav>

      <main className="page">{children}</main>
      <BottomTabs />
    </>
  );
}

/* Mobile-only (styles.css hides it above 760px). Settings/Cards stay
   reachable via the desktop nav only for now — mobile gets them behind the
   avatar later, per the mobile/PWA handoff. */
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
    <nav className="bottom-tabs" aria-label="Tabs">
      {TABS.map(({ href, label, Icon }) => {
        /* startsWith, unlike the top nav's exact match, so /trips/:id keeps
           the Trips tab lit. */
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
