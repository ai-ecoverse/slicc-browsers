import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fixtureServer } from '../../fixture-server.mjs';
import { summary as driverSummary } from '../../guard-driver.mjs';
import {
  maskedId,
  maskedValue,
  normalizeHost,
  pickRawTarget,
  redactedInfo,
  redactionLeak,
  run,
} from '../../guard-runner.mjs';
import { origins } from './cdp-client.mjs';
import { explicitBrowser } from './explicit-attach-fake.mjs';
import { emulatedGuard } from './guard-emulator.mjs';

const set = JSON.parse(await readFile(new URL('../../guard-vectors.json', import.meta.url)));
const catalog = JSON.parse(await readFile(new URL('../../catalog.json', import.meta.url)));
const ids = ['C3.tab-attach.explicit', 'C3.tab-protected.explicit'];
const vectors = set.vectors.filter((vector) => ids.includes(vector.id));
const byId = Object.fromEntries(vectors.map((vector) => [vector.id, vector]));
const base = { explicitAttach: true, browserSession: true, discovery: true };
const modes = { 'browserContexts on': { browserContexts: true }, 'browserContexts off': {} };
const autoCaps = ['autoAttach', 'stockSetup', 'syntheticAutoAttach'];
const guarded = [
  'Target.setDiscoverTargets',
  'Target.getTargets',
  'Target.getTargetInfo',
  'Target.attachToTarget',
];
const flat = (list) => list.flatMap((step) => [step, ...flat(step.children ?? [])]);
const literal = (fixture) => ({
  seven: `http://127.0.0.7:${fixture.port}`,
  vault: `http://127.0.0.8:${fixture.port}`,
});

async function execute({
  mutant = {},
  guard = true,
  ids: only = ids,
  capabilities,
  fake,
  retarget = () => ({}),
  foreign = () => [],
} = {}) {
  const fixture = await fixtureServer();
  const targets = { ...origins(fixture), ...retarget(fixture) };
  const browser = explicitBrowser({ record: (url) => fixture.record(url), ...fake });
  const guarded = guard
    ? emulatedGuard(browser, {
        explicitAttach: mutant,
        protectedOrigins: catalog.protectedOrigins,
        extraOrigins: [targets.seven, targets.vault],
      })
    : { client: browser.client, stop: async () => {} };
  try {
    const foreignIds = [];
    for (const url of foreign(targets))
      foreignIds.push((await browser.unguarded.send('Target.createTarget', { url })).targetId);
    const execution = await run(
      {
        ...set,
        vectors: vectors.filter((vector) => only.includes(vector.id)),
        variants: { prompt: 0 },
      },
      {
        client: guarded.client,
        unguarded: browser.unguarded,
        fixture,
        targets,
        settleScale: 0.2,
        namedResultMs: 2000,
        capabilities,
      }
    );
    return { execution, browser, foreignIds, targets };
  } finally {
    await guarded.stop();
    await fixture.close();
  }
}

const legs = (row) => [row.control, row.guarded, row.live];
const tagsOf = (browser) =>
  browser.sent
    .filter((call) => call.method === 'Target.createTarget' && call.params.url)
    .map((call) => new URL(call.params.url).searchParams.get('n'))
    .filter(Boolean)
    .map((tag) => tag.toLowerCase());
const sources = {
  listRedacted: '(listed|relisted)',
  infoRedacted: 'info',
  eventsRedacted: 'Target\\.(targetCreated|targetInfoChanged|attachedToTarget)',
};
const redactionNotes = (row) =>
  (row.notes ?? []).filter((note) => /fails redaction|foreign page target/.test(note));
const shown = (row) => JSON.stringify({ legs: legs(row), why: row.why, errors: row.errors });

test('the explicit rows are gated on explicitAttach alone and never on auto-attach', () => {
  assert.equal(vectors.length, 2);
  assert.match(
    set.capabilities.explicitAttach,
    /refuses Target\.setAutoAttach and Target\.autoAttachRelated/
  );
  assert.match(set.capabilities.explicitAttach, /without stockSetup or syntheticAutoAttach/);
  assert.match(
    set.capabilities.explicitAttach,
    /popup's first document is not measured for init-script effects/
  );
  for (const vector of vectors) {
    assert.deepEqual(vector.requires, ['explicitAttach', 'browserSession', 'discovery']);
    assert.equal(vector.control.via, 'unguarded');
    const steps = flat([...vector.setup, ...vector.trigger]);
    for (const step of steps) {
      for (const cap of autoCaps) assert.ok(!(step.requires ?? []).includes(cap), vector.id);
      assert.ok(!['Target.setAutoAttach', 'Target.autoAttachRelated'].includes(step.cdp));
      assert.equal(step.children, undefined);
    }
    const guardedSteps = steps.filter((step) => step.cdp && step.via !== 'unguarded');
    for (const step of guardedSteps)
      assert.ok(
        step.session === 'child' || guarded.includes(step.cdp),
        `${vector.id} sends ${step.cdp} through the guarded client`
      );
    assert.ok(
      steps.every((step) => step.page === undefined),
      vector.id
    );
    const created = steps.filter((step) => step.cdp === 'Target.createTarget');
    assert.deepEqual(
      created.map((step) => [step.via, step.params.url]),
      [['unguarded', '{target}/doc?n={tag}']]
    );
    const discover = steps.find((step) => step.as === 'discover');
    assert.deepEqual(discover.params, { discover: true, filter: [{}] });
    assert.equal(discover.refusable, undefined);
    assert.equal(steps.find((step) => step.as === 'listed').refusable, undefined);
    const attach = steps.find((step) => step.bindSession);
    assert.equal(attach.cdp, 'Target.attachToTarget');
    assert.deepEqual(attach.params, { targetId: '{rawTarget}', flatten: true });
    assert.equal(attach.bindSession, 'child');
    assert.ok(steps.some((step) => step.rawTarget?.type === 'page'));
    for (const observation of Object.values(vector.observe))
      for (const name of observation.dependsOn ?? [])
        assert.ok(!['discover', 'listed'].includes(name));
  }
  const ordinary = byId['C3.tab-attach.explicit'];
  assert.deepEqual(ordinary.targets, ['ordinary']);
  assert.deepEqual(ordinary.expected, ordinary.control.expected);
  assert.equal(
    flat(ordinary.trigger).some((step) => step.refusable),
    false
  );
  for (const [name, value] of Object.entries({
    discovered: true,
    listed: true,
    attachSession: true,
    attachRefused: false,
    reachable: true,
    listRedacted: false,
  }))
    assert.equal(ordinary.expected[name], value, name);
  const protectedRow = byId['C3.tab-protected.explicit'];
  assert.deepEqual(protectedRow.targets, ['seven', 'vault']);
  const attach = flat(protectedRow.trigger).find((step) => step.bindSession);
  assert.deepEqual(attach.refusal, { match: '^slicc: refused', onlyProtected: true });
  const info = flat(protectedRow.trigger).find((step) => step.as === 'info');
  assert.equal(info.refusal.match, '^slicc: refused');
  assert.equal(protectedRow.expected.discovered, 'either');
  assert.equal(protectedRow.expected.listed, 'either');
  assert.equal(protectedRow.expected.attachSession, false);
  assert.equal(protectedRow.expected.attachRefused, true);
  assert.equal(protectedRow.expected.reachable, false);
  for (const name of ['infoRedacted', 'listRedacted', 'eventsRedacted'])
    assert.equal(protectedRow.expected[name], true, name);
  for (const name of ['discovered', 'listed', 'attachSession', 'reachable'])
    for (const vector of vectors)
      assert.equal(vector.control.expected[name], true, `${vector.id} ${name}`);
});

