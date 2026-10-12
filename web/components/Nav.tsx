// Top nav on every page. Plain links, no client state, so it renders on the server.
import { GITHUB } from "./LandingData";
import { Mark } from "./landing/Mark";

// `wide` links hide on phones to keep the bar on one line; the footer carries them there.
const LINKS: { href: string; label: string; external?: boolean; cta?: boolean; wide?: boolean }[] = [
  { href: "/r", label: "Reviews" },
  { href: "/experiment", label: "Experiment" },
  { href: "/book", label: "Book", wide: true },
  { href: GITHUB, label: "GitHub", external: true, wide: true },
  { href: "/try", label: "Try", cta: true },
];

export function Nav() {
  return (
    <header className="top">
      <nav className="nav" aria-label="Site">
        <a href="/" className="brand" aria-label="Roster home">
          <Mark />
          <span>roster</span>
        </a>
        <ul className="nav-links">
          {LINKS.map((l) => (
            <li key={l.label} className={l.wide ? "nav-wide" : undefined}>
              <a
                href={l.href}
                className={l.cta ? "nav-cta" : undefined}
                {...(l.external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
              >
                {l.label}
              </a>
            </li>
          ))}
        </ul>
      </nav>
    </header>
  );
}
