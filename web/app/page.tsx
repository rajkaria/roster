export default function Home() {
  return (
    <>
      <h1>Roster is an agent that runs performance reviews for a team&apos;s AI coding agents.</h1>
      <p className="lede">
        It reads every session your coding agents recorded with Entire and works out what each
        session cost, and whether its change survived, was reverted, or was reworked by a human.
      </p>
      {/* TODO: link target is a placeholder until our own review is published. */}
      <p>
        <a href="/r/_sample/_sample">See an example review (sample data) →</a>
      </p>
    </>
  );
}
