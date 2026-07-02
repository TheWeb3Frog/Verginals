// Verginals inscription envelope: encode/decode per spec/VERGINALS-SPEC-v0.md §2.
// Dependency-free Bitcoin-script encoding. The envelope is dead code inside a P2SH
// redeemScript (OP_FALSE OP_IF ... OP_ENDIF), so minimal-push/opcode-count rules do not
// apply to it, so we encode every field as a uniform data push for simple, exact parsing.

const { limits } = require('./networks');

const OP_0 = 0x00; // also OP_FALSE; pushes empty
const OP_IF = 0x63;
const OP_ENDIF = 0x68;
const OP_CHECKSIG = 0xac;
const OP_PUSHDATA1 = 0x4c;
const OP_PUSHDATA2 = 0x4d;

const PROTOCOL = Buffer.from('ord', 'ascii'); // ord-compatible tag
const TAG_CONTENT_TYPE = 0x01;
const TAG_PARENT = 0x03;
const TAG_METADATA = 0x05;
// TAG body marker is OP_0 (0x00) per spec.

/**
 * Encode an inscription id ("<txid>iN") to the tag-3 parent value: the 32-byte txid in internal
 * (little-endian) byte order, followed by the output index as little-endian with trailing zero
 * bytes stripped (so iN with N=0 is just the 32-byte txid). Matches ord (spec §10.1).
 */
function parentIdToBuffer(id) {
  const m = /^([0-9a-fA-F]{64})i(\d+)$/.exec(String(id));
  if (!m) throw new Error(`bad inscription id: ${id}`);
  const txidLE = Buffer.from(m[1], 'hex').reverse(); // display order -> internal order
  const idxBytes = [];
  let index = Number(m[2]);
  while (index > 0) {
    idxBytes.push(index & 0xff);
    index = Math.floor(index / 256);
  }
  return Buffer.concat([txidLE, Buffer.from(idxBytes)]);
}

/** Inverse of parentIdToBuffer: tag-3 parent value -> "<txid>iN". */
function bufferToParentId(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 32) throw new Error('bad parent buffer');
  const txid = Buffer.from(buf.subarray(0, 32)).reverse().toString('hex');
  let index = 0;
  for (let i = buf.length - 1; i >= 32; i--) index = index * 256 + buf[i];
  return `${txid}i${index}`;
}

const { MAX_SCRIPT_ELEMENT_SIZE, MAX_STANDARD_P2SH_SCRIPT_SIZE } = limits;

/** Encode a single data push (≤520 bytes enforced by caller for body chunks). */
function pushData(buf) {
  const len = buf.length;
  if (len === 0) return Buffer.from([OP_0]);
  if (len < OP_PUSHDATA1) return Buffer.concat([Buffer.from([len]), buf]);
  if (len <= 0xff) return Buffer.concat([Buffer.from([OP_PUSHDATA1, len]), buf]);
  if (len <= 0xffff) {
    return Buffer.concat([Buffer.from([OP_PUSHDATA2, len & 0xff, len >> 8]), buf]);
  }
  throw new Error(`push too large: ${len} (chunk before encoding)`);
}

/** Split a body buffer into ≤520-byte chunks. */
function chunkBody(body) {
  const chunks = [];
  for (let i = 0; i < body.length; i += MAX_SCRIPT_ELEMENT_SIZE) {
    chunks.push(body.subarray(i, i + MAX_SCRIPT_ELEMENT_SIZE));
  }
  return chunks;
}

