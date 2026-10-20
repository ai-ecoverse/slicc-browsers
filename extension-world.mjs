import { outcome } from './guard-driver.mjs';

export const DEFAULT_EXTENSION_WORLD_ID = 'ankmbodmgimjemnojmeddfcdlbocolob';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const extension = (context) =>
  context?.origin?.startsWith('chrome-extension://') && !context.auxData?.isDefault;
const marker =
  'typeof root !== "undefined" && root === document.documentElement && root.dataset.sliccHarnessExtension === chrome.runtime.id';
const refused = (out) => !out.ok && /^slicc: refused:/.test(out.error?.message ?? '');

async function discover(reader, session, extensionId) {
  const start = reader.events.length;
  await reader.send('Runtime.enable', {}, session);
  const deadline = Date.now() + 5000;
  do {
    const world = reader.events
      .slice(start)
      .find(
        (event) =>
          event.sessionId === session &&
          event.method === 'Runtime.executionContextCreated' &&
          extension(event.params.context) &&
          event.params.context.origin === `chrome-extension://${extensionId}`
      )?.params.context;
    if (world) return world;
    await pause(25);
  } while (Date.now() < deadline);
  throw new Error(`extensionWorld: no content-script context for ${extensionId}`);
}

async function drivable(client, session, live) {
  const setup = await outcome(
    client.send(
      'Runtime.evaluate',
      {
        expression:
          'document.body.innerHTML = `<button style="position:fixed;left:0;top:0;width:100px;height:100px" onclick="document.body.dataset.clicked=\'yes\'">C9 click</button>`',
        returnByValue: true,
      },
      session
    )
  );
  const snapshot = await outcome(
    client.send('DOMSnapshot.captureSnapshot', { computedStyles: [] }, session)
  );
  const down = await outcome(
    client.send(
      'Input.dispatchMouseEvent',
      { type: 'mousePressed', x: 20, y: 20, button: 'left', clickCount: 1 },
      session
    )
  );
  const up = await outcome(
    client.send(
      'Input.dispatchMouseEvent',
      { type: 'mouseReleased', x: 20, y: 20, button: 'left', clickCount: 1 },
      session
    )
  );
  const click = await outcome(
    client.send(
      'Runtime.evaluate',
      { expression: 'document.body.dataset.clicked', returnByValue: true },
      session
    )
  );
  return {
    exists: true,
    alive: await live(),
    snapshot: snapshot.ok && snapshot.result.documents?.length > 0,
    click: setup.ok && down.ok && up.ok && click.ok && click.result.result?.value === 'yes',
  };
}

async function debuggerWorld({
  client,
  reader,
  session,
  observer,
  world,
  events,
  live,
  side,
  pauseMs,
}) {
  const debug = await outcome(client.send('Debugger.enable', {}, session));
  const probe = outcome(
    reader.send(
      'Runtime.evaluate',
      {
        contextId: world.id,
        expression:
          'setTimeout(() => { debugger; globalThis.c9DebuggerReached = chrome.runtime.id; }, 0)',
        returnByValue: true,
      },
      observer
    )
  );
  const deadline = Date.now() + pauseMs;
  while (
    debug.ok &&
    !events().some((event) => event.method === 'Debugger.paused') &&
    Date.now() < deadline
  )
    await pause(25);
  const paused = events().find((event) => event.method === 'Debugger.paused');
  let reached = false;
  let frameRefused = false;
  if (paused?.params.callFrames?.[0]) {
    const out = await outcome(
      client.send(
        'Debugger.evaluateOnCallFrame',
        {
          callFrameId: paused.params.callFrames[0].callFrameId,
          expression: marker,
          returnByValue: true,
        },
        session
      )
    );
    reached = out.ok && out.result.result?.value === true;
    frameRefused = refused(out);
  }
  await outcome(reader.send('Debugger.resume', {}, observer));
  await outcome(client.send('Debugger.resume', {}, session));
  const probeResult = await probe;
  if (!probeResult.ok)
    throw new Error(`extensionWorld debugger stimulus: ${probeResult.error?.message}`);
  const exposed =
    events().some(
      (event) =>
        event.method === 'Debugger.scriptParsed' && event.params.executionContextId === world.id
    ) || Boolean(paused);
  await outcome(client.send('Debugger.disable', {}, session));
  const incomplete = side === 'control' && debug.ok && !paused;
  return {
    exists: true,
    reachable: incomplete ? 'incomplete' : reached,
    ...(incomplete ? { incomplete: `no Debugger.paused within ${pauseMs}ms` } : {}),
    protected: refused(debug) || frameRefused || !exposed,
    alive: await live(),
  };
}