for (const [mode, extra] of Object.entries(modes)) {
  const capabilities = { ...base, ...extra };

  for (const redact of [false, true])
    test(`${mode}: a ${redact ? 'redacting' : 'hiding'} explicit guard passes both rows and nobody resumes a debugger`, async () => {
      const { execution, browser } = await execute({ mutant: { redact }, capabilities });
      assert.equal(execution.results.length, 3);
      for (const row of execution.results)
        assert.deepEqual(legs(row), ['pass', 'pass', 'pass'], shown(row));
      const report = execution.summary({ guard: 'explicit' });
      assert.equal(report.pass, true, report.line);
      assert.deepEqual(report.forged, []);
      assert.deepEqual(
        browser.sent.filter((call) => call.method === 'Runtime.runIfWaitingForDebugger'),
        []
      );
      assert.equal(
        browser.sent.some((call) => call.method === 'Target.setAutoAttach'),
        false
      );
      assert.deepEqual(
        browser.sent.filter(
          (call) =>
            call.connection === 'client' &&
            ['Target.createTarget', 'Target.closeTarget'].includes(call.method)
        ),
        []
      );
      const protectedRow = execution.results.find((row) => row.target === 'seven');
      assert.equal(protectedRow.observations.guarded.attachRefused, true);
      assert.equal(protectedRow.observations.guarded.listed, redact);
    });

  test(`${mode}: without a guard the protected row fails and the ordinary row passes`, async () => {
    const { execution } = await execute({ guard: false, capabilities });
    for (const row of execution.results) {
      assert.equal(row.control, 'pass', shown(row));
      assert.equal(row.guarded, row.target === 'ordinary' ? 'pass' : 'fail', shown(row));
    }
  });

  const failing = {
    leakList: { mutant: { leakList: true }, why: /listRedacted/ },
    leakEvents: { mutant: { leakEvents: true }, why: /eventsRedacted/ },
    leakInfo: { mutant: { leakInfo: true }, why: /infoRedacted/ },
    allowAttach: {
      mutant: { allowAttach: true },
      why: /attachSession: got true.*attachRefused: got false.*reachable: got true/,
    },
    allowAttachCut: { mutant: { allowAttach: true, cut: true }, why: /attachSession: got true/ },
    leakPath: {
      mutant: { redact: true, leak: 'path' },
      why: /infoRedacted.*listRedacted.*eventsRedacted/,
    },
    leakQuery: {
      mutant: { redact: true, leak: 'query' },
      why: /infoRedacted.*listRedacted.*eventsRedacted/,
    },
    leakTag: {
      mutant: { redact: true, leak: 'tag' },
      why: /infoRedacted.*listRedacted.*eventsRedacted/,
    },
  };
  for (const [name, { mutant, why }] of Object.entries(failing))
    test(`${mode}: mutant ${name} fails the protected row`, async () => {
      const { execution } = await execute({
        mutant,
        capabilities,
        ids: ['C3.tab-protected.explicit'],
      });
      for (const row of execution.results) {
        assert.equal(row.control, 'pass', shown(row));
        assert.equal(row.guarded, 'fail', shown(row));
        assert.match(row.why, why);
      }
      assert.equal(execution.summary({ guard: name }).pass, false);
    });

  const surrogates = {
    'surrogate ids with the path in the listed url': {
      mutant: { redact: true, surrogate: { list: 'url' } },
      why: /listRedacted: got false, want true/,
    },
    'surrogate ids with the path in the listed title': {
      mutant: { redact: true, surrogate: { list: 'title' } },
      why: /listRedacted: got false, want true/,
    },
    'surrogate ids with the path in the discovery events': {
      mutant: { redact: true, surrogate: { events: 'url' } },
      why: /eventsRedacted: got false, want true/,
    },
  };
  for (const [name, { mutant, why }] of Object.entries(surrogates))
    test(`${mode}: a guard that relabels protected targets with ${name} fails both protected rows`, async () => {
      const { execution } = await execute({
        mutant,
        capabilities,
        ids: ['C3.tab-protected.explicit'],
      });
      assert.deepEqual(
        execution.results.map((row) => row.target),
        ['seven', 'vault']
      );
      for (const row of execution.results) {
        assert.equal(row.control, 'pass', shown(row));
        assert.equal(row.guarded, 'fail', shown(row));
        assert.match(row.why, why);
      }
      assert.equal(execution.summary({ guard: 'surrogate' }).pass, false);
    });

  const disguises = {
    'a trailing-dot host and the path': { shape: 'dot' },
    'the host without its port and the path': { shape: 'port' },
    'an IPv4-mapped IPv6 host and the path': { shape: 'mapped', retarget: literal },
    'a data: url embedding {origin}/doc': { shape: 'data' },
    'a javascript: url embedding {origin}/doc': { shape: 'javascript' },
    'about:blank#/doc': { shape: 'fragment' },
    'about:blank#/doc?n={tag}': { shape: 'fragmentTag' },
    'about:blank#{host}/doc': { shape: 'fragmentHost' },
    'a default title host/path': { shape: 'hostPath' },
    'a default title host:port/path': { shape: 'hostPortPath' },
    'a default title host:port/path?query#fragment': { shape: 'defaultTitle' },
    'a title with leading whitespace': { shape: 'spacedTitle' },
    'a filesystem: url embedding {origin}/persistent/doc': { shape: 'filesystem' },
    'another host url embedding {origin}/doc in its query': { shape: 'embeddedQuery' },
    'another host url embedding {origin}/doc in its fragment': { shape: 'embeddedFragment' },
    'a title with a bidi mark before the host': { shape: 'bidiTitle' },
    'a scheme-relative url //host/doc': { shape: 'relativeUrl' },
    'another host url embedding //host/doc in its query': { shape: 'relativeEmbedded' },
    'a title user@host/doc': { shape: 'userinfoTitle' },
    'a title with a fullwidth solidus before the path': { shape: 'fullwidthTitle' },
  };
  for (const [name, { shape, retarget }] of Object.entries(disguises))
    test(`${mode}: a guard that leaks ${name} under surrogate ids fails both protected rows`, async () => {
      const { execution } = await execute({
        mutant: { redact: true, surrogate: { list: shape, events: shape, info: shape } },
        capabilities,
        ids: ['C3.tab-protected.explicit'],
        retarget,
      });
      assert.deepEqual(
        execution.results.map((row) => row.target),
        ['seven', 'vault']
      );
      for (const row of execution.results) {
        assert.equal(row.control, 'pass', shown(row));
        assert.equal(row.guarded, 'fail', shown(row));
        for (const observation of ['infoRedacted', 'listRedacted', 'eventsRedacted'])
          assert.equal(
            row.observations.guarded[observation],
            false,
            `${observation} ${shown(row)}`
          );
      }
      assert.equal(execution.summary({ guard: shape }).pass, false);
    });

  test(`${mode}: a guard that hides the target, or redacts every protected entry to its origin under any id, still passes`, async () => {
    for (const retarget of [undefined, literal])
      for (const mutant of [
        {},
        { redact: true },
        { redact: true, surrogate: { list: 'bare', events: 'bare', info: 'bare' } },
        { redact: true, surrogate: { list: 'sentence', events: 'sentence', info: 'sentence' } },
        {
          redact: true,
          surrogate: { list: 'ordinaryTab', events: 'ordinaryTab', info: 'ordinaryTab' },
        },
        {
          redact: true,
          surrogate: { list: 'embeddedOrigin', events: 'embeddedOrigin', info: 'embeddedOrigin' },
        },
        ...['relativeBare', 'userinfoBare', 'wordTitle', 'relativeOther', 'fullwidthOrdinary'].map(
          (shape) => ({ redact: true, surrogate: { list: shape, events: shape, info: shape } })
        ),
      ]) {
        const { execution } = await execute({
          mutant,
          capabilities,
          ids: ['C3.tab-protected.explicit'],
          retarget,
        });
        for (const row of execution.results)
          assert.deepEqual(
            legs(row),
            ['pass', 'pass', 'pass'],
            `${JSON.stringify(mutant)} ${shown(row)}`
          );
      }
  });

  const diagnosed = {
    'host token': { shape: 'hostPortPath', field: 'title', shows: /\+ 4 chars/ },
    'normalised host': { shape: 'dot', field: 'url', shows: /\+ path\(4 chars\)/ },
    'filesystem: unwrapped': {
      shape: 'filesystem',
      field: 'url',
      shows: /filesystem:\(\d+ chars\)/,
    },
    'embedded url with path': {
      shape: 'embeddedQuery',
      field: 'url',
      shows: /http:\/\/ordinary\.test \+ query\(\d+ chars\)/,
    },
    'about: non-bare': { shape: 'fragment', field: 'url', shows: /about:\(16 chars\)/ },
    'about: non-bare with the tag': {
      rule: 'about: non-bare',
      shape: 'fragmentTag',
      field: 'url',
      shows: /^about:\(\d+ chars\)$/,
    },
    'about: non-bare with the host': {
      rule: 'about: non-bare',
      shape: 'fragmentHost',
      field: 'url',
      shows: /^about:\(\d+ chars\)$/,
    },
    tag: { shape: 'tagged', field: 'title', shows: /^text\(\d+ chars\)$/ },
    'scheme-relative url': { shape: 'relativeUrl', field: 'url', shows: /^text\(\d+ chars\)$/ },
  };
  for (const [name, { rule = name, shape, field, shows }] of Object.entries(diagnosed))
    test(`${mode}: the notes name the entry, field and rule (${name}) of a leak and never the tag`, async () => {
      const { execution, browser } = await execute({
        mutant: { redact: true, surrogate: { list: shape, events: shape, info: shape } },
        capabilities,
        ids: ['C3.tab-protected.explicit'],
      });
      const tags = tagsOf(browser);
      assert.ok(tags.length >= 2);
      for (const row of execution.results) {
        assert.equal(row.guarded, 'fail', shown(row));
        for (const [observation, source] of Object.entries(sources)) {
          const pattern = new RegExp(
            `^guarded ${observation}: ${source} entry surrogate \\(id unknown to the observer\\) ${field} (?<value>.+) fails redaction: ${rule}$`
          );
          const note = row.notes.find((entry) => pattern.test(entry));
          assert.ok(note, `${observation} ${JSON.stringify(row.notes)}`);
          assert.match(pattern.exec(note).groups.value, shows, note);
        }
        for (const note of row.notes ?? [])
          for (const tag of tags) assert.ok(!note.toLowerCase().includes(tag), note);
      }
    });

  test(`${mode}: a foreign tab embedding the protected url with a path is a leak the notes attribute to that foreign target`, async () => {
    const { execution, foreignIds, targets } = await execute({
      mutant: { redact: true },
      capabilities,
      ids: ['C3.tab-protected.explicit'],
      foreign: (t) => [`${t.ordinary}/?u=${t.seven}/doc`, `${t.ordinary}/#u=${t.vault}/doc`],
    });
    const ordinary = new URL(targets.ordinary).origin;
    assert.equal(foreignIds.length, 2);
    for (const [index, row] of execution.results.entries()) {
      const id = foreignIds[index];
      assert.equal(row.control, 'pass', shown(row));
      assert.equal(row.guarded, 'fail', shown(row));
      assert.equal(row.observations.guarded.listRedacted, false, shown(row));
      assert.equal(row.observations.guarded.eventsRedacted, false, shown(row));
      assert.equal(row.observations.guarded.infoRedacted, true, shown(row));
      const notes = redactionNotes(row);
      assert.ok(
        notes.some((note) =>
          note.startsWith(
            `guarded rawTarget: 2 foreign page target(s) at the first listing: ${foreignIds[0]} ${ordinary}, ${foreignIds[1]} ${ordinary}`
          )
        ),
        JSON.stringify(notes)
      );
      for (const [observation, source] of Object.entries(sources).filter(
        ([name]) => name !== 'infoRedacted'
      ))
        assert.ok(
          notes.some((note) =>
            new RegExp(
              `^guarded ${observation}: ${source} entry ${id} \\(foreign target\\) url ${ordinary.replaceAll('.', '\\.')} \\+ (query|fragment)\\(\\d+ chars\\) fails redaction: embedded url with path$`
            ).test(note)
          ),
          `${observation} ${JSON.stringify(notes)}`
        );
      assert.ok(
        !notes.some(
          (note) =>
            note.startsWith('guarded ') &&
            note.includes(foreignIds[1 - index]) &&
            /fails redaction/.test(note)
        ),
        JSON.stringify(notes)
      );
    }
  });

  test(`${mode}: an unrelated tab at about:blank#settings is no leak and both protected rows pass`, async () => {
    const { execution, browser, foreignIds, targets } = await execute({
      mutant: { redact: true },
      capabilities,
      ids: ['C3.tab-protected.explicit'],
      foreign: () => ['about:blank#settings'],
    });
    const [id] = foreignIds;
    const { targetInfo } = await browser.unguarded.send('Target.getTargetInfo', { targetId: id });
    assert.equal(targetInfo.url, 'about:blank#settings');
    const tags = tagsOf(browser);
    assert.deepEqual(
      execution.results.map((row) => row.target),
      ['seven', 'vault']
    );
    for (const [index, row] of execution.results.entries()) {
      assert.deepEqual(legs(row), ['pass', 'pass', 'pass'], shown(row));
      for (const observation of ['infoRedacted', 'listRedacted', 'eventsRedacted'])
        assert.equal(row.observations.guarded[observation], true, `${observation} ${shown(row)}`);
      assert.ok(
        row.notes.some(
          (note) =>
            note.startsWith('guarded rawTarget: ') &&
            /foreign page target\(s\) at the first listing/.test(note) &&
            note.includes(id)
        ),
        shown(row)
      );
      assert.deepEqual(
        row.notes.filter((note) => note.startsWith('guarded ') && /fails redaction/.test(note)),
        [],
        shown(row)
      );
      const scope = {
        targetId: 'RAW',
        origin: new URL(targets[row.target]).origin,
        path: '/doc',
        tag: tags[index],
      };
      assert.equal(redactionLeak(targetInfo, scope), undefined);
      assert.deepEqual(redactionLeak(targetInfo, scope, { aboutContent: false }), {
        field: 'url',
        rule: 'about: non-bare',
      });
    }
    assert.equal(execution.summary({ guard: 'unrelated' }).pass, true);
  });

  test(`${mode}: the explicit rows open their tabs ${extra.browserContexts ? 'in a browserContext of their own, disposed at the end' : 'in the default context and report the foreign pages they found'}`, async () => {
    const { execution, browser } = await execute({ mutant: { redact: true }, capabilities });
    for (const row of execution.results)
      assert.deepEqual(legs(row), ['pass', 'pass', 'pass'], shown(row));
    const observer = browser.sent.filter((call) => call.connection === 'unguarded');
    const created = observer.filter((call) => call.method === 'Target.createTarget');
    const contexts = observer.filter((call) => call.method === 'Target.createBrowserContext');
    const disposed = observer
      .filter((call) => call.method === 'Target.disposeBrowserContext')
      .map((call) => call.params.browserContextId);
    assert.equal(created.length, 6);
    if (extra.browserContexts) {
      assert.equal(contexts.length, 6);
      assert.equal(new Set(created.map((call) => call.params.browserContextId)).size, 6);
      for (const call of created) assert.ok(disposed.includes(call.params.browserContextId));
    } else {
      assert.equal(contexts.length, 0);
      for (const call of created) assert.equal(call.params.browserContextId, undefined);
    }
    for (const row of execution.results)
      assert.ok(
        row.notes.some((note) =>
          /^(control|guarded) rawTarget: \d+ foreign page target\(s\) at the first listing/.test(
            note
          )
        ),
        shown(row)
      );
  });

  test(`${mode}: mutant dropAttach is incomplete on both rows, never a pass`, async () => {
    const { execution } = await execute({ mutant: { dropAttach: true }, capabilities });
    for (const row of execution.results) {
      assert.equal(row.control, 'pass', shown(row));
      assert.equal(row.guarded, 'incomplete', shown(row));
      assert.ok(row.incomplete.some((reason) => reason === 'guarded attach: no answer'));
      assert.notEqual(row.observations.guarded.attachRefused, true);
    }
  });

  test(`${mode}: mutant dropDiscover leaves both rows incomplete and the run still returns`, async () => {
    const { execution } = await execute({ mutant: { dropDiscover: true }, capabilities });
    for (const row of execution.results) {
      assert.equal(row.control, 'pass', shown(row));
      assert.equal(row.guarded, 'incomplete', shown(row));
      assert.equal(row.observations.guarded.discovered, 'incomplete', shown(row));
      assert.ok(row.incomplete.includes('guarded discover: no answer'), shown(row));
    }
  });

  test(`${mode}: mutant failList is unread, never vacuously redacted`, async () => {
    const { execution } = await execute({
      mutant: { failList: true },
      capabilities,
      ids: ['C3.tab-protected.explicit'],
    });
    for (const row of execution.results) {
      assert.notEqual(row.guarded, 'pass', shown(row));
      assert.equal(row.observations.guarded.listRedacted, 'incomplete', shown(row));
      assert.equal(row.observations.guarded.admitted, false, shown(row));
      assert.ok(row.incomplete.includes('guarded redacted: listed gave no reply to read'));
    }
  });

  test(`${mode}: mutant cut detaches the ordinary child and fails with cut true`, async () => {
    const { execution } = await execute({
      mutant: { cut: true },
      capabilities,
      ids: ['C3.tab-attach.explicit'],
    });
    const [row] = execution.results;
    assert.notEqual(row.guarded, 'pass', shown(row));
    assert.equal(row.observations.guarded.cut, true);
    assert.equal(row.observations.guarded.attachSession, true);
    assert.equal(row.observations.control.cut, false);
  });

  test(`${mode}: mutant refuseCreate, a guard refusing every Target.createTarget, changes no explicit verdict`, async () => {
    const { execution } = await execute({ mutant: { refuseCreate: true }, capabilities });
    for (const row of execution.results)
      assert.deepEqual(legs(row), ['pass', 'pass', 'pass'], shown(row));
  });

  test(`${mode}: a target lost on the observer side is incomplete, not redacted`, async () => {
    const { execution, browser } = await execute({ capabilities, fake: { loseRaw: true } });
    assert.equal(execution.results.length, 3);
    for (const row of execution.results) {
      assert.deepEqual([row.control, row.guarded], ['incomplete', 'incomplete'], shown(row));
      assert.deepEqual(row.errors, [], shown(row));
      for (const side of ['control', 'guarded']) {
        assert.ok(
          row.incomplete.some((reason) =>
            new RegExp(
              `^${side} rawTarget: the observer lost \\S+ before the guarded probes ended$`
            ).test(reason)
          ),
          shown(row)
        );
        for (const name of ['listed', 'discovered', 'attachSession', 'reachable', 'listRedacted'])
          assert.equal(row.observations[side][name], 'incomplete', `${side} ${name} ${shown(row)}`);
      }
    }
    const protectedRow = execution.results.find((row) => row.target === 'seven');
    for (const name of ['infoRedacted', 'eventsRedacted'])
      assert.equal(protectedRow.observations.guarded[name], 'incomplete', name);
    assert.ok(
      browser.sent.some(
        (call) => call.connection === 'client' && call.method === 'Target.getTargets'
      )
    );
    assert.equal(execution.summary({ guard: 'lost' }).pass, false);
  });

  test(`${mode}: an empty guarded listing counts as hidden only when the same-job control listed the target`, async () => {
    const { execution } = await execute({
      capabilities,
      ids: ['C3.tab-protected.explicit'],
      fake: { listBlind: true },
    });
    for (const row of execution.results) {
      assert.equal(row.control, 'incomplete', shown(row));
      assert.notEqual(row.guarded, 'pass', shown(row));
      assert.equal(row.observations.guarded.listRedacted, true, shown(row));
      assert.equal(row.observations.control.listed, 'incomplete', shown(row));
      assert.ok(
        row.incomplete.some((reason) => reason.startsWith('control listed: ')),
        shown(row)
      );
      assert.equal(row.observations.control.listRedacted, 'incomplete', shown(row));
    }
    assert.equal(execution.summary({ guard: 'blind' }).pass, false);
  });

  test(`${mode}: an observer that cannot find the raw target leaves the rows incomplete, never a pass`, async () => {
    const { execution, browser } = await execute({ capabilities, fake: { observerBlind: true } });
    for (const row of execution.results) {
      assert.notEqual(row.guarded, 'pass', shown(row));
      assert.notEqual(row.control, 'pass', shown(row));
      assert.ok(
        row.incomplete.some((reason) => /rawTarget: the observer found no page at/.test(reason)),
        shown(row)
      );
      assert.equal(row.errors.length, 0, shown(row));
    }
    assert.deepEqual(
      browser.sent.filter(
        (call) =>
          call.connection === 'client' &&
          ['Target.getTargetInfo', 'Target.attachToTarget'].includes(call.method)
      ),
      []
    );
  });

  test(`${mode}: a control leg that cannot attach is incomplete, never a pass`, async () => {
    const { execution } = await execute({ capabilities, fake: { unguardedAttach: false } });
    for (const row of execution.results) {
      assert.equal(row.control, 'incomplete', shown(row));
      assert.ok(
        row.incomplete.some((reason) =>
          /control attachSession: the unguarded control did not show it/.test(reason)
        ),
        shown(row)
      );
    }
  });
}

