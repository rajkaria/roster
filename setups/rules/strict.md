# Strict rules (setup D, appended to the default rules)

1. Write the failing test first. Run it and watch it fail, then implement.
2. Never modify or delete existing tests unless the task explicitly asks you to.
3. Run the full suite (`bun test`) and the typecheck (`bun run typecheck`) before you finish. Never finish with a failing test.
4. Keep the change under 300 changed lines. If the task needs more, finish a working subset and list the rest.