function commands(world, objectId, promiseObjectId, nodeId) {
  return [
    [
      'contextId',
      'Runtime.evaluate',
      { contextId: world.id, expression: marker, returnByValue: true },
    ],
    [
      'uniqueContextId',
      'Runtime.evaluate',
      { uniqueContextId: world.uniqueId, expression: marker, returnByValue: true },
    ],
    [
      'executionContextId',
      'Runtime.callFunctionOn',
      {
        executionContextId: world.id,
        functionDeclaration: `function(){return ${marker}}`,
        returnByValue: true,
      },
    ],
    [
      'objectId',
      'Runtime.callFunctionOn',
      {
        objectId,
        functionDeclaration: 'function(){return typeof this.chrome.runtime.id === "string"}',
        returnByValue: true,
      },
    ],
    [
      'argument',
      'Runtime.callFunctionOn',
      {
        objectId,
        functionDeclaration: 'function(value){return typeof value.chrome.runtime.id === "string"}',
        arguments: [{ objectId }],
        returnByValue: true,
      },
    ],
    ['promiseObjectId', 'Runtime.awaitPromise', { promiseObjectId, returnByValue: true }],
    ['properties', 'Runtime.getProperties', { objectId, ownProperties: true }],
    ['binding', 'Runtime.addBinding', { name: 'c9Binding', executionContextName: world.name }],
    ['resolveNode', 'DOM.resolveNode', { nodeId, executionContextId: world.id }],
  ];
}

async function guessWorld({ client, session, world, handles, events }) {
  const exposed = new Set(
    events()
      .filter((event) => event.method === 'Runtime.executionContextCreated')
      .map((event) => event.params.context.id)
  );
  const ids = new Set([
    ...Array.from({ length: 32 }, (_, index) => index + 1),
    handles.world.id,
    world.id,
    ...exposed,
  ]);
  const numeric = [];
  for (const id of ids) {
    const probes = [
      ['Runtime.evaluate', { contextId: id, expression: marker, returnByValue: true }],
      [
        'Runtime.callFunctionOn',
        {
          executionContextId: id,
          functionDeclaration: `function(){return ${marker}}`,
          returnByValue: true,
        },
      ],
    ];
    for (const [method, params] of probes) {
      const out = await outcome(client.send(method, params, session));
      numeric.push({
        id,
        method,
        exposed: exposed.has(id),
        refused: refused(out),
        ok: out.ok && !out.result.exceptionDetails && typeof out.result.result?.value === 'boolean',
        reached: out.ok && out.result.result?.value === true,
      });
    }
  }
  const unique = [];
  for (const uniqueContextId of new Set([handles.world.uniqueId, world.uniqueId])) {
    const out = await outcome(
      client.send(
        'Runtime.evaluate',
        { uniqueContextId, expression: marker, returnByValue: true },
        session
      )
    );
    unique.push({
      uniqueContextId,
      refused: refused(out),
      reached: out.ok && out.result.result?.value === true,
    });
  }
  return {
    guessesRefused:
      numeric.filter((guess) => !guess.exposed).every((guess) => guess.refused) &&
      unique.every((guess) => guess.refused),
    guessesReached: [...numeric, ...unique].some((guess) => guess.reached),
    exposedContextsWork: numeric
      .filter((guess) => guess.exposed)
      .every((guess) => guess.ok && !guess.refused),
    numericGuesses: numeric,
    uniqueGuesses: unique,
    controlNumericId: handles.world.id,
    hiddenNumericId: world.id,
  };
}

