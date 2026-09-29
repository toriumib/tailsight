/**
 * TailSight TS-G1 PoC - Evidence hash chain
 * ブラウザ/Node 両対応 (UMD)。
 * 各エントリ: hash = SHA-256( prevHash | canonical_json(core fields) )
 * canonical_json はキーを辞書順に並べた再帰的直列化で、環境差異によるハッシュ不一致を防ぐ。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.EvidenceChain = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var GENESIS = new Array(65).join('0'); // 64 個の '0'

  function canonicalize(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value === undefined ? null : value);
    if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
    var keys = Object.keys(value).sort();
    return '{' + keys.map(function (k) {
      return JSON.stringify(k) + ':' + canonicalize(value[k]);
    }).join(',') + '}';
  }

  function getSubtle() {
    if (typeof globalThis !== 'undefined' && globalThis.crypto && globalThis.crypto.subtle) {
      return globalThis.crypto.subtle;
    }
    if (typeof require === 'function') {
      return require('crypto').webcrypto.subtle;
    }
    throw new Error('WebCrypto unavailable');
  }

  function toHex(buf) {
    var bytes = new Uint8Array(buf);
    var out = '';
    for (var i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
    return out;
  }

  async function sha256Hex(text) {
    var subtle = getSubtle();
    var data = new TextEncoder().encode(text);
    var digest = await subtle.digest('SHA-256', data);
    return toHex(digest);
  }

  function coreOf(entry) {
    return {
      seq: entry.seq,
      caseId: entry.caseId,
      sessionId: entry.sessionId,
      ts: entry.ts,
      type: entry.type,
      actor: entry.actor,
      payload: entry.payload
    };
  }

  async function hashEntry(prevHash, entry) {
    return sha256Hex(prevHash + '|' + canonicalize(coreOf(entry)));
  }

  function EvidenceChain(caseId, sessionId) {
    this.caseId = caseId;
    this.sessionId = sessionId;
    this.entries = [];
  }

  EvidenceChain.prototype.lastHash = function () {
    return this.entries.length ? this.entries[this.entries.length - 1].hash : GENESIS;
  };

  EvidenceChain.prototype.append = async function (type, payload, actor, ts) {
    var entry = {
      seq: this.entries.length + 1,
      caseId: this.caseId,
      sessionId: this.sessionId,
      ts: ts || new Date().toISOString(),
      type: type,
      actor: actor || 'phone',
      payload: payload || {}
    };
    entry.prevHash = this.lastHash();
    entry.hash = await hashEntry(entry.prevHash, entry);
    this.entries.push(entry);
    return entry;
  };

  EvidenceChain.verify = async function (entries) {
    var prev = GENESIS;
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      if (e.prevHash !== prev) {
        return { ok: false, firstBad: i, reason: 'prevHash mismatch at seq ' + (i + 1) };
      }
      var h = await hashEntry(e.prevHash, e);
      if (h !== e.hash) {
        return { ok: false, firstBad: i, reason: 'hash mismatch at seq ' + (i + 1) };
      }
      prev = e.hash;
    }
    return { ok: true, firstBad: -1, entries: entries.length };
  };

  EvidenceChain.prototype.verify = function () {
    return EvidenceChain.verify(this.entries);
  };

  EvidenceChain.prototype.toJSON = function () {
    return { caseId: this.caseId, sessionId: this.sessionId, exportedAt: new Date().toISOString(), entries: this.entries.slice() };
  };

  EvidenceChain.GENESIS = GENESIS;
  EvidenceChain.canonicalize = canonicalize;

  return EvidenceChain;
});
