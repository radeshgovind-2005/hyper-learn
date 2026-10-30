import { UserButton } from "@clerk/react";
import { type ReactNode, useEffect, useState } from "react";

/**
 * The page frame: header (logo, page actions, account), sidebar (course list and learning path), main
 * column, and drawers after it. On narrow screens the sidebar slides over; `navKey` changing closes it.
 */
export function Shell({
  actions,
  sidebar,
  children,
  drawers,
  connected,
  navKey,
}: {
  actions?: ReactNode;
  sidebar: ReactNode;
  children: ReactNode;
  drawers?: ReactNode;
  connected: boolean;
  navKey?: string;
}) {
  const [navOpen, setNavOpen] = useState(false);
  useEffect(() => setNavOpen(false), [navKey]);
  return (
    <div className="app">
      <header className="header">
        <button className="icon-btn menu-btn" onClick={() => setNavOpen((o) => !o)} aria-label="Courses and learning path">
          ☰
        </button>
        <div className="brand">
          <img className="app-logo" src="/hyperlearn-logo.png" alt="HyperLearn" />
        </div>
        <span className="spacer" />
        {actions}
        <span className="account" title={connected ? "connected" : "connecting…"}>
          <UserButton />
          <span className={`status ${connected ? "on" : ""}`} />
        </span>
      </header>

      <div className="body">
        <nav className={`sidebar ${navOpen ? "open" : ""}`} aria-label="Courses and learning path">
          {sidebar}
        </nav>
        <main className="main">{children}</main>
        {drawers}
      </div>
    </div>
  );
}