/**
 * Build one inscription redeemScript (revealed in the P2SH scriptSig when spending):
 *   <pubkey> OP_CHECKSIG OP_FALSE OP_IF "ord" [1 <ctype>] [5 <meta>]* 0 <body...> OP_ENDIF
 * When spent, OP_FALSE OP_IF…OP_ENDIF is skipped (dead code) and <pubkey> OP_CHECKSIG authorizes
 * the spend. The whole script is pushed as one scriptSig element, so it must stay ≤ maxScriptSize.
 * @param {Object} p
 * @param {Buffer} p.pubkey 33-byte compressed pubkey that authorizes the reveal spend
 * @param {string|Buffer} [p.contentType] MIME type (first input only for multi-input)
 * @param {Buffer} [p.body] payload bytes for THIS input (already sized to fit, see planInputs)
 * @param {Buffer} [p.parent] optional tag-3 parent inscription id (see parentIdToBuffer)
 * @param {Buffer} [p.metadata] optional CBOR metadata
 * @param {boolean} [p.bodyOnly] continuation input: omit content-type/parent/metadata
 * @param {number} [p.maxScriptSize] standardness cap for the script (default P2SH 520)
 * @returns {Buffer} the redeemScript
 */
function buildInscriptionScript({
  pubkey,
  contentType,
  body = Buffer.alloc(0),
  parent,
  metadata,
  bodyOnly = false,
  maxScriptSize = MAX_STANDARD_P2SH_SCRIPT_SIZE,
}) {
  if (!Buffer.isBuffer(pubkey) || pubkey.length !== 33) {
    throw new Error('pubkey must be a 33-byte compressed key');
  }
  const parts = [
    pushData(pubkey),
    Buffer.from([OP_CHECKSIG, OP_0, OP_IF]),
    pushData(PROTOCOL),
  ];
  if (!bodyOnly) {
    if (contentType != null) {
      const ct = Buffer.isBuffer(contentType) ? contentType : Buffer.from(contentType, 'utf8');
      parts.push(pushData(Buffer.from([TAG_CONTENT_TYPE])), pushData(ct));
    }
    if (parent != null) {
      parts.push(pushData(Buffer.from([TAG_PARENT])), pushData(parent));
    }
    if (metadata != null) {
      parts.push(pushData(Buffer.from([TAG_METADATA])), pushData(metadata));
    }
  }
  parts.push(Buffer.from([OP_0])); // body marker (tag 0)
  for (const chunk of chunkBody(body)) parts.push(pushData(chunk));
  parts.push(Buffer.from([OP_ENDIF]));

  const script = Buffer.concat(parts);
  if (script.length > maxScriptSize) {
    throw new Error(
      `redeemScript ${script.length}B exceeds standard P2SH limit ${maxScriptSize}B; ` +
        `split body across inputs (see planInputs)`
    );
  }
  return script;
}

/** Read one data push starting at offset i. Returns { data, next } or null if not a push. */
function readPush(script, i) {
  const op = script[i];
  if (op === OP_0) return { data: Buffer.alloc(0), next: i + 1 };
  if (op < OP_PUSHDATA1) return { data: script.subarray(i + 1, i + 1 + op), next: i + 1 + op };
  if (op === OP_PUSHDATA1) {
    const len = script[i + 1];
    return { data: script.subarray(i + 2, i + 2 + len), next: i + 2 + len };
  }
  if (op === OP_PUSHDATA2) {
    const len = script[i + 1] | (script[i + 2] << 8);
    return { data: script.subarray(i + 3, i + 3 + len), next: i + 3 + len };
  }
  return null; // structural opcode, not a push
}

/**
 * Parse an inscription envelope out of a redeemScript.
 * @returns {{contentType: Buffer|null, parents: Buffer[], metadata: Buffer[], body: Buffer}|null}
 */
