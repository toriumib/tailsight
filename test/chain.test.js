/**
 * TailSight PoC — 証拠ハッシュチェーンの試験 (Node 18+)
 * 実行: node test/chain.test.js
 */
const EvidenceChain = require('../poc/evidence-chain.js');

function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL: ' + msg);
    process.exit(1);
  }
  console.log('PASS: ' + msg);
}

(async () => {
  const chain = new EvidenceChain('CASE-2026-0007', 'SES-TEST');

  const e1 = await chain.append('compliance.gate', { checks: 3, consentRef: 'CONS-2026-0118' }, 'phone');
  const e2 = await chain.append('session.start', { investigator: '調査員A' }, 'phone');
  await chain.append('target.stop_detected', { lat: 35.697, lng: 139.703, holdSec: 20 }, 'phone');
  await chain.append('evidence.photo', { file: 'EV-0001.jpg', distance: 142, bearing: 45 }, 'glasses');
  await chain.append('evidence.memo', { text: '対象がホテル方面へ歩行' }, 'glasses');
  const eLast = await chain.append('session.end', { elapsedSec: 3600, eventCount: 6 }, 'phone');

  // 1) 正規チェーンは検証OK
  const ok = await chain.verify();
  assert(ok.ok === true, 'clear chain verifies (entries=' + ok.entries + ')');

  // 2) 生成ブロック間の連結 (prevHash = 直前hash)
  assert(e2.prevHash === e1.hash, 'entry2 links to entry1');
  assert(eLast.seq === 6, 'sequence numbering 1..6');

  // 3) 正準化: キー順が異なる等価オブジェクトは同一ハッシュ
  const c1 = EvidenceChain.canonicalize({ b: 1, a: { z: 2, y: 3 } });
  const c2 = EvidenceChain.canonicalize({ a: { y: 3, z: 2 }, b: 1 });
  assert(c1 === c2, 'canonicalize is key-order independent');

  // 4) 改竄検出: 中盤のペイロードを書き換えると検証NG
  const tampered = JSON.parse(JSON.stringify(chain.entries));
  tampered[3].payload.distance = 999; // 写真イベントの距離を改竄
  const bad = await EvidenceChain.verify(tampered);
  assert(bad.ok === false && bad.firstBad === 3, 'tampered payload detected at seq 4 (' + bad.reason + ')');

  // 5) 改竄検出: 末尾イベントの時刻を書き換える
  const tampered2 = JSON.parse(JSON.stringify(chain.entries));
  tampered2[5].ts = '2027-01-01T00:00:00.000Z';
  const bad2 = await EvidenceChain.verify(tampered2);
  assert(bad2.ok === false && bad2.firstBad === 5, 'tampered timestamp detected at seq 6');

  // 6) エントリ削除(順序崩し)も検出
  const spliced = JSON.parse(JSON.stringify(chain.entries));
  spliced.splice(2, 1);
  const bad3 = await EvidenceChain.verify(spliced);
  assert(bad3.ok === false, 'deleted entry detected');

  // 7) 書き出し→再取り込みでも検証可能 (往復性)
  const exported = JSON.parse(JSON.stringify(chain.toJSON()));
  const round = await EvidenceChain.verify(exported.entries);
  assert(round.ok === true, 'export/import round-trip verifies');

  console.log('\nchain.test.js: 全試験合格 (7/7)');
})().catch((e) => {
  console.error('ERROR', e);
  process.exit(1);
});
