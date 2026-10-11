// Top nav on every page. Plain links, no client state, so it renders on the server.
import { GITHUB } from "./LandingData";

const LINKS: { href: string; label: string; external?: boolean }[] = [
  { href: "/r", label: "Reviews" },
  { href: "/try", label: "Try" },
  { href: "/experiment", label: "Experiment" },
  { href: GITHUB, label: "GitHub", external: true },
];

export function Nav() {
  return (
    <header className="top">
      <nav className="nav" aria-label="Site">
        <a href="/" className="brand">roster</a>
        <ul className="nav-links">
          {LINKS.map((l) => (
            <li key={l.label}>
              <a href={l.href} {...(l.external ? { target: "_blank", rel: "noopener noreferrer" } : {})}>
                {l.label}
              </a>
            </li>
          ))}
        </ul>
      </nav>
    </header>
  );
}
