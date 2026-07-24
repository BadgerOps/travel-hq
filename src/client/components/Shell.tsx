import { useEffect, useRef, useState, type ReactNode } from "react";
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

        {identity && <AccountMenu email={identity.email} />}
      </nav>

      <main className="page">{children}</main>
      <BottomTabs />
    </>
  );
}

/* The avatar chip, now a disclosure button: on mobile the collapsed header
   leaves Settings and Cards with no home in the tab bar, so they live here
   (the handoff's "behind the avatar" note). Disclosure pattern, not
   role="menu" — two links don't warrant arrow-key management. */
function AccountMenu({ email }: { email: string }) {
  const [open, setOpen] = useState(false);
  const [location] = useLocation();
  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  /* A menu link navigated — the popup's job is done. */
  useEffect(() => {
    setOpen(false);
  }, [location]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className="nav-user-wrap" ref={wrapRef}>
      <button
        type="button"
        ref={buttonRef}
        className="nav-user"
        title={email}
        aria-label="Account menu"
        aria-expanded={open}
        aria-controls="nav-user-menu"
        onClick={() => setOpen((o) => !o)}
      >
        {email.slice(0, 1).toUpperCase()}
      </button>
      {open && (
        <div className="nav-user-menu" id="nav-user-menu" data-testid="nav-user-menu">
          <span className="nav-user-email">{email}</span>
          <Link href="/settings" aria-current={location === "/settings" ? "page" : undefined}>
            Settings
          </Link>
          <Link href="/cards" aria-current={location === "/cards" ? "page" : undefined}>
            Cards
          </Link>
        </div>
      )}
    </div>
  );
}

/* Mobile-only (styles.css hides it above 760px). Settings/Cards live in the
   AccountMenu above rather than the tab bar, per the mobile/PWA handoff. */
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
