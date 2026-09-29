/**
 * TailSight TS-G1 PoC - デバイスアダプタ層
 * Rokid Glasses と Even Realities G2 の機種差を吸収する。
 * 共通I/F: caps(能力フラグ), photoActor(証拠撮影の主体), packet(state)→デバイス向け描画データ
 * ブラウザ/Node 両対応 (UMD)。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.Devices = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function fmtPct(v) { return Math.round(v) + '%'; }

  return {
    rokid: {
      id: 'rokid',
      label: 'Rokid Glasses',
      display: { res: '480x398/eye', color: 'green', type: 'waveguide' },
      caps: { camera: true, speaker: true, mic: true, ring: false },
      photoActor: 'glasses',
      // 電話SDK経由でYodaOSグラスアプリへguidanceカードをBLE送信する想定
      packet: function (s) {
        return {
          to: 'rokid://card/guidance',
          card: {
            arrowRelDeg: s.rel,
            distance: s.dist,
            eta: s.eta,
            targetState: s.target,
            risk: s.risk,
            prediction: s.pred || null,
          },
          tracker: { ageSec: s.age, batteryPct: fmtPct(s.battery), lte: s.lte },
          photoPath: 'glasses-camera',
        };
      },
    },

    evenG2: {
      id: 'evenG2',
      label: 'Even Realities G2',
      display: { res: '640x350', color: 'green', type: 'binocular-hud' },
      caps: { camera: false, speaker: false, mic: true, ring: true },
      photoActor: 'phone',
      // Webアプリ(Even App WebView)→BLE でHUD行データを送る想定。G2は短文4行程度がガイドライン。
      packet: function (s) {
        return {
          to: 'even://hud',
          lines: [
            (s.mode === 'lost-guide' ? 'LKP ' : '対象 ') + s.dist,
            s.target + ' / ' + s.age + '秒前',
            s.risk === 'ok' ? '---' : '!! ' + s.risk.toUpperCase(),
            'BAT ' + fmtPct(s.battery) + ' / ' + s.lte,
          ],
          arrowRelDeg: s.rel,
          prediction: s.pred || null,
          photoPath: 'phone-camera',
          feedback: 'earbud (スピーカーなし)',
        };
      },
    },
  };
});
