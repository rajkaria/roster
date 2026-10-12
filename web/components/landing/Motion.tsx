"use client";
// The landing page's one motion island. It arms every [data-reveal] element below the fold, then marks it
// [data-in] once it scrolls into view, and feeds the pointer position to [data-glow] cards. Without JavaScript,
// or with reduced motion, nothing is ever armed, so every element simply renders in its final state.
import { useEffect } from "react";

export function Motion() {
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const els = Array.from(document.querySelectorAll<HTMLElement>("[data-reveal]"));
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          (e.target as HTMLElement).dataset.in = "";
          io.unobserve(e.target);
        }
      },
      { rootMargin: "0px 0px -12% 0px", threshold: 0.12 },
    );
    for (const el of els) {
      // An element already on screen at load animates in right away; one below the fold waits for the scroll.
      el.dataset.armed = "";
      io.observe(el);
    }

    const onMove = (ev: PointerEvent) => {
      const card = (ev.target as Element | null)?.closest<HTMLElement>("[data-glow]");
      if (!card) return;
      const r = card.getBoundingClientRect();
      card.style.setProperty("--mx", `${ev.clientX - r.left}px`);
      card.style.setProperty("--my", `${ev.clientY - r.top}px`);
    };
    document.addEventListener("pointermove", onMove, { passive: true });
    return () => {
      io.disconnect();
      document.removeEventListener("pointermove", onMove);
    };
  }, []);
  return null;
}
