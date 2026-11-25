import assert from 'node:assert/strict';
import { createHash, createPublicKey, verify } from 'node:crypto';
import test from 'node:test';
import catalog from '@ai-ecoverse/slicc-browsers' with { type: 'json' };
import { leaseScope, parseLeaseAllow } from '@ai-ecoverse/slicc-browsers/lease-scope.mjs';
import scope from '@ai-ecoverse/slicc-browsers/lease-scope-v1.json' with { type: 'json' };
import v from '@ai-ecoverse/slicc-browsers/lease-v1.json' with { type: 'json' };
import schema from '@ai-ecoverse/slicc-browsers/schema/lease-v1.schema.json' with { type: 'json' };
import Ajv2020 from 'ajv/dist/2020.js';
import { frame, wireVectors } from './fixtures/lease-wire.mjs';

const ajv = new Ajv2020({ strict: true }).addSchema(schema);
const check = (def, value) => ajv.validate(`${schema.$id}${def ? `#/$defs/${def}` : ''}`, value);
const publicKey = (key) => createPublicKey({ format: 'jwk', key });
const hash = (text) => createHash('sha256').update(text).digest();
const context = v.context;

function decode(text, length) {
  const bytes = Buffer.from(text, 'base64url');
  assert.ok(bytes.length > 0);
  assert.equal(bytes.toString('base64url'), text);
  if (length) assert.equal(bytes.length, length);
  return bytes;
}
function readJSON(bytes) {
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  const object = JSON.parse(text);
  const stack = [];
  for (const [token] of text.matchAll(/"(?:\\.|[^"\\])*"\s*:?|[{}]/gs)) {
    if (token === '{') stack.push(new Set());
    if (token === '}') stack.pop();
    if (token.endsWith(':')) {
      const key = JSON.parse(token.slice(0, -1));
      const keys = stack.at(-1);
      assert.ok(!keys.has(key));
      keys.add(key);
    }
  }
  return object;
}
function jkt(key) {
  assert.ok(check('jwk', key));
  decode(key.x, 32);
  return hash(JSON.stringify({ crv: key.crv, kty: key.kty, x: key.x }));
}
function validGrant({
  jwt = v.jwt,
  jwk = v.holderJwk,
  active = context.active,
  now = context.now,
} = {}) {
  try {
    if (!check('jwt', jwt)) return false;
    const [h, p, sig] = jwt.split('.');
    if (!check('header', readJSON(decode(h)))) return false;
    if (!verify(null, Buffer.from(`${h}.${p}`), publicKey(v.issuerJwk), decode(sig, 64)))
      return false;
    const c = readJSON(decode(p));
    return (
      check('claims', c) &&
      c.iss === context.iss &&
      c.aud === context.aud &&
      c.browser_session === context.epoch &&
      active.includes(c.jti) &&
      c.exp > now &&
      !!leaseScope(catalog, c.allow) &&
      jkt(jwk).toString('base64url') === c.cnf.jkt
    );
  } catch {
    return false;
  }
}

test('public KATs are reproducible and each compact JWT is verified from its original signing bytes', () => {
  assert.deepEqual(v, wireVectors());
  for (const row of v.jwtCases) assert.equal(validGrant(row), row.accepted, row.id);
  assert.equal(validGrant({ jwt: v.expansion.grant.jwt }), false);
  assert.equal(validGrant({ jwt: v.expansion.grant.jwt, active: ['L2'] }), true);
  const next = readJSON(decode(v.expansion.grant.jwt.split('.')[1]));
  assert.equal(next.exp, v.claims.exp);
  assert.deepEqual(next.cnf, v.claims.cnf);
  assert.deepEqual(next.allow, [...v.claims.allow, ...v.expansion.open.allow]);
});

function challenge(row) {
  const {
    mode,
    presentedLink = 'paired',
    presentedStream = 'opened',
    ageSeconds = 0,
    nonce,
    jwt = v.jwt,
    active,
    now,
  } = row;
  const exchange = mode === 'data' ? v.dataStream : v.requestStream;
  const binding = mode === 'data' ? hash(jwt) : jkt(exchange.open.jwk);
  const bytes = Buffer.concat([
    Buffer.from(`slicc-cdp-lease-v1:${mode}\x00`, 'ascii'),
    decode(nonce ?? exchange.opened.nonce, 32),
    binding,
  ]);
  let consumed = row.consumed;
  return (sig) => {
    if (presentedLink !== 'paired' || presentedStream !== 'opened' || consumed) return false;
    consumed = true;
    if (ageSeconds >= 30 || (mode === 'data' && !validGrant({ jwt, active, now }))) return false;
    return verify(null, bytes, publicKey(exchange.open.jwk), decode(sig, 64));
  };
}
test('one proof attempt per stream, including failed attempts; proofs and grants cannot be reused across modes or streams', () => {
  for (const row of v.proofCases) {
    const exchange = row.mode === 'data' ? v.dataStream : v.requestStream;
    const submit = challenge(row);
    assert.equal(submit(row.sig ?? exchange.proof.sig), row.accepted, row.id);
    assert.equal(submit(exchange.proof.sig), false, `${row.id}: second attempt`);
  }
  assert.equal(check('jwk', { ...v.holderJwk, jku: 'https://keys.example' }), false);
});

