import type { ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { PaperPlaneTilt, TrayArrowDown } from "@phosphor-icons/react";

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
      <nav className="top-nav">
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
    </>
  );
}