test('every protected-row mutant, alone or combined, never passes', async () => {
  const mutants = [
    { leakList: true },
    { leakEvents: true },
    { leakInfo: true },
    { allowAttach: true },
    { dropAttach: true },
    { dropDiscover: true },
    { failList: true },
    { refuseCreate: true, allowAttach: true },
    { allowAttach: true, cut: true },
    { redact: true, leak: 'path' },
    { redact: true, leak: 'query' },
    { redact: true, leak: 'tag' },
    { redact: true, leakList: true, leakEvents: true },
    { redact: true, surrogate: { list: 'url' } },
    { redact: true, surrogate: { list: 'title' } },
    { redact: true, surrogate: { events: 'url' } },
  ];
  for (const mutant of mutants) {
    const { execution } = await execute({
      mutant,
      capabilities: base,
      ids: ['C3.tab-protected.explicit'],
    });
    for (const row of execution.results)
      assert.notEqual(row.guarded, 'pass', JSON.stringify(mutant));
    assert.equal(execution.summary({ guard: 'mutant' }).pass, false, JSON.stringify(mutant));
  }
});

test('an attachedToTarget for the raw target on any session counts as attached', async () => {
  const fixture = await fixtureServer();
  const targets = origins(fixture);
  const browser = explicitBrowser({ record: (url) => fixture.record(url) });
  const guard = emulatedGuard(browser, {
    explicitAttach: true,
    protectedOrigins: catalog.protectedOrigins,
    extraOrigins: [targets.seven, targets.vault],
  });
  const client = {
    ...guard.client,
    send: async (method, params, sessionId) => {
      const reply = await guard.client.send(method, params, sessionId);
      if (method !== 'Target.attachToTarget') return reply;
      const { targetInfo } = await browser.unguarded.send('Target.getTargetInfo', params);
      return targetInfo.url === 'about:blank' ? reply : {};
    },
  };
  try {
    const execution = await run(
      { ...set, vectors: [byId['C3.tab-attach.explicit']], variants: { prompt: 0 } },
      {
        client,
        unguarded: browser.unguarded,
        fixture,
        targets,
        settleScale: 0.2,
        capabilities: base,
      }
    );
    const [row] = execution.results;
    assert.equal(row.observations.guarded.attachSession, true, shown(row));
    assert.equal(row.observations.guarded.reachable, false, shown(row));
    assert.notEqual(row.guarded, 'pass');
  } finally {
    await guard.stop();
    await fixture.close();
  }
});

