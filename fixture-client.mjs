export function fixtureClient(base, { fetch: request = globalThis.fetch } = {}) {
  const entries = [];
  let pending;
  return {
    log: async () => {
      if (!pending)
        pending = (async () => {
          const response = await request(new URL(`/log?since=${entries.length}`, base));
          if (!response.ok) throw new Error(`fixture.log: HTTP ${response.status}`);
          const batch = await response.json();
          if (batch.from !== entries.length || !Array.isArray(batch.entries))
            throw new Error('fixture.log: invalid append-only log response');
          entries.push(...batch.entries);
          return [...entries];
        })().finally(() => {
          pending = undefined;
        });
      return pending;
    },
    redirectSecret: async (registration) => {
      try {
        const response = await request(new URL('/redirect', base), {
          method: 'POST',
          body: JSON.stringify(registration),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
      } catch (error) {
        throw new Error(
          `redirectSecret fixture registration required: POST /redirect failed: ${error.message}`
        );
      }
    },
  };
}

export function prepareFixture(set, options) {
  const fixture =
    options.fixture ?? (options.fixtureBase ? fixtureClient(options.fixtureBase) : undefined);
  const needsRedirect = set.vectors.some(
    (vector) =>
      vector.id.startsWith('C2.redirect') || vector.trigger?.some((step) => step.redirectSecret)
  );
  if (!needsRedirect || typeof fixture?.redirectSecret === 'function' || !fixture?.log)
    return fixture;
  const control = fixtureClient(options.fixtureBase ?? fixture.origin ?? options.targets?.ordinary);
  return {
    ...fixture,
    log: (...args) => fixture.log(...args),
    redirectSecret: control.redirectSecret,
  };
}
