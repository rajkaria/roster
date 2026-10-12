"use client";
// A split-flap value: the server renders the final characters, and on load each tile flips through a few
// random glyphs before it settles, left to right. Reduced motion skips straight to the final text.
import { useEffect, useState } from "react";

const GLYPHS = "0123456789$.%=/ABCDEFGHIKLMNOPRSTUVXYZ";
const FRAME_MS = 42;

export function SplitFlap({ text, start = 0, label }: { text: string; start?: number; label?: string }) {
  // Screen readers and crawlers get the settled value once, from a visually hidden copy; the tiles are decoration.
  const [shown, setShown] = useState(text);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const chars = Array.from(text);
    // Tile i settles after its own number of frames, so the board resolves left to right.
    const settleAt = chars.map((_, i) => 7 + i * 2 + Math.floor(start / FRAME_MS));
    let frame = 0;
    const id = window.setInterval(() => {
      frame++;
      const next = chars
        .map((c, i) => (c === " " || frame >= settleAt[i]! ? c : GLYPHS[Math.floor(Math.random() * GLYPHS.length)]!))
        .join("");
      setShown(next);
      if (frame >= settleAt[settleAt.length - 1]!) window.clearInterval(id);
    }, FRAME_MS);
    return () => window.clearInterval(id);
  }, [text, start]);

  return (
    <span className="flap">
      <span className="sr-only">{label ?? text}</span>
      {Array.from(shown).map((c, i) => (
        <span key={i} className={c === " " ? "flap-gap" : "flap-tile"} aria-hidden="true" style={{ animationDelay: `${start + i * 45}ms` }}>
          {c === " " ? " " : c}
        </span>
      ))}
    </span>
  );
}