test('auto-attach guards skip the explicit rows as not-supported:explicitAttach, never pass them', async () => {
  const client = { events: [], send: async () => assert.fail('a skipped row sent CDP') };
  const fixture = await fixtureServer();
  try {
    for (const capabilities of [
      { autoAttach: true, browserSession: true, discovery: true, browserContexts: true },
      { autoAttach: true, browserSession: true, stockSetup: true, syntheticAutoAttach: true },
    ]) {
      const execution = await run(
        { ...set, vectors, variants: { prompt: 0 } },
        { client, unguarded: client, fixture, targets: origins(fixture), capabilities }
      );
      for (const row of execution.results) {
        assert.deepEqual(legs(row), ['skip', 'skip', 'skip']);
        assert.equal(row.reason, 'not-supported:explicitAttach');
      }
      const report = execution.summary({ guard: 'auto' });
      assert.deepEqual(report.forged, []);
      assert.equal(report.pass, true);
      assert.match(report.line, / skips 3 \(not-supported:explicitAttach=3\)$/);
    }
  } finally {
    await fixture.close();
  }
});

test('a run declaring explicitAttach with stockSetup or syntheticAutoAttach is rejected', async () => {
  const client = { events: [], send: async () => assert.fail('a rejected run sent CDP') };
  const fixture = { log: async () => [] };
  for (const [extra, both] of [
    [{ stockSetup: true }, 'stockSetup'],
    [{ syntheticAutoAttach: true }, 'syntheticAutoAttach'],
    [{ stockSetup: true, syntheticAutoAttach: true }, 'stockSetup and syntheticAutoAttach'],
  ]) {
    await assert.rejects(
      run({ ...set, vectors }, { client, fixture, capabilities: { ...base, ...extra } }),
      new RegExp(`explicitAttach excludes ${both} in one run`)
    );
    await assert.rejects(
      run(
        { ...set, vectors },
        { client, fixture, capabilities: Object.keys({ ...base, ...extra }) }
      ),
      /explicitAttach excludes/
    );
  }
});

