import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const hash = (bytes) => createHash('sha256').update(bytes).digest();
const b64 = (bytes) => Buffer.from(bytes).toString('base64url');
const label = (name) => hash(`slicc-browsers v1 public test fixture only: ${name}`);
function fixtureKey(name) {
  const key = createPrivateKey({
    format: 'der',
    type: 'pkcs8',
    key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), label(name)]),
  });
  const { x } = createPublicKey(key).export({ format: 'jwk' });
  return { key, jwk: { kty: 'OKP', crv: 'Ed25519', x } };
}
const issuer = fixtureKey('issuer');
const holder = fixtureKey('holder');
const thumbprintInput = JSON.stringify({ crv: 'Ed25519', kty: 'OKP', x: holder.jwk.x });
const jkt = b64(hash(thumbprintInput));
const header = { typ: 'slicc-cdp-lease+jwt', alg: 'Ed25519' };
const rule = { kind: 'origin', url: 'https://billing.example' };
const claims = {
  iss: 'urn:slicc:broker:fixture',
  aud: 'urn:slicc:cdp-lease:fixture',
  jti: 'L1',
  exp: 1795518000,
  cnf: { jkt },
  browser_session: 'work-epoch-42',
  allow: [rule],
};
const json = (value) => (typeof value === 'string' ? value : JSON.stringify(value));
function compact(h = header, c = claims, key = issuer.key) {
  const input = `${b64(json(h))}.${b64(json(c))}`;
  return `${input}.${b64(sign(null, Buffer.from(input, 'ascii'), key))}`;
}
export function frame(value) {
  const bytes = Buffer.from(JSON.stringify(value));
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
}
export function wireVectors() {
  const jwt = compact();
  const request = 'R1';
  const jwk = holder.jwk;
  const kind = 'cdp-lease-v1';
  const exchange = (mode, binding) => {
    const nonce = label(`nonce-${mode}`);
    const transcript = Buffer.concat([Buffer.from(`slicc-cdp-lease-v1:${mode}\0`), nonce, binding]);
    const proof = { type: 'proof', sig: b64(sign(null, transcript, holder.key)) };
    return {
      open:
        mode === 'data'
          ? { kind, mode, jwt, jwk }
          : { kind, mode, jwk, allow: [rule], ttlSeconds: 3600 },
      opened: { nonce: b64(nonce) },
      bindingHex: binding.toString('hex'),
      transcriptHex: transcript.toString('hex'),
      proof,
      proofRecordHex: frame(proof).toString('hex'),
    };
  };
  const requestStream = {
    ...exchange('request', hash(thumbprintInput)),
    pending: { type: 'pending', request },
    grant: { type: 'grant', request, jwt },
  };
  const action = { type: 'action', id: 1, op: 'snapshot', args: {} };
  const result = { type: 'result', id: 1, result: { text: 'Invoice 1042 · paid' } };
  const dataStream = {
    ...exchange('data', hash(jwt)),
    ready: { type: 'ready' },
    action,
    result,
    resultRecordHex: frame(result).toString('hex'),
  };
  const validScope = [{ kind: 'exact', url: 'https://receipts.example/r/1042' }];
  const expansion = {
    open: { kind, mode: 'request', jwk, parent: claims.jti, allow: validScope },
    pending: { type: 'pending', request: 'R2' },
    denied: { type: 'error', reason: 'E_DENIED', message: 'Request denied.' },
    grant: {
      type: 'grant',
      request: 'R2',
      jwt: compact(header, { ...claims, jti: 'L2', allow: [rule, ...validScope] }),
    },
  };
  const jwtCases = [
    { id: 'valid', accepted: true },
    {
      id: 'different-json-serialization',
      jwt: compact(JSON.stringify(header, null, 2), JSON.stringify(claims, null, 1)),
      accepted: true,
    },
    {
      id: 'tampered-claims',
      jwt: `${jwt.split('.')[0]}.${b64(json({ ...claims, exp: claims.exp + 1 }))}.${jwt.split('.')[2]}`,
    },
    { id: 'unsigned', jwt: `${b64(json({ ...header, alg: 'none' }))}.${jwt.split('.')[1]}.` },
    { id: 'wrong-signer', jwt: compact(header, claims, holder.key) },
    ...Object.entries({
      'alg-ed-dsa': { ...header, alg: 'EdDSA' },
      'unexpected-typ': { ...header, typ: 'JWT' },
      'key-url': { ...header, jku: 'https://keys.example/jwks' },
      'supplied-key': { ...header, jwk },
      'duplicate-header': '{"alg":"none","alg":"Ed25519","typ":"slicc-cdp-lease+jwt"}',
    }).map(([id, h]) => ({ id, jwt: compact(h) })),
    ...Object.entries({
      'different-issuer': { ...claims, iss: 'urn:slicc:broker:other' },
      'different-audience': { ...claims, aud: 'urn:slicc:cdp-lease:other' },
      'audience-array': { ...claims, aud: [claims.aud] },
      'different-epoch': { ...claims, browser_session: 'work-epoch-43' },
      'different-jkt': { ...claims, cnf: { jkt: b64(label('other-holder')) } },
      'absent-exp': { ...claims, exp: undefined },
      'fractional-exp': { ...claims, exp: claims.exp + 0.5 },
      'mixed-invalid-rules': {
        ...claims,
        allow: [rule, { kind: 'origin', url: 'https://receipts.example/r/1042' }],
      },
      'duplicate-escaped-name': `{"\\u0065xp":1,${json(claims).slice(1)}`,
      'duplicate-nested-name': json(claims).replace('"cnf":{', '"cnf":{"jkt":"wrong",'),
    }).map(([id, c]) => ({ id, jwt: compact(header, c) })),
    { id: 'inactive', active: [] },
    { id: 'exclusive-expiry', now: claims.exp },
    { id: 'private-holder-jwk', jwk: { ...jwk, d: b64(label('not-a-secret')) } },
    { id: 'wrong-holder-key', jwk: issuer.jwk },
    { id: 'noncanonical-base64', jwt: `${jwt}=` },
  ].map((v) => ({ accepted: false, ...v }));
  return {
    version: 1,
    fixtureOnly: true,
    issuerJwk: issuer.jwk,
    holderJwk: jwk,
    thumbprintInput,
    header,
    claims,
    jwt,
    context: {
      iss: claims.iss,
      aud: claims.aud,
      epoch: claims.browser_session,
      active: [claims.jti],
      now: claims.exp - 3600,
    },
    requestStream,
    dataStream,
    expansion,
    jwtCases,
    proofCases: [
      { id: 'control-possession', mode: 'request', accepted: true },
      { id: 'data-possession', mode: 'data', accepted: true },
      { id: 'other-stream', mode: 'data', presentedStream: 'other', accepted: false },
      { id: 'other-paired-link', mode: 'data', presentedLink: 'other', accepted: false },
      { id: 'consumed', mode: 'data', consumed: true, accepted: false },
      { id: 'challenge-deadline', mode: 'request', ageSeconds: 30, accepted: false },
      {
        id: 'reconnected-nonce',
        mode: 'data',
        nonce: b64(label('new-challenge')),
        accepted: false,
      },
      {
        id: 'other-grant',
        mode: 'data',
        jwt: expansion.grant.jwt,
        active: ['L2'],
        accepted: false,
      },
      { id: 'cross-mode', mode: 'request', sig: dataStream.proof.sig, accepted: false },
      { id: 'invalid-first-attempt', mode: 'data', sig: b64(Buffer.alloc(64)), accepted: false },
      { id: 'retired-after-open', mode: 'data', active: [], accepted: false },
      { id: 'expired-during-proof', mode: 'data', now: claims.exp, accepted: false },
    ],
    lifecycleCases: [
      {
        id: 'denial-keeps-authority',
        events: ['requestDelta', 'deny', 'release'],
        live: 'L1',
        data: 'L1',
        result: true,
      },
      {
        id: 'approved-delta-retires-before-output',
        events: ['requestDelta', 'approve', 'release'],
        live: 'L2',
        data: null,
        result: false,
      },
      {
        id: 'new-channel-for-replacement',
        events: ['requestDelta', 'approve', 'proveL2', 'release'],
        live: 'L2',
        data: 'L2',
        result: false,
      },
      {
        id: 'expiry-before-approval',
        events: ['requestDelta', 'atExp', 'approve', 'release'],
        live: null,
        data: null,
        result: false,
      },
      {
        id: 'revoked-before-approval',
        events: ['requestDelta', 'revoke', 'approve', 'release'],
        live: null,
        data: null,
        result: false,
      },
      {
        id: 'disconnected-request',
        events: ['requestDelta', 'dropRequest', 'approve', 'release'],
        live: 'L1',
        data: 'L1',
        result: true,
      },
      {
        id: 'old-proof-after-revoke',
        events: ['revoke', 'proveL1', 'release'],
        live: null,
        data: null,
        result: false,
      },
      {
        id: 'restart-during-output',
        events: ['restart', 'release'],
        live: null,
        data: null,
        result: false,
      },
      { id: 'idle-stream-at-deadline', events: ['atExp'], live: null, data: null, result: false },
    ],
    framingCases: [
      {
        id: 'split-prefix-and-utf8',
        hex: dataStream.resultRecordHex,
        cuts: [1, 3, 5, dataStream.resultRecordHex.indexOf('c2b7') / 2 + 1],
        records: [result],
      },
      {
        id: 'coalesced',
        hex: frame(action).toString('hex') + frame(result).toString('hex'),
        cuts: [],
        records: [action, result],
      },
      ...Object.entries({
        zero: '00000000',
        oversize: '00010001',
        truncated: '000000047b7d',
        partialPrefix: '0000',
        invalidUtf8: '0000000222ff',
        badJson: '000000017b',
        bom: '00000005efbbbf7b7d',
        duplicate: '0000000d7b2261223a312c2261223a327d',
      }).map(([id, hex]) => ({ id, hex, cuts: [], records: null })),
    ],
    invalidMessages: [
      { ...requestStream.open, browser: 'work' },
      { ...requestStream.open, parent: 'L1' },
      { ...dataStream.open, mode: 'cdp' },
      { ...requestStream.open, jwk: { ...jwk, d: b64(label('not-a-secret')) } },
      { ...action, op: 'evaluate' },
      { ...action, args: { target: 'another-tab' } },
      { ...action, id: 0 },
      { ...action, jwt },
      { ...action, op: 'click', args: { x: 1, y: 1 } },
    ],
  };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(
    new URL('../../../lease-v1.json', import.meta.url),
    `${JSON.stringify(wireVectors(), null, 2)}\n`
  );
}
