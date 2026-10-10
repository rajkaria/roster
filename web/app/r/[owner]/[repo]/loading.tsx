export default function Loading() {
  return (
    <div aria-busy="true" aria-label="Loading review">
      <span className="skel" style={{ width: "40%", height: 32, marginBottom: 20 }} />
      {[0, 1, 2].map((i) => (
        <span key={i} className="skel" style={{ marginBottom: 12 }} />
      ))}
    </div>
  );
}