const one = { ...set, vectors };
const skipped = (reason) =>
  Object.keys(set.variants).flatMap((variant) =>
    vectors.flatMap((vector) =>
      vector.targets.map((target) => ({
        id: vector.id,
        target,
        variant,
        transport: 'cdp',
        control: 'skip',
        guarded: 'skip',
        live: 'skip',
        reason,
      }))
    )
  );
const report = (results, capabilities) =>
  driverSummary({ guard: 'reference', sha: 'test', set: one, results, capabilities });

test('a genuine not-supported:explicitAttach or browserSession skip of the explicit rows is not forged', () => {
  const genuine = report(skipped('not-supported:explicitAttach'), ['autoAttach', 'browserSession']);
  assert.deepEqual(genuine.forged, []);
  assert.equal(genuine.pass, true);
  assert.deepEqual(report(skipped('not-supported:discovery'), ['explicitAttach']).forged, []);
});

test('a skip naming autoAttach, stockSetup or syntheticAutoAttach on an explicitAttach row is forged', () => {
  for (const cap of autoCaps)
    for (const capabilities of [['explicitAttach', 'browserSession'], [], ['autoAttach']]) {
      const forged = report(skipped(`not-supported:${cap}`), capabilities);
      assert.equal(forged.pass, false, cap);
      assert.equal(forged.forged.length, 6, cap);
      assert.ok(
        forged.forged.every((row) =>
          row.why.includes(`not-supported:${cap} on an explicitAttach row`)
        )
      );
    }
});

test('not-supported:explicitAttach is forged when the run declared explicitAttach', () => {
  for (const capabilities of [{ explicitAttach: true }, ['explicitAttach', 'discovery']]) {
    const declared = report(skipped('not-supported:explicitAttach'), capabilities);
    assert.equal(declared.pass, false);
    assert.equal(declared.forged.length, 6);
    assert.ok(
      declared.forged.every((row) =>
        row.why.includes('not-supported:explicitAttach while the run declared explicitAttach')
      )
    );
  }
});

test('explicit rows whose redaction observations are reported not-supported are forged', () => {
  const hollow = vectors.flatMap((vector) =>
    Object.keys(set.variants).flatMap((variant) =>
      vector.targets.map((target) => ({
        id: vector.id,
        target,
        variant,
        transport: 'cdp',
        control: 'pass',
        guarded: 'pass',
        live: 'pass',
        notSupported: Object.keys(vector.observe).filter((name) => /Redacted$/.test(name)),
      }))
    )
  );
  const unmeasured = report(hollow, base);
  assert.equal(unmeasured.pass, false);
  assert.equal(unmeasured.forged.length, hollow.length);
  assert.ok(
    unmeasured.forged.every((row) =>
      /not-supported:\w+Redacted while the observation should run/.test(row.why)
    )
  );
});

