/**
 * TailSight PoC — デバイスアダプタ試験 (Node 18+)
 * 実行: node test/device.test.js
 */
const Devices = require('../poc/device-adapters.js');

function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL: ' + msg);
    process.exit(1);
  }
  console.log('PASS: ' + msg);
}

const sampleState = {
  mode: 'track', rel: 42, dist: '124 m', eta: '1分35秒',
  target: '移動中 5.0 km/h', age: 3, battery: 87.4, lte: '▮▮▮▮', risk: 'ok',
};

assert(Object.keys(Devices).sort().join(',') === 'evenG2,rokid', 'two adapters registered (rokid, evenG2)');

// Rokid: カメラ内蔵 → 証拠撮影はグラス単体
assert(Devices.rokid.caps.camera === true && Devices.rokid.photoActor === 'glasses', 'rokid has camera, photo actor = glasses');
const rp = Devices.rokid.packet(sampleState);
assert(rp.card && Number.isFinite(rp.card.arrowRelDeg) && rp.photoPath === 'glasses-camera', 'rokid packet: guidance card with arrow + glasses-camera path');

// Even G2: カメラなし → スマホカメラで代用、スピーカーなし
const g2 = Devices.evenG2;
assert(g2.caps.camera === false && g2.caps.speaker === false && g2.caps.mic === true, 'evenG2 caps: no camera/speaker, has mic');
assert(g2.photoActor === 'phone', 'evenG2 photo actor = phone');
const gp = g2.packet(sampleState);
assert(Array.isArray(gp.lines) && gp.lines.length > 0 && gp.lines.length <= 4, 'evenG2 packet: HUD lines within 4-line guideline');
assert(gp.lines.every((l) => typeof l === 'string' && l.length <= 24), 'evenG2 packet: each line is short (<=24 chars)');
assert(gp.photoPath === 'phone-camera' && gp.feedback.includes('earbud'), 'evenG2 packet: phone-camera path + earbud feedback');

// リスク/モード差分がパケットへ反映される
const alertPkt = g2.packet({ ...sampleState, mode: 'lost-guide', risk: 'critical' });
assert(alertPkt.lines[0].startsWith('LKP ') && alertPkt.lines[2].includes('CRITICAL'), 'evenG2 packet reflects lost-guide mode and critical risk');

// 機能分岐の一貫性: photoActorはcaps.cameraと矛盾しない
for (const k of Object.keys(Devices)) {
  const d = Devices[k];
  assert((d.caps.camera && d.photoActor === 'glasses') || (!d.caps.camera && d.photoActor === 'phone'),
    d.label + ': photoActor consistent with camera capability');
}

console.log('\ndevice.test.js: 全試験合格');