test('message schemas, octet framing and adapter parameters are closed', () => {
  const { requestStream: r, dataStream: d, expansion: e } = v;
  for (const message of [
    r.open,
    r.opened,
    r.proof,
    r.pending,
    r.grant,
    d.open,
    d.opened,
    d.proof,
    d.ready,
    d.action,
    d.result,
    e.open,
    e.pending,
    e.denied,
    e.grant,
  ])
    assert.ok(check('', message), JSON.stringify(ajv.errors));
  for (const message of v.invalidMessages) assert.equal(check('', message), false);
  for (const [message, hex] of [
    [d.result, d.resultRecordHex],
    [r.proof, r.proofRecordHex],
    [d.proof, d.proofRecordHex],
  ]) {
    const bytes = Buffer.from(hex, 'hex');
    assert.equal(bytes.readUInt32BE(), bytes.length - 4);
    assert.deepEqual(readJSON(bytes.subarray(4)), message);
    assert.deepEqual(bytes, frame(message));
  }
  const allow = v.claims.allow;
  assert.ok(check('facadeRequest', { allow, ttlSeconds: 3600 }));
  assert.ok(check('facadeRequest', { allow, lease: 'L1' }));
  for (const params of [
    { allow },
    { allow, ttlSeconds: 0 },
    { allow, lease: 'L1', ttlSeconds: 3600 },
    { allow, ttlSeconds: 3600, host: 'external' },
  ])
    assert.equal(check('facadeRequest', params), false);
  for (const [op, args] of [
    ['goto', { url: scope.driver.allow[0].url }],
    ['snapshot', {}],
    ['click', { ref: 'e12' }],
    ['fill', { ref: 'e12', value: 'demo' }],
  ])
    assert.ok(check('facadeAction', { lease: 'L1', op, args }));
  assert.equal(
    check('facadeAction', { lease: 'L1', op: 'snapshot', args: { targetId: 'existing' } }),
    false
  );
});

test('WHATWG normalization never turns a malformed or protected allow rule into authority', () => {
  for (const { input, rule } of scope.shorthandCases)
    assert.deepEqual(parseLeaseAllow(catalog, input), rule, input);
  for (const row of scope.urlCases)
    assert.equal(leaseScope(catalog, row.allow)(row.url), row.match, row.id);
  for (const rule of scope.invalidRules)
    assert.equal(leaseScope(catalog, [...v.claims.allow, rule]), null, JSON.stringify(rule));
  assert.equal(leaseScope(catalog, v.claims.allow, ['https://billing.example/']), null);
  for (const rules of [null, [], [null], [...v.claims.allow, ...v.claims.allow]])
    assert.equal(leaseScope(catalog, rules), null);
});

test('lease-state transitions retire idle streams and never deliver an old in-flight result under a replacement', () => {
  for (const row of v.lifecycleCases) {
    let live = 'L1',
      data = 'L1',
      parent = null,
      result = false;
    for (const event of row.events) {
      switch (event) {
        case 'requestDelta':
          parent = live;
          break;
        case 'dropRequest':
        case 'deny':
          parent = null;
          break;
        case 'approve':
          if (parent && parent === live) {
            live = 'L2';
            data = null;
          }
          parent = null;
          break;
        case 'atExp':
        case 'restart':
        case 'revoke':
          live = data = parent = null;
          break;
        case 'proveL2':
        case 'proveL1':
          data = event.slice(-2) === live ? live : null;
          break;
        case 'release':
          result = live === 'L1' && data === live;
          break;
        default:
          throw Error(event);
      }
    }
    assert.deepEqual(
      { live, data, result },
      { live: row.live, data: row.data, result: row.result },
      row.id
    );
  }
});

function readRecords(hex, cuts) {
  const bytes = Buffer.from(hex, 'hex');
  let offset = 0;
  let buffer = Buffer.alloc(0);
  const records = [];
  for (const end of [...cuts, bytes.length]) {
    buffer = Buffer.concat([buffer, bytes.subarray(offset, end)]);
    offset = end;
    while (buffer.length >= 4) {
      const length = buffer.readUInt32BE();
      if (!length || length > 65536) throw Error('record length');
      if (buffer.length < 4 + length) break;
      records.push(readJSON(buffer.subarray(4, 4 + length)));
      buffer = buffer.subarray(4 + length);
    }
  }
  if (buffer.length) throw Error('truncated');
  return records;
}

test('stream framing counts octets across fragments and rejects incomplete or ambiguous records', () => {
  for (const { id, hex, cuts, records } of v.framingCases) {
    if (records === null) assert.throws(() => readRecords(hex, cuts), Error, id);
    else assert.deepEqual(readRecords(hex, cuts), records, id);
  }
});

function decide(row) {
  if (row.subject === 'page') return 'normal-loader';
  const before = { ...scope.driver.observed, ...row.observed };
  const view = { ...before, ...row.after };
  const match = leaseScope(catalog, row.allow ?? scope.driver.allow);
  const live =
    (row.active ?? context.active).includes(v.claims.jti) &&
    (row.now ?? context.now) < v.claims.exp;
  const scoped =
    match &&
    live &&
    view.tab === scope.driver.observed.tab &&
    view.epoch === context.epoch &&
    view.urls.length > 0 &&
    view.urls.every(match);
  switch (row.subject) {
    case 'goto':
      return scoped && match(row.url) ? 'allow' : 'deny';
    case 'subtree':
      return scoped ? 'allow' : 'placeholder';
    case 'driver':
      return scoped &&
        (row.refGeneration ?? view.generation) === view.generation &&
        row.targetVerified !== false &&
        ['snapshot', 'click', 'fill'].includes(row.op ?? 'snapshot')
        ? 'allow'
        : 'deny';
    case 'output':
      return scoped &&
        view.generation === before.generation &&
        view.document === before.document &&
        JSON.stringify(view.urls) === JSON.stringify(before.urls)
        ? 'allow'
        : 'withhold';
    default:
      throw Error(`unknown subject ${row.subject}`);
  }
}
test('mediation distinguishes passive page loads from driver dispatch, frame reads and result release', () => {
  for (const row of scope.driver.rows) assert.equal(decide(row), row.expect, row.id);
});