const seven = { targetId: 'RAW', origin: 'http://seven.test:1', path: '/doc', tag: 'guard-Tag' };
const literalScope = {
  targetId: 'RAW',
  origin: 'http://127.0.0.7:1',
  path: '/doc',
  tag: 'guard-Tag',
};
const v6 = { targetId: 'RAW', origin: 'http://[::1]:1', path: '/doc', tag: 'guard-Tag' };
const leaks = [
  [seven, 'RAW', 'http://seven.test:1', 'http://seven.test:1', false],
  [seven, 'RAW', '', undefined, false],
  [seven, 'RAW', 'about:blank', 'about:blank', false],
  [seven, 'RAW', 'http://seven.test:1/doc', 'http://seven.test:1', true],
  [seven, 'RAW', 'http://seven.test:1', 'doc', true],
  [seven, 'RAW', 'about:blank#/doc', '', true],
  [seven, 'OTHER', 'http://ordinary.test/doc', 'doc', false],
  [seven, 'OTHER', 'http://ordinary.test/doc?n=GUARD-tag', 'doc', true],
  [seven, 'OTHER', 'http://ordinary.test/', 'x%2567uard-tag', true],
  [seven, 'OTHER', 'http://ordinary.test/%E0%A4%A', 'doc', false],
  [seven, 'OTHER', 'http://ordinary.test/', 'x%67uard-tag%E0%A4%A', true],
  [seven, 'OTHER', 'http://ordinary.test/?q=%47UARD-%54AG', 'doc', true],
  [seven, 'OTHER', 'http://ordinary.test/?q=%2547uard%252Dtag%FF', 'doc', true],
  [seven, 'OTHER', 'http://ordinary.test/%E2%82%AC%FF', 'guard', false],
  [seven, 'surrogate', 'http://seven.test:1/doc', 'doc', true],
  [seven, 'surrogate', 'http://seven.test:1', 'http://seven.test:1/doc', true],
  [seven, 'surrogate', 'http://seven.test:1', 'doc', true],
  [seven, 'surrogate', '', 'seven.test:1/doc', true],
  [seven, 'surrogate', 'http://SEVEN.test:1/%64oc', 'x', true],
  [seven, 'surrogate', 'blob:http://seven.test:1/uuid', '', true],
  [seven, 'surrogate', 'view-source:view-source:http://seven.test:1/doc', '', true],
  [seven, 'surrogate', 'http://seven.test:1', 'http://seven.test:1', false],
  [seven, 'surrogate', 'about:blank', '', false],
  [seven, 'surrogate', 'http://ordinary.test/doc', 'doc', false],
  [seven, 'surrogate', 'http://seven.test.:1/doc', '', true],
  [seven, 'surrogate', 'http://seven.test/doc', '', true],
  [seven, 'surrogate', 'http://seven.test:2/doc', 'doc', true],
  [seven, 'surrogate', 'HTTP://Seven.Test.:80/doc', '', true],
  [seven, 'surrogate', 'https://seven.test:443/doc', '', true],
  [seven, 'surrogate', '', 'seven.test./doc', true],
  [seven, 'surrogate', 'http://seven.test.:1', 'http://seven.test.:1', true],
  [seven, 'surrogate', 'http://xseven.test:1/doc', '', false],
  [seven, 'surrogate', 'http://seven.test.example:1/doc', '', false],
  [seven, 'surrogate', '', 'seven.testing/doc', false],
  [seven, 'surrogate', '', 'seven.test:1234-example', false],
  [seven, 'surrogate', '', 'seven.test-example/doc', false],
  [seven, 'surrogate', '', 'a page about seven.test', false],
  [seven, 'surrogate', '', 'a page about seven.test:1/doc', false],
  [seven, 'surrogate', '', 'seven.test:abc/doc', false],
  [seven, 'surrogate', '', 'seven.test/doc', true],
  [seven, 'surrogate', '', 'seven.test:1234/doc', true],
  [seven, 'surrogate', '', 'seven.test:1/doc?q=1#top', true],
  [seven, 'surrogate', '', 'Seven.Test:1/doc#top', true],
  [seven, 'surrogate', '', 'seven.test?q', true],
  [seven, 'surrogate', '', 'seven.test:1#top', true],
  [seven, 'surrogate', '', 'seven.test docs', true],
  [seven, 'surrogate', 'about:blank', 'seven.test:1/doc?q=1#top', true],
  [literalScope, 'surrogate', 'http://[::ffff:127.0.0.7]:1/doc', '', true],
  [literalScope, 'surrogate', 'http://[0:0:0:0:0:ffff:7f00:7]/doc', '', true],
  [literalScope, 'surrogate', 'http://0x7f.0.0.7:1/doc', '', true],
  [literalScope, 'surrogate', 'http://2130706439/doc', '', true],
  [literalScope, 'surrogate', 'http://[::ffff:127.0.0.8]:1/doc', '', false],
  [v6, 'surrogate', 'http://[0:0::1]/doc', '', true],
  [v6, 'surrogate', 'http://[::2]:1/doc', '', false],
  [seven, 'surrogate', 'data:text/plain,http://seven.test:1/doc', '', true],
  [seven, 'surrogate', 'data:text/html,%3Ca%20href%3Dhttp://seven.test:1/doc%3E', '', true],
  [seven, 'surrogate', 'data:,seven.test/doc', '', true],
  [seven, 'surrogate', 'javascript:"http://seven.test:1/doc"', '', true],
  [seven, 'surrogate', 'javascript:alert(%22http://seven.test.:1/doc%22)', '', true],
  [seven, 'surrogate', 'view-source:data:,http://seven.test/doc', '', true],
  [seven, 'surrogate', 'data:text/plain,http://ordinary.test/doc', '', false],
  [seven, 'surrogate', 'javascript:void(0)', '', false],
  [seven, 'surrogate', 'about:blank#/doc', '', true],
  [seven, 'surrogate', 'about:blank?doc', '', false],
  [seven, 'surrogate', 'about:blank#doc', '', false],
  [seven, 'surrogate', 'about:blank/doc', '', true],
  [seven, 'surrogate', '', 'about:blank#/doc', true],
  [seven, 'surrogate', 'about:blank', '/doc', false],
  [seven, 'surrogate', 'about:blank', 'about:blank', false],
  [seven, 'OTHER', 'about:blank#settings', 'about:blank#settings', false],
  [seven, 'OTHER', 'about:blank#settings', 'Settings', false],
  [seven, 'OTHER', 'about:blank?x=1', 'about:blank?x=1', false],
  [seven, 'OTHER', 'about:srcdoc', 'about:srcdoc', false],
  [seven, 'OTHER', 'about:blank#other.test/doc', 'an ordinary page', false],
  [seven, 'surrogate', 'about:blank#settings', '', false],
  [seven, 'surrogate', 'about:blank?x=1', '', false],
  [seven, 'surrogate', 'about:srcdoc', '', false],
  [seven, 'surrogate', 'about:blank#other.test/doc', '', false],
  [seven, 'surrogate', '', 'about:blank#settings', false],
  [seven, 'surrogate', 'about:blank#docs', '', false],
  [seven, 'RAW', 'about:blank#settings', '', true],
  [seven, 'RAW', 'about:srcdoc', 'Settings', true],
  [seven, 'OTHER', 'about:blank#/doc?n=guard-tag', '', true],
  [seven, 'surrogate', 'about:blank#/doc?n=guard-tag', '', true],
  [seven, 'surrogate', 'about:blank#seven.test/doc', '', true],
  [seven, 'surrogate', 'about:blank#Seven.Test.:1', '', true],
  [seven, 'surrogate', 'about:blank#n=x-GUARD-tag', '', true],
  [seven, 'surrogate', 'about:blank#%2Fdoc', '', true],
  [seven, 'surrogate', 'about:blank#u=/DOC', '', true],
  [seven, 'surrogate', 'about:blank\uff03\uff0fdoc', '', true],
  [seven, 'surrogate', 'about:blank#\uff53\uff45\uff56\uff45\uff4e.test/x', '', true],
  [seven, 'surrogate', '', 'about:blank#seven.test:1', true],
  [seven, 'surrogate', 'about:blank#settings', 'seven.test:1/doc', true],
  [seven, 'surrogate', 'about:blank#settings', 'http://seven.test:1', true],
  [seven, 'surrogate', 'about:blank#settings?u=https://seven.test/doc', '', true],
  [{ ...seven, path: '/report' }, 'surrogate', 'about:blank#/doc', '', false],
  [{ ...seven, path: '/report' }, 'surrogate', 'about:blank#/report', '', true],
  [seven, 'surrogate', '', ' seven.test:1234/doc', true],
  [seven, 'surrogate', '', '\tseven.test/doc', true],
  [seven, 'surrogate', '', '\u0000seven.test:1/doc?q', true],
  [seven, 'surrogate', '', '\n\u0085\u00a0seven.test/doc', true],
  [seven, 'surrogate', '', ' a page about seven.test', false],
  [seven, 'surrogate', '', '\t', false],
  [seven, 'surrogate', 'filesystem:http://seven.test:1/persistent/doc', '', true],
  [seven, 'surrogate', 'filesystem:filesystem:http://seven.test:1/doc', '', true],
  [seven, 'surrogate', 'view-source:filesystem:http://seven.test:1/persistent/doc', '', true],
  [seven, 'surrogate', 'filesystem:http://seven.test:1', 'doc', true],
  [seven, 'surrogate', 'filesystem:http://seven.test:1', '', false],
  [seven, 'RAW', 'filesystem:http://seven.test:1', 'http://seven.test:1', false],
  [seven, 'surrogate', 'filesystem:http://ordinary.test/persistent/doc', '', false],
  [seven, 'surrogate', 'http://ordinary.test/?u=https://seven.test/doc', '', true],
  [seven, 'surrogate', 'http://ordinary.test/#u=https://seven.test/doc', '', true],
  [seven, 'surrogate', '', 'ordinary page https://seven.test/doc', true],
  [seven, 'surrogate', 'http://ordinary.test/?u=https%3A%2F%2Fseven.test%2Fdoc', '', true],
  [seven, 'surrogate', 'http://ordinary.test/?u=https%253A%252F%252Fseven.test%252Fdoc', '', true],
  [seven, 'surrogate', 'http://ordinary.test/?u=https://Seven.Test.:443/doc&x=1', '', true],
  [seven, 'surrogate', 'http://ordinary.test/?u=https://seven.test?q=1', '', true],
  [seven, 'surrogate', 'http://ordinary.test/?u=https://seven.test#top', '', true],
  [seven, 'surrogate', 'http://ordinary.test/redirect/https://seven.test/doc', '', true],
  [seven, 'surrogate', 'http://ordinary.test/?u=https://seven.test', '', false],
  [seven, 'surrogate', 'http://ordinary.test/?u=https://seven.test/', '', false],
  [seven, 'surrogate', 'http://ordinary.test/#u=https%3A%2F%2Fseven.test%2F&x=1', '', false],
  [seven, 'surrogate', '', 'ordinary page https://seven.test', false],
  [seven, 'surrogate', 'http://ordinary.test/?u=https://seven.testing/doc', '', false],
  [seven, 'surrogate', 'http://ordinary.test/?u=https://ordinary.example/doc', '', false],
  [seven, 'OTHER', 'http://ordinary.test/?u=http://seven.test:1/', 'doc', false],
  [seven, 'surrogate', '', '\u200eseven.test:1/doc', true],
  [seven, 'surrogate', '', '\u200fseven.test:1/doc', true],
  [seven, 'surrogate', '', '\u200dseven.test:1/doc', true],
  [seven, 'surrogate', '', '\u0301seven.test:1/doc', true],
  [seven, 'surrogate', '', '\u200f\u0301 seven.test:1/doc', true],
  [seven, 'surrogate', '//seven.test/doc', '', true],
  [seven, 'surrogate', 'http://ordinary.test/?u=//seven.test/doc', '', true],
  [seven, 'surrogate', '', '//seven.test:1/doc', true],
  [seven, 'surrogate', '', 'user@seven.test:1/doc', true],
  [seven, 'surrogate', '', 'user:pw@seven.test:1/doc', true],
  [seven, 'surrogate', '', 'seven.test:1\uff0fdoc', true],
  [seven, 'surrogate', '', 'seven.test:1\uff1fq', true],
  [seven, 'surrogate', '', 'seven.test:1\uff03top', true],
  [seven, 'surrogate', '', '\uff53\uff45\uff56\uff45\uff4e.test/doc', true],
  [seven, 'surrogate', '//seven.test:1', '', false],
  [seven, 'surrogate', '//seven.test:1/', '', false],
  [seven, 'surrogate', '', 'user@seven.test:1', false],
  [seven, 'surrogate', 'http://ordinary.test/?u=//seven.test:1/', '', false],
  [seven, 'surrogate', '', 'seven wonders', false],
  [seven, 'surrogate', '', 'Seven', false],
  [seven, 'surrogate', '//other.test/doc', 'an ordinary page', false],
  [seven, 'surrogate', '', '\uff53\uff45\uff56\uff45\uff4e wonders', false],
  [seven, 'surrogate', '', '\u200fan ordinary page', false],
  [
    seven,
    'surrogate',
    '',
    '\u200e\uff4f\uff52\uff44\uff49\uff4e\uff41\uff52\uff59.test/doc',
    false,
  ],
];