function parseInscriptionScript(script) {
  // Locate the magic prefix: OP_FALSE OP_IF push("ord")  ==  00 63 03 6f 72 64
  const magic = Buffer.from([OP_0, OP_IF, 0x03, 0x6f, 0x72, 0x64]);
  const start = script.indexOf(magic);
  if (start === -1) return null;

  let i = start + magic.length; // positioned just after "ord"
  let contentType = null;
  const parents = [];
  const metadata = [];
  const bodyChunks = [];
  let inBody = false;

  while (i < script.length) {
    if (script[i] === OP_ENDIF) break;
    const push = readPush(script, i);
    if (!push) return null; // malformed: unexpected opcode inside envelope

    if (inBody) {
      bodyChunks.push(push.data);
      i = push.next;
      continue;
    }
    // field region: tag pushes are single bytes; tag 0 (empty push) starts the body
    if (push.data.length === 0) {
      inBody = true;
      i = push.next;
      continue;
    }
    const tag = push.data[0];
    const valuePush = readPush(script, push.next);
    if (!valuePush) return null;
    if (tag === TAG_CONTENT_TYPE) contentType = valuePush.data;
    else if (tag === TAG_PARENT) parents.push(valuePush.data);
    else if (tag === TAG_METADATA) metadata.push(valuePush.data);
    // unknown odd tags: skip value (forward-compat)
    i = valuePush.next;
  }

  return { contentType, parents, metadata, body: Buffer.concat(bodyChunks) };
}

/** Overhead (non-body bytes) of a redeemScript with the given content-type/parent/metadata. */
function overheadBytes({ contentType, parent, metadata } = {}) {
  // pubkey push (1+33) + CHECKSIG + FALSE + IF + push("ord")(1+3) + body marker + ENDIF
  let n = 34 + 1 + 1 + 1 + 4 + 1 + 1;
  if (contentType != null) {
    const ct = Buffer.isBuffer(contentType) ? contentType : Buffer.from(contentType, 'utf8');
    n += 2 /* tag push */ + pushData(ct).length;
  }
  if (parent != null) n += 2 + pushData(parent).length;
  if (metadata != null) n += 2 + pushData(metadata).length;
  return n;
}

/**
 * Max body bytes that fit in one redeemScript given its overhead. The body push needs a prefix
 * (worst case PUSHDATA2 = 3 bytes). For small P2SH scripts (≤520) the body is a single push; for
 * larger caps it may span several 520-byte chunks.
 */
function bodyBudget(overhead, maxScriptSize = MAX_STANDARD_P2SH_SCRIPT_SIZE) {
  const available = maxScriptSize - overhead;
  if (available <= 3) return 0;
  const perChunk = MAX_SCRIPT_ELEMENT_SIZE + 3; // 520 body + PUSHDATA2 prefix
  if (available >= perChunk) {
    return Math.floor(available / perChunk) * MAX_SCRIPT_ELEMENT_SIZE;
  }
  return available - 3; // single push, reserve 3 bytes for the prefix
}

/**
 * Plan how to split a payload across reveal inputs so every redeemScript stays standard.
 * @returns {{inputs: number, perInputBody: number[]}} body byte count carried by each input
 */
function planInputs(body, { contentType, parent, metadata, maxScriptSize = MAX_STANDARD_P2SH_SCRIPT_SIZE } = {}) {
  const budgetFirst = bodyBudget(overheadBytes({ contentType, parent, metadata }), maxScriptSize);
  const budgetRest = bodyBudget(overheadBytes({}), maxScriptSize);
  if (budgetFirst <= 0 || budgetRest <= 0) {
    throw new Error('content-type/parent/metadata too large to leave room for body in a 520B redeemScript');
  }
  const perInputBody = [];
  let remaining = body.length;
  // first input carries content-type/metadata
  const first = Math.min(remaining, budgetFirst);
  perInputBody.push(first);
  remaining -= first;
  while (remaining > 0) {
    const take = Math.min(remaining, budgetRest);
    perInputBody.push(take);
    remaining -= take;
  }
  return { inputs: perInputBody.length, perInputBody };
}

module.exports = {
  pushData,
  chunkBody,
  buildInscriptionScript,
  parseInscriptionScript,
  overheadBytes,
  planInputs,
  parentIdToBuffer,
  bufferToParentId,
  PROTOCOL,
  TAG_CONTENT_TYPE,
  TAG_PARENT,
  TAG_METADATA,
};
