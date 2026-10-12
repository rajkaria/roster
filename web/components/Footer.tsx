// Site footer on every page. Plain links, rendered on the server.
import { GITHUB } from "./LandingData";
import { Mark } from "./landing/Mark";

export function Footer() {
  return (
    <footer className="foot">
      <div className="foot-inner">
        <a href="/" className="brand" aria-label="Roster home">
          <Mark size={18} />
          <span>roster</span>
        </a>
        <p className="foot-text">Performance reviews for AI coding agents. MIT licensed.</p>
        <nav className="foot-links" aria-label="Footer">
          <a href="/r">Reviews</a>
          <a href="/experiment">Experiment</a>
          <a href="/book">Book</a>
          <a href={GITHUB} rel="noopener noreferrer" target="_blank">
            GitHub
          </a>
        </nav>
      </div>
    </footer>
  );
}