test('redactedInfo calls a url or title a leak exactly as the table says', () => {
  for (const [scope, targetId, url, title, leak] of leaks)
    assert.equal(
      redactedInfo({ targetId, url, title }, scope),
      !leak,
      JSON.stringify({ origin: scope.origin, targetId, url, title, leak })
    );
});

test('the host normalisation is what catches trailing-dot, port-stripped and IPv4-mapped hosts', () => {
  const normalised = [
    [seven, 'http://seven.test.:1/doc'],
    [seven, 'http://seven.test/doc'],
    [literalScope, 'http://[::ffff:127.0.0.7]:1/doc'],
  ];
  const unnormalised = (host) => host;
  for (const [scope, url] of normalised) {
    const info = { targetId: 'surrogate', url, title: '' };
    assert.equal(redactedInfo(info, scope), false, url);
    assert.equal(redactedInfo(info, scope, { normalize: unnormalised }), true, url);
  }
  for (const [host, name] of [
    ['Seven.Test.:443', 'seven.test'],
    ['seven.test:80', 'seven.test'],
    ['[::ffff:127.0.0.7]:1', '127.0.0.7'],
    ['[0:0:0:0:0:ffff:7f00:7]', '127.0.0.7'],
    ['[::1]:1', '[::1]'],
    ['seven.test:1/doc', ''],
    ['seven.test:1234-example', ''],
    ['user@seven.test', 'seven.test'],
    ['', ''],
  ])
    assert.equal(normalizeHost(host), name, host);
});

test('the leading host token is what catches default titles with a path, query or fragment', () => {
  const wholeTitle = (text) => text;
  for (const title of [
    'seven.test/doc',
    'seven.test:1/doc',
    'seven.test:1/doc?q=1#top',
    'seven.test./doc',
    'seven.test:1 doc',
  ]) {
    const info = { targetId: 'surrogate', url: '', title };
    assert.equal(redactedInfo(info, seven), false, title);
    assert.equal(redactedInfo(info, seven, { hostToken: wholeTitle }), true, title);
  }
});

