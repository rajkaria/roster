// A slow marquee of the run's numbers. The list is rendered twice for a seamless loop; the copy is hidden from
// screen readers so each fact is read once.
export function Ticker({ items }: { items: string[] }) {
  if (items.length === 0) return null;
  const row = (hidden: boolean) => (
    <ul className="ticker-row" aria-hidden={hidden || undefined}>
      {items.map((t, i) => (
        <li key={i}>{t}</li>
      ))}
    </ul>
  );
  return (
    <div className="ticker" role="region" aria-label="The run in numbers">
      <div className="ticker-track">
        {row(false)}
        {row(true)}
      </div>
    </div>
  );
}