async function selectWorld({ client, session, world, side, controls, live, events }) {
  let handles = controls.select;
  if (side === 'control') {
    const object = await client.send(
      'Runtime.evaluate',
      { contextId: world.id, expression: 'globalThis', returnByValue: false },
      session
    );
    const promise = await client.send(
      'Runtime.evaluate',
      {
        contextId: world.id,
        expression: 'Promise.resolve(chrome.runtime.id)',
        returnByValue: false,
      },
      session
    );
    handles = { world, objectId: object.result.objectId, promiseObjectId: promise.result.objectId };
    controls.select = handles;
  }
  if (!handles?.objectId || !handles?.promiseObjectId)
    throw new Error('extensionWorld: control did not provide object handles');
  const dom = await outcome(client.send('DOM.getDocument', {}, session));
  const result = { exists: true };
  for (const [name, method, params] of commands(
    world,
    handles.objectId,
    handles.promiseObjectId,
    dom.result?.root.nodeId ?? 1
  )) {
    const out = await outcome(client.send(method, params, session));
    result[`${name}Refused`] = refused(out);
    result[`${name}Reached`] =
      out.ok &&
      !out.result.exceptionDetails &&
      (['contextId', 'uniqueContextId', 'executionContextId', 'objectId', 'argument'].includes(name)
        ? out.result.result?.value === true
        : name === 'promiseObjectId'
          ? typeof out.result.result?.value === 'string'
          : name === 'properties'
            ? out.result.result?.some((property) => property.name === 'chrome')
            : name === 'resolveNode'
              ? Boolean(out.result.object?.objectId)
              : true);
    result[`${name}Error`] = out.error?.message ?? out.result?.exceptionDetails?.text;
  }
  Object.assign(result, await guessWorld({ client, session, world, handles, events }));
  const pageMarker = await outcome(
    client.send('Runtime.evaluate', { expression: marker, returnByValue: true }, session)
  );
  result.pageMarkerAbsent = pageMarker.ok && pageMarker.result.result?.value === false;
  result.alive = await live();
  return result;
}

export async function extensionWorld({
  client,
  reader,
  session,
  targetId,
  mode,
  origin,
  side,
  controls,
  extensionId = DEFAULT_EXTENSION_WORLD_ID,
  pauseMs = side === 'control' ? 5000 : 1500,
}) {
  const attached = await reader.send('Target.attachToTarget', { targetId, flatten: true });
  const observer = attached.sessionId;
  const seen = client.events.length;
  try {
    const world = await discover(reader, observer, extensionId);
    const enabled = await outcome(client.send('Runtime.enable', {}, session));
    await pause(100);
    const events = () => client.events.slice(seen).filter((event) => event.sessionId === session);
    const live = async () => {
      const out = await outcome(
        client.send('Runtime.evaluate', { expression: 'self.origin', returnByValue: true }, session)
      );
      return (
        out.ok &&
        out.result.result?.value === origin &&
        !out.result.exceptionDetails &&
        !client.events
          .slice(seen)
          .some(
            (event) =>
              event.method === 'Target.detachedFromTarget' && event.params.sessionId === session
          )
      );
    };
    if (mode === 'hidden') {
      await outcome(client.send('Debugger.enable', {}, session));
      await reader.send(
        'Runtime.evaluate',
        {
          contextId: world.id,
          expression: 'console.log("C9 isolated world", globalThis); globalThis',
          returnByValue: false,
        },
        observer
      );
      await pause(100);
      const leaked = events().filter((event) => /^(Runtime|Debugger)\./.test(event.method));
      const leaks = leaked.some(
        (event) =>
          event.params.executionContextId === world.id ||
          event.params.executionContextUniqueId === world.uniqueId ||
          JSON.stringify(event.params).includes(world.uniqueId) ||
          extension(event.params.context) ||
          (event.method === 'Runtime.consoleAPICalled' &&
            event.params.args?.some((arg) => arg.objectId))
      );
      const listed = leaked.some(
        (event) =>
          event.method === 'Runtime.executionContextCreated' && extension(event.params.context)
      );
      const defaultSeen = leaked.some(
        (event) =>
          event.method === 'Runtime.executionContextCreated' &&
          event.params.context.auxData?.isDefault &&
          event.params.context.origin === origin
      );
      await outcome(client.send('Debugger.disable', {}, session));
      return { exists: true, listed, leaks, defaultSeen, alive: enabled.ok && (await live()) };
    }
    const input = {
      client,
      reader,
      session,
      observer,
      world,
      events,
      live,
      side,
      controls,
      pauseMs,
    };
    if (mode === 'drivable') return await drivable(client, session, live);
    if (mode === 'debugger') return await debuggerWorld(input);
    return await selectWorld(input);
  } finally {
    await outcome(reader.send('Target.detachFromTarget', { sessionId: observer }));
  }
}