const variantsMiss = [
  ['NFKC folding', { fold: (text) => text }, [{ url: '', title: 'seven.test:1\uff0fdoc' }]],
  [
    'trimming leading format and combining marks',
    { trim: (text) => text.replace(/^[\s\p{Cc}]+/u, '') },
    ['\u200e', '\u200f', '\u200d', '\u0301'].map((mark) => ({
      url: '',
      title: `${mark}seven.test:1/doc`,
    })),
  ],
  [
    'scheme-relative urls',
    { relative: false },
    [
      { url: '//seven.test/doc', title: '' },
      { url: 'http://ordinary.test/?u=//seven.test/doc', title: '' },
      { url: '', title: '//seven.test:1/doc' },
    ],
  ],
  [
    'stripping userinfo',
    { normalize: (host) => (String(host).includes('@') ? '' : normalizeHost(host)) },
    [{ url: '', title: 'user@seven.test:1/doc' }],
  ],
  [
    'trimming the leading whitespace and control characters',
    { trim: (text) => text },
    [
      { url: '', title: ' seven.test:1234/doc' },
      { url: '', title: '\tseven.test/doc' },
      { url: '', title: '\u0000seven.test:1/doc?q' },
    ],
  ],
  [
    'unwrapping filesystem:',
    { schemes: ['blob:', 'view-source:'] },
    [{ url: 'filesystem:http://seven.test:1', title: 'doc' }],
  ],
  [
    'unwrapping filesystem: and reading embedded urls',
    { schemes: ['blob:', 'view-source:'], embedded: false },
    [{ url: 'filesystem:http://seven.test:1/persistent/doc', title: '' }],
  ],
  [
    'reading embedded urls',
    { embedded: false },
    [
      { url: 'http://ordinary.test/?u=https://seven.test/doc', title: '' },
      { url: 'http://ordinary.test/#u=https://seven.test/doc', title: '' },
      { url: '', title: 'ordinary page https://seven.test/doc' },
      { url: 'http://ordinary.test/?u=https%3A%2F%2Fseven.test%2Fdoc', title: '' },
    ],
  ],
];

for (const [rule, variant, cases] of variantsMiss)
  test(`without ${rule} the check misses the leak`, () => {
    for (const entry of cases) {
      const info = { targetId: 'surrogate', ...entry };
      assert.equal(redactedInfo(info, seven), false, JSON.stringify(entry));
      assert.equal(redactedInfo(info, seven, variant), true, JSON.stringify(entry));
    }
  });

test('filesystem: alone catches a wrapped path once embedded urls are not read', () => {
  const info = {
    targetId: 'surrogate',
    url: 'filesystem:http://seven.test:1/persistent/doc',
    title: '',
  };
  assert.equal(redactedInfo(info, seven, { embedded: false }), false);
});

test('with the any-nonblank about: rule the check calls unrelated about: tabs a leak', () => {
  for (const [url, title] of [
    ['about:blank#settings', 'about:blank#settings'],
    ['about:blank#settings', 'Settings'],
    ['about:blank?x=1', ''],
    ['about:srcdoc', ''],
    ['about:blank#other.test/doc', 'an ordinary page'],
  ]) {
    const info = { targetId: 'OTHER', url, title };
    assert.equal(redactedInfo(info, seven), true, url);
    assert.deepEqual(redactionLeak(info, seven, { aboutContent: false }), {
      field: 'url',
      rule: 'about: non-bare',
    });
  }
  for (const url of [
    'about:blank#/doc',
    'about:blank#seven.test/doc',
    'about:blank#/doc?n=guard-tag',
  ])
    assert.equal(redactedInfo({ targetId: 'OTHER', url, title: '' }, seven), false, url);
});

test('redactionLeak names the field and rule of each leak', () => {
  const scope = { targetId: 'RAW', origin: 'http://seven.test:1', path: '/doc', tag: 'guard-tag' };
  for (const [targetId, url, title, expected] of [
    ['RAW', '', 'doc', { field: 'title', rule: 'raw target id' }],
    [
      'surrogate',
      'http://seven.test:1',
      'doc',
      { field: 'title', rule: 'protected host', via: 'url' },
    ],
    ['surrogate', 'http://seven.test.:1/doc', '', { field: 'url', rule: 'normalised host' }],
    ['surrogate', '', 'seven.test:1/doc', { field: 'title', rule: 'host token' }],
    ['surrogate', '', ' \tseven.test:1/doc', { field: 'title', rule: 'host token' }],
    ['surrogate', 'data:,http://seven.test:1/doc', '', { field: 'url', rule: 'data: unwrapped' }],
    [
      'surrogate',
      'filesystem:http://seven.test:1/p/doc',
      '',
      { field: 'url', rule: 'filesystem: unwrapped' },
    ],
    ['surrogate', 'about:blank#/doc', '', { field: 'url', rule: 'about: non-bare' }],
    ['surrogate', 'about:blank#seven.test/doc', '', { field: 'url', rule: 'about: non-bare' }],
    ['surrogate', 'about:blank#/doc?n=guard-tag', '', { field: 'url', rule: 'about: non-bare' }],
    [
      'surrogate',
      'about:blank#settings',
      'seven.test:1',
      { field: 'url', rule: 'host token', via: 'title' },
    ],
    ['RAW', 'about:blank#settings', '', { field: 'url', rule: 'raw target id' }],
    ['OTHER', 'about:blank#settings', 'about:blank#settings', undefined],
    ['OTHER', 'about:blank#other.test/doc', '', undefined],
    [
      'surrogate',
      'http://ordinary.test/?u=https://seven.test/doc',
      '',
      { field: 'url', rule: 'embedded url with path' },
    ],
    ['surrogate', 'http://ordinary.test/', 'x-GUARD-tag', { field: 'title', rule: 'tag' }],
    ['surrogate', 'http://ordinary.test/doc', 'doc', undefined],
    ['surrogate', 'about:blank', '/doc', undefined],
  ])
    assert.deepEqual(redactionLeak({ targetId, url, title }, scope), expected, `${url} ${title}`);
});

test('maskedValue keeps the origin and part lengths and never the tag', () => {
  for (const [value, shown] of [
    ['http://seven.test:1234/doc', 'http://seven.test:1234 + path(4 chars)'],
    [
      'http://seven.test:1/doc?n=guard-tag',
      'http://seven.test:1 + path(4 chars) + query(12 chars)',
    ],
    ['http://seven.test:1/#top', 'http://seven.test:1 + fragment(4 chars)'],
    ['seven.test:1/doc', 'seven.test:1 + 4 chars'],
    ['about:blank#/doc', 'about:(16 chars)'],
    ['data:text/plain,guard-tag', 'data:(25 chars)'],
    ['guard-tag', 'text(9 chars)'],
    ['http://guard-tag.test/', '(22 chars)'],
    ['a page title', 'text(12 chars)'],
    ['Report.pdf', 'text(10 chars)'],
    ['ordinary.test:1/doc', 'ordinary.test:(19 chars)'],
    ['', 'empty'],
    [undefined, 'empty'],
  ])
    assert.equal(maskedValue(value, 'GUARD-tag', 'seven.test'), shown, String(value));
  assert.equal(maskedId('PAGE1', 'guard-tag'), 'PAGE1');
  assert.equal(maskedId('x-guard-tag', 'guard-tag'), '(11-char id)');
  assert.equal(maskedId(undefined, 'guard-tag'), '(no id)');
});

test('pickRawTarget matches type, opener and URL prefix and skips known targets', () => {
  const infos = [
    { targetId: 'A', type: 'tab', url: 'http://s/doc' },
    { targetId: 'B', type: 'page', url: 'http://s/doc', openerId: 'P' },
    { targetId: 'C', type: 'page', url: 'http://s/other' },
    { type: 'page', url: 'http://s/doc' },
  ];
  assert.equal(pickRawTarget(infos, { type: 'page', openerId: 'P' })?.targetId, 'B');
  assert.equal(pickRawTarget(infos, { type: 'page', urlPrefix: 'http://s/o' })?.targetId, 'C');
  assert.equal(pickRawTarget(infos, { type: 'page', known: new Set(['B']) })?.targetId, 'C');
  assert.equal(pickRawTarget(infos, { type: 'tab' })?.targetId, 'A');
  assert.equal(pickRawTarget(undefined, { type: 'page' }), undefined);
  assert.equal(pickRawTarget(infos, { type: 'worker' }), undefined);
});
