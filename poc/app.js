/* TailSight TS-G1 PoC - 調査追跡シミュレータ + HUD + 証拠チェーン
 *
 * 前提: 依頼者所有車両・同意取得済みのGPS調査、公開場所での調査を模擬。
 * デモ内の対象位置・軌跡はすべて模擬データ(新宿・歌舞伎町周回コース)。
 */
(function () {
  'use strict';

  const Devices = (typeof window !== 'undefined' && window.Devices)
    ? window.Devices
    : require('./device-adapters.js');

  /* ---------------- Geo utils ---------------- */
  const R_EARTH = 6371000;
  const rad = (d) => (d * Math.PI) / 180;
  const deg = (r) => (r * 180) / Math.PI;

  function haversine(a, b) {
    const dLat = rad(b.lat - a.lat);
    const dLng = rad(b.lng - a.lng);
    const s =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R_EARTH * Math.asin(Math.sqrt(s));
  }

  function bearing(a, b) {
    const y = Math.sin(rad(b.lng - a.lng)) * Math.cos(rad(b.lat));
    const x =
      Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) -
      Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lng - a.lng));
    return (deg(Math.atan2(y, x)) + 360) % 360;
  }

  function moveToward(p, q, meters) {
    const d = haversine(p, q);
    if (d < 1e-9) return { lat: p.lat, lng: p.lng };
    const f = Math.min(1, meters / d);
    return { lat: p.lat + (q.lat - p.lat) * f, lng: p.lng + (q.lng - p.lng) * f };
  }

  const norm180 = (d) => ((d + 540) % 360) - 180;
  const lerpAngle = (a, b, t) => a + norm180(b - a) * t;

  const COMPASS_JA = ['北', '北東', '東', '南東', '南', '南西', '西', '北西'];
  const compassJa = (brg) => COMPASS_JA[Math.round(((brg % 360) + 360) % 360 / 45) % 8];

  function fmtDist(m) {
    return m >= 1000 ? (m / 1000).toFixed(2) + ' km' : Math.round(m) + ' m';
  }
  function fmtDur(sec) {
    sec = Math.max(0, Math.round(sec));
    const m = Math.floor(sec / 60);
    return m > 0 ? m + '分' + String(sec % 60).padStart(2, '0') + '秒' : sec + '秒';
  }
  function fmtClock(iso) {
    const d = new Date(iso);
    return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
  }

  /* ---------------- State ---------------- */
  const CASE_ID = 'CASE-2026-0007';

  // 模擬走行ルート (新宿駅東口 → 歌舞伎町 → 都庁 → 西口 → 戻る)
  const WAYPOINTS = [
    { lat: 35.6896, lng: 139.7006 },
    { lat: 35.6908, lng: 139.7017 },
    { lat: 35.6930, lng: 139.7015 },
    { lat: 35.6950, lng: 139.7023 },
    { lat: 35.6965, lng: 139.7032 },
    { lat: 35.6972, lng: 139.7046 },
    { lat: 35.6985, lng: 139.7038 },
    { lat: 35.6983, lng: 139.7010 },
    { lat: 35.6965, lng: 139.6997 },
    { lat: 35.6946, lng: 139.6984 },
    { lat: 35.6923, lng: 139.6962 },
    { lat: 35.6905, lng: 139.6960 },
    { lat: 35.6896, lng: 139.6981 },
  ];

  const WAYPOINT_NAMES = ['新宿駅東口', '東口商店街', '歌舞伎町入口', '歌舞伎町一番街', '歌舞伎町北', 'ホテル街', '職安通り', '歌舞伎町西', '西武新宿駅', '新宿駅北口', '都庁前', '都庁西', '新宿西口'];

  const S = {
    started: false,
    ended: false,
    mode: 'track',            // 'track' | 'lost-guide'
    invMode: 'auto',          // 'auto' | 'manual'
    inv: { pos: { lat: 35.6902, lng: 139.6994 }, heading: 20, dest: null },
    target: {
      idx: 0,
      pos: { ...WAYPOINTS[0] },
      baseSpeed: 1.4,         // m/s (徒歩相当)
      dwellLeft: 0,           // 停止残り秒
      stoppedFor: 0,
      trail: [],
    },
    tracker: { battery: 87, age: 3, lastFix: null },
    speedMult: 1,
    risk: 'ok',
    flags: { stopLogged: false, warnLogged: false, critLogged: false },
    chain: null,
    chainQueue: Promise.resolve(),
    photoCount: 0,
    startAt: null,
    elapsed: 0,
    lkp: null,
    voiceLines: [],
    device: 'rokid',
    audioLink: false,
    tts: true,
    heatOn: false,
    pred: null,
    predCache: { label: '', ts: 0 },
    poiVisits: WAYPOINT_NAMES.map(() => 0),
    stats: { moveM: 0, stops: 0 },
    replay: { active: false, playing: false, playTimer: null, snapshots: [] },
    officeFlash: 0,
    officeMsg: '',
    eyeAuto: true,
  };

  /* ---------------- DOM ---------------- */
  const $ = (id) => document.getElementById(id);
  const els = {
    modal: $('consentModal'), startBtn: $('btnStartSession'),
    checks: Array.from(document.querySelectorAll('.consent-check')),
    caseId: $('caseId'), recDot: $('recDot'), recTime: $('recTime'), modeBadge: $('modeBadge'),
    hudArrow: $('hudArrow'), hudBearing: $('hudBearing'), hudDistance: $('hudDistance'),
    hudEta: $('hudEta'), hudTargetStatus: $('hudTargetStatus'), hudPosAge: $('hudPosAge'),
    hudBattery: $('hudBattery'), hudLte: $('hudLte'), hudRisk: $('hudRisk'),
    voiceLog: $('voiceLog'),
    invPos: $('invPos'), tgtPos: $('tgtPos'),
    btnAuto: $('btnModeAuto'), btnManual: $('btnModeManual'), btnFace: $('btnFaceTarget'),
    btnLost: $('btnDeclareLost'), btnEnd: $('btnEndSession'),
    selSpeed: $('selSpeed'), selVoice: $('selVoice'),
    inpMemo: $('inpMemo'), btnMemo: $('btnMemo'), btnPhoto: $('btnPhoto'),
    btnExport: $('btnExport'), btnVerify: $('btnVerify'), verifyResult: $('verifyResult'),
    evBody: $('evBody'), evCount: $('evCount'),
    map: $('map'), radar: $('radarCanvas'), toast: $('toast'),
    hudCard: $('hudCard'), packetPre: $('packetPre'),
    selDevice: $('selDevice'), btnVerifySubj: $('btnVerifySubj'), btnAudioLink: $('btnAudioLink'),
    antenna: $('antenna'), hudPredict: $('hudPredict'),
    btnTts: $('btnTts'), btnReplay: $('btnReplay'), btnHeat: $('btnHeat'), btnReport: $('btnReport'),
    replayBar: $('replayBar'), replayRange: $('replayRange'), replayTime: $('replayTime'),
    btnReplayPlay: $('btnReplayPlay'), btnReplayExit: $('btnReplayExit'),
    deducePred: $('deducePred'), deduceSummary: $('deduceSummary'),
    btnOfficeWarn: $('btnOfficeWarn'), btnOfficeDetour: $('btnOfficeDetour'), btnOfficeAbort: $('btnOfficeAbort'),
    bootOverlay: $('bootOverlay'), bootText: $('bootText'),
    reportModal: $('reportModal'), reportBody: $('reportBody'),
    btnReportPrint: $('btnReportPrint'), btnReportDl: $('btnReportDl'), btnReportClose: $('btnReportClose'),
    btnEyeView: $('btnEyeView'), eyeView: $('eyeView'), eyeCanvas: $('eyeCanvas'),
    eyeHudG2: $('eyeHudG2'), eyeHudRokid: $('eyeHudRokid'),
    eyeDevLabel: $('eyeDevLabel'), eyeRecTime: $('eyeRecTime'), btnEyeClose: $('btnEyeClose'),
  };

  function toast(msg) {
    els.toast.textContent = msg;
    els.toast.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => els.toast.classList.remove('show'), 2500);
  }

  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // 音声読み上げ (Web Speech API / ja-JP) — 調査員自身のデバイスへのフィードバックのみ
  function speak(text) {
    if (!S.tts) return;
    try {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'ja-JP'; u.rate = 1.05;
      speechSynthesis.cancel();
      speechSynthesis.speak(u);
    } catch (e) { /* 音声API未対応環境では無視 */ }
  }

  /* ---------------- Map (Leaflet, 失敗時レーダーfallback) ---------------- */
  let map = null, mkInv, mkTgt, mkLKP, circleLKP, lineInv, lineTgt, lineRoute;
  let invTrail = [];

  function initMap() {
    if (typeof L === 'undefined') { els.radar.classList.remove('hidden'); return; }
    map = L.map('map', { zoomControl: true }).setView([35.6940, 139.7005], 15);
    // CartoダークタイルはAPIキー必須化済み(ウォーターマーク画像が返る)のため OSM 標準タイルを使用
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      maxZoom: 19,
    }).addTo(map);

    lineRoute = L.polyline(WAYPOINTS.map((p) => [p.lat, p.lng]), { color: '#555', dashArray: '4 6', weight: 2 }).addTo(map);
    lineTgt = L.polyline([], { color: '#ff5f6d', weight: 3 }).addTo(map);
    lineInv = L.polyline([], { color: '#39d0ff', weight: 3 }).addTo(map);

    mkTgt = L.circleMarker([S.target.pos.lat, S.target.pos.lng], { radius: 8, color: '#ff5f6d', fillOpacity: 0.9 }).addTo(map)
      .bindTooltip('対象 (トラッカー)', { permanent: false });
    mkInv = L.marker([S.inv.pos.lat, S.inv.pos.lng], {
      icon: L.divIcon({
        className: 'inv-icon',
        html: '<div id="invArrow">▲</div>',
        iconSize: [26, 26],
      }),
    }).addTo(map).bindTooltip('調査員', { permanent: false });

    map.on('click', (e) => {
      if (!S.started || S.ended) return;
      if (S.invMode !== 'manual') { toast('手動モードに切り替えると移動指示できます'); return; }
      S.inv.dest = { lat: e.latlng.lat, lng: e.latlng.lng };
      toast('移動先を指示しました');
    });
  }

  /* ---------------- HUD ---------------- */
  function updateHUD() {
    const now = Date.now();
    const focus = S.mode === 'lost-guide' && S.lkp ? S.lkp.pos : S.target.pos;
    const dist = haversine(S.inv.pos, focus);
    const brg = bearing(S.inv.pos, focus);
    const rel = norm180(brg - S.inv.heading);

    els.hudArrow.style.transform = `rotate(${rel}deg)`;
    els.hudBearing.textContent = `${compassJa(brg)} / ${Math.round((brg + 360) % 360)}° (相対 ${Math.round(rel)}°)`;
    els.hudDistance.textContent = fmtDist(dist);
    els.hudEta.textContent = '徒歩 約 ' + fmtDur(dist / 1.3);

    const speed = S.target.dwellLeft > 0 ? 0 : S.target.baseSpeed * S.speedMult;
    els.hudTargetStatus.textContent = S.target.dwellLeft > 0
      ? `停止 ${fmtDur(S.target.stoppedFor)}`
      : `移動中 ${(speed * 3.6).toFixed(1)} km/h`;
    els.hudPosAge.textContent = `位置情報 ${Math.round(S.tracker.age)}秒前`;
    els.hudBattery.textContent = `トラッカー電池 ${Math.round(S.tracker.battery)}%`;
    const lte = S.tracker.age < 4 ? 'LTE ▮▮▮▮' : S.tracker.age < 6 ? 'LTE ▮▮▮▯' : 'LTE ▮▮▯▯';
    els.hudLte.textContent = lte;

    if (!S.started || S.ended) {
      els.modeBadge.textContent = S.ended ? '終了' : '待機';
      els.modeBadge.className = 'badge track';
    } else if (S.mode === 'lost-guide') {
      els.modeBadge.textContent = 'LKP誘導';
      els.modeBadge.className = 'badge lost';
    } else {
      els.modeBadge.textContent = '追跡中';
      els.modeBadge.className = 'badge track';
    }
    els.antenna.classList.toggle('on', S.started && !S.ended && S.mode === 'track');

    let riskTxt = '', riskCls = 'ok';
    if (!S.started) riskTxt = '待機中';
    else if (S.officeFlash && Date.now() - S.officeFlash < 6000) {
      riskTxt = '⚠ [事務所] ' + S.officeMsg; riskCls = 'critical';
    }
    else if (S.mode === 'lost-guide') { riskTxt = '⚠ 接触喪失 — 最終既知位置へ誘導中'; riskCls = 'critical'; }
    else if (dist > 400) { riskTxt = '⚠ 接触喪失リスク (' + fmtDist(dist) + ')'; riskCls = 'critical'; }
    else if (dist > 250) { riskTxt = '⚠ 距離拡大 (' + fmtDist(dist) + ')'; riskCls = 'warn'; }
    els.hudRisk.textContent = riskTxt;
    els.hudRisk.className = 'hud-risk ' + riskCls;
    S.risk = riskCls;

    els.recTime.textContent = S.started && !S.ended
      ? [Math.floor(S.elapsed / 60), S.elapsed % 60].map((n) => String(n).padStart(2, '0')).join(':')
      : '--:--';
    els.recDot.classList.toggle('off', !S.started || S.ended);

    els.invPos.textContent = `${S.inv.pos.lat.toFixed(5)}, ${S.inv.pos.lng.toFixed(5)} / 向き ${Math.round((S.inv.heading + 360) % 360)}°`;
    els.tgtPos.textContent = S.tracker.lastFix
      ? `${S.tracker.lastFix.pos.lat.toFixed(5)}, ${S.tracker.lastFix.pos.lng.toFixed(5)} (${Math.round(S.tracker.age)}秒前)`
      : '---';

    // デバイスアダプタ: 選択中グラスへの送信パケット生成 (Rokid=カード / Even G2=短文HUD行)
    els.selDevice.value = S.device; // 装着視界内トグル等との表示同期
    const dev = Devices[S.device];
    const pkt = dev.packet({
      mode: S.mode,
      rel: Math.round(rel),
      dist: fmtDist(dist),
      eta: fmtDur(dist / 1.3),
      target: els.hudTargetStatus.textContent,
      age: Math.round(S.tracker.age),
      battery: S.tracker.battery,
      lte: lte.replace('LTE ', ''),
      risk: riskCls,
      pred: S.pred && S.started ? S.pred.label + ' ' + S.pred.pct + '%' : null,
    });
    els.packetPre.textContent =
      '// BLE送信パケット → ' + dev.label + ' (シミュレーション)\n' + JSON.stringify(pkt);
    els.hudCard.classList.toggle('g2', S.device === 'evenG2');

    if (map) {
      mkTgt.setLatLng([S.target.pos.lat, S.target.pos.lng]);
      mkInv.setLatLng([S.inv.pos.lat, S.inv.pos.lng]);
      const arrow = document.getElementById('invArrow');
      if (arrow) arrow.style.transform = `rotate(${S.inv.heading}deg)`;
      lineTgt.setLatLngs(S.target.trail.map((p) => [p.lat, p.lng]));
      lineInv.setLatLngs(invTrail.map((p) => [p.lat, p.lng]));
    } else {
      drawRadar(rel, dist);
    }
  }

  function drawRadar(relBearing, dist) {
    const c = els.radar;
    const g = c.getContext('2d');
    const w = c.width, h = c.height, cx = w / 2, cy = h / 2, maxR = Math.min(w, h) / 2 - 10;
    g.clearRect(0, 0, w, h);
    g.strokeStyle = 'rgba(51,255,153,0.4)';
    g.fillStyle = 'rgba(51,255,153,0.9)';
    g.font = '12px monospace';
    for (const [m, r] of [[100, 0.33], [200, 0.66], [300, 1.0]]) {
      g.beginPath(); g.arc(cx, cy, maxR * r, 0, Math.PI * 2); g.stroke();
      g.fillText(m + 'm', cx + 4, cy - maxR * r + 12);
    }
    // 距離を300mスケールにクランプ
    const r = Math.min(1, dist / 300) * maxR;
    const a = (relBearing * Math.PI) / 180 - Math.PI / 2;
    g.beginPath(); g.arc(cx + r * Math.cos(a), cy + r * Math.sin(a), 6, 0, Math.PI * 2); g.fill();
    g.fillText('対象', cx + r * Math.cos(a) + 8, cy + r * Math.sin(a));
    g.fillText('↑ 調査員の向き', cx - 36, cy - 8);
  }

  /* ---------------- Evidence chain ---------------- */
  function logEvent(type, payload, actor) {
    if (!S.chain) return;
    S.chainQueue = S.chainQueue.then(async () => {
      const e = await S.chain.append(type, payload, actor);
      renderEvidenceRow(e);
      els.evCount.textContent = S.chain.entries.length;
      return e;
    });
    return S.chainQueue;
  }

  function briefOf(e) {
    const p = e.payload || {};
    switch (e.type) {
      case 'evidence.photo': return `${p.file} 距離${fmtDist(p.distance || 0)} (${p.note || ''})`;
      case 'evidence.memo': return String(p.text || '');
      case 'target.stop_detected': return `位置 ${p.lat?.toFixed(4)},${p.lng?.toFixed(4)} 停止${p.holdSec || 0}秒`;
      case 'target.resume': return '移動再開';
      case 'risk.warn': return `距離 ${fmtDist(p.distance || 0)}`;
      case 'risk.critical': return `距離 ${fmtDist(p.distance || 0)} — 接触喪失リスク`;
      case 'lost.declared': return `LKP ${p.lat?.toFixed(4)},${p.lng?.toFixed(4)}`;
      case 'target.reacquired': return `距離 ${fmtDist(p.distance || 0)}`;
      case 'voice.command': return `「${p.utterance}」 → ${p.intent}`;
      case 'subject.verify': return `結果:${p.result} 信頼度${Math.round((p.confidence || 0) * 100)}% (参照:${p.reference})`;
      case 'audio.link': return `${p.state === 'open' ? '接続' : '切断'} (${p.mode})`;
      case 'deduce.prediction': return `次の目的地: ${p.target} ${p.probability}%` + (p.etaSec ? ` / 約${Math.round(p.etaSec / 60)}分` : '');
      case 'office.push': return `指示:${p.kind} (${p.by})`;
      case 'session.start': return `調査員:${p.investigator} 同意:${p.consentRef}`;
      case 'session.end': return `継続${fmtDur(p.elapsedSec || 0)} イベント${p.eventCount}件`;
      case 'compliance.gate': return `確認項目 ${p.checks}件 OK`;
      default: return '';
    }
  }

  function renderEvidenceRow(e) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${e.seq}</td><td>${fmtClock(e.ts)}</td><td>${e.type}</td>` +
      `<td>${briefOf(e)}</td><td class="hash">${e.hash.slice(0, 10)}…</td><td>${e.actor}</td>`;
    els.evBody.prepend(tr);
  }

  /* ---------------- 推理エンジン DEDUCE (行動予測) ---------------- */
  function nearPOI(pos) {
    for (let i = 0; i < WAYPOINTS.length; i++) {
      if (haversine(WAYPOINTS[i], pos) < 90) return WAYPOINT_NAMES[i];
    }
    return null;
  }

  // 進行方向・近さ・過去の滞在頻度から次の目的地をスコアリングしsoftmaxで確率化
  function updatePrediction() {
    const t = S.target;
    const n = t.trail.length;
    if (n < 5) return;
    const a = t.trail[n - 4], b = t.trail[n - 1];
    const stepM = haversine(a, b);
    const spd = stepM / 3; // 3tick = 3秒
    const head = stepM > 1 ? bearing(a, b) : S.pred ? S.pred.head : 0;
    if (t.dwellLeft > 0) { renderPrediction(); return; }

    const scored = WAYPOINTS.map((w, i) => {
      const d = haversine(t.pos, w);
      if (d < 80) return null;
      const align = Math.cos(rad(norm180(bearing(t.pos, w) - head)));
      return { i, d, s: align * 2 + 1 / (1 + d / 500) + (S.poiVisits[i] || 0) / 8 };
    }).filter(Boolean).sort((x, y) => y.s - x.s);
    if (scored.length < 2) return;

    const top = scored.slice(0, 2);
    const exps = top.map((x) => Math.exp(x.s));
    const pct = Math.max(55, Math.min(96, Math.round((exps[0] / (exps[0] + exps[1])) * 100)));
    const etaSec = spd > 0.2 ? top[0].d / spd : null;
    S.pred = {
      label: WAYPOINT_NAMES[top[0].i], alt: WAYPOINT_NAMES[top[1].i],
      pct, etaSec, head,
    };
    renderPrediction();

    if (S.pred.label !== S.predCache.label && S.elapsed - (S.predCache.ts || 0) > 20) {
      S.predCache = { label: S.pred.label, ts: S.elapsed };
      logEvent('deduce.prediction', { target: S.pred.label, probability: pct, etaSec: etaSec ? Math.round(etaSec) : null }, 'cloud');
    }
  }

  function renderPrediction() {
    if (!S.pred || !S.started) {
      els.hudPredict.textContent = S.started ? '解析中…' : '---';
      els.deducePred.textContent = '解析待ち… (移動データ蓄積中)';
      return;
    }
    const eta = S.pred.etaSec ? ' 約' + fmtDur(S.pred.etaSec) : '';
    els.hudPredict.textContent = `${S.pred.label} ${S.pred.pct}%`;
    els.deducePred.textContent = `▶ 次の目的地予測: ${S.pred.label} (${S.pred.pct}%${eta}) — 次点: ${S.pred.alt}`;
    els.deduceSummary.textContent = buildSummary();
  }

  function buildSummary() {
    if (!S.started) return 'セッション開始後、移動パターンから次の行動を予測します。';
    const t = S.target;
    const d = haversine(S.inv.pos, t.pos);
    const near = nearPOI(t.pos);
    const parts = [];
    parts.push(`対象は${t.dwellLeft > 0 ? near ? near + '付近で' + fmtDur(t.stoppedFor) + '停止中' : '停止中' : compassJa(bearing(S.inv.pos, t.pos)) + '方向へ移動中'}`);
    parts.push(`調査員との距離 ${fmtDist(d)}`);
    if (S.pred) parts.push(`進行先は${S.pred.label}の可能性 ${S.pred.pct}%`);
    parts.push(`これまでに停止 ${S.stats.stops}回・移動 ${fmtDist(S.stats.moveM)}・証拠 ${S.photoCount}件を記録`);
    return parts.join('。') + '。';
  }

  /* ---------------- 滞在ヒートマップ ---------------- */
  let heatLayer = null;
  function toggleHeat() {
    if (!map) { toast('地図未表示のため利用できません'); return; }
    S.heatOn = !S.heatOn;
    els.btnHeat.classList.toggle('active', S.heatOn);
    if (S.heatOn) {
      buildHeat();
      toast('滞在ヒートマップ表示 — 滞在時間に比例 (素行調査の報告要素)');
    } else {
      if (heatLayer) { map.removeLayer(heatLayer); heatLayer = null; }
      toast('ヒートマップ解除');
    }
  }
  function buildHeat() {
    if (heatLayer) map.removeLayer(heatLayer);
    heatLayer = L.layerGroup(
      WAYPOINTS.map((w, i) => {
        const v = S.poiVisits[i] || 0;
        if (v < 5) return null;
        const r = Math.min(150, 25 + v * 5);
        const hue = Math.max(0, 120 - v * 4); // 長時間滞在ほど赤く
        return L.circle([w.lat, w.lng], {
          radius: r, color: `hsl(${hue},90%,50%)`, fillColor: `hsl(${hue},90%,45%)`, fillOpacity: 0.25, weight: 1,
        }).bindTooltip(`${WAYPOINT_NAMES[i]} — 推定滞在 ${fmtDur(v)}`);
      }).filter(Boolean)
    ).addTo(map);
  }

  /* ---------------- 事務所→調査員プッシュ ---------------- */
  const OFFICE_MSGS = {
    warn: '接近注意。距離を保て',
    detour: '次の交差点で迂回せよ',
  };
  function officePush(kind) {
    if (!S.started || S.ended) return;
    if (kind === 'abort') {
      logEvent('office.push', { kind: 'abort', by: 'オペレーター' }, 'office');
      speak('事務所より、調査中断指示。');
      endSession();
      return;
    }
    S.officeFlash = Date.now();
    S.officeMsg = OFFICE_MSGS[kind];
    speak('事務所より指示。' + S.officeMsg + '。');
    toast('事務所→調査員: ' + S.officeMsg);
    logEvent('office.push', { kind, by: 'オペレーター' }, 'office');
    updateHUD();
  }

  /* ---------------- タイムリプレイ ---------------- */
  function enterReplay() {
    if (!S.replay.snapshots.length) { toast('リプレイできる記録がまだありません'); return; }
    S.replay.active = true;
    stopPlay();
    els.replayBar.classList.remove('hidden');
    els.replayRange.max = S.replay.snapshots.length - 1;
    applyReplay(S.replay.snapshots.length - 1);
    toast('リプレイモード — ライブ再生を一時停止');
  }
  function exitReplay() {
    S.replay.active = false;
    stopPlay();
    els.replayBar.classList.add('hidden');
    if (map) {
      mkInv.setLatLng([S.inv.pos.lat, S.inv.pos.lng]);
      mkTgt.setLatLng([S.target.pos.lat, S.target.pos.lng]);
    }
    updateHUD();
  }
  function stopPlay() {
    if (S.replay.playTimer) { clearInterval(S.replay.playTimer); S.replay.playTimer = null; }
    S.replay.playing = false;
    els.btnReplayPlay.textContent = '▶ 再生';
  }
  function toggleReplayPlay() {
    if (S.replay.playing) { stopPlay(); return; }
    S.replay.playing = true;
    els.btnReplayPlay.textContent = '⏸ 停止';
    S.replay.playTimer = setInterval(() => {
      const v = +els.replayRange.value;
      if (v >= +els.replayRange.max) { stopPlay(); return; }
      applyReplay(v + 1);
    }, 250);
  }
  function applyReplay(i) {
    const s = S.replay.snapshots[i];
    if (!s) return;
    els.replayRange.value = i;
    els.replayTime.textContent = [Math.floor(s.t / 60), s.t % 60].map((x) => String(x).padStart(2, '0')).join(':');
    const invP = { lat: s.inv.lat, lng: s.inv.lng };
    const d = haversine(invP, s.tgt);
    const brg = bearing(invP, s.tgt);
    const rel = norm180(brg - s.invH);
    els.hudArrow.style.transform = `rotate(${rel}deg)`;
    els.hudDistance.textContent = fmtDist(d);
    els.hudBearing.textContent = `${compassJa(brg)} / ${Math.round(brg)}° (相対 ${Math.round(rel)}°)`;
    els.hudEta.textContent = '徒歩 約 ' + fmtDur(d / 1.3);
    els.hudTargetStatus.textContent = s.stopped ? '停止' : '移動中';
    els.modeBadge.textContent = 'REPLAY';
    els.modeBadge.className = 'badge lost';
    els.hudRisk.textContent = `⏱ リプレイ表示 (${els.replayTime.textContent})`;
    els.hudRisk.className = 'hud-risk warn';
    if (map) {
      mkInv.setLatLng([invP.lat, invP.lng]);
      mkTgt.setLatLng([s.tgt.lat, s.tgt.lng]);
      const arrow = document.getElementById('invArrow');
      if (arrow) arrow.style.transform = `rotate(${s.invH}deg)`;
    }
  }

  /* ---------------- 装着視界 (Eye View) シミュレータ ----------------
   * グラス越しの一人称視界を再現: 夜の街並みパノラマ + 世界固定のARピン +
   * デバイス別HUD (Even G2=上部中央の短文HUD / Rokid=中央下のカード)。
   * ドラッグで首振り、ダブルクリックで対象方向を正面に。
   */
  let eyeOpen = false, eyeYaw = 0, eyeTimer = null, pano = null, eyeDrag = null;
  const EYE_FOV = 90; // 視野角(度)

  function eyePositions() {
    if (map && mkInv && mkTgt) {
      const a = mkInv.getLatLng(), b = mkTgt.getLatLng();
      return { inv: { lat: a.lat, lng: a.lng }, tgt: { lat: b.lat, lng: b.lng } };
    }
    return { inv: S.inv.pos, tgt: S.target.pos };
  }

  function buildPanorama(w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    const sky = g.createLinearGradient(0, 0, 0, h * 0.55);
    sky.addColorStop(0, '#04060c'); sky.addColorStop(1, '#0d1420');
    g.fillStyle = sky; g.fillRect(0, 0, w, h);
    let seed = 42;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    g.fillStyle = 'rgba(255,255,255,.5)';
    for (let i = 0; i < 140; i++) g.fillRect(rnd() * w, rnd() * h * 0.28, 1, 1);
    const drawBuildings = (base, maxH, col, lights) => {
      let x = 0;
      while (x < w) {
        const bw = 60 + rnd() * 150, bh = maxH * (0.35 + rnd() * 0.65);
        g.fillStyle = col; g.fillRect(x, base - bh, bw, bh);
        if (lights) {
          g.fillStyle = 'rgba(255,220,130,.6)';
          for (let wy = base - bh + 10; wy < base - 12; wy += 15)
            for (let wx = x + 7; wx < x + bw - 9; wx += 13)
              if (rnd() > 0.55) g.fillRect(wx, wy, 4, 6);
        }
        if (rnd() > 0.45) {
          g.fillStyle = ['#ff4d6d', '#4dd2ff', '#ffd166', '#9d6bff'][Math.floor(rnd() * 4)];
          g.fillRect(x + bw * 0.25, base - bh + 16, 10, 24 + rnd() * 34); // ネオン看板
        }
        x += bw + 10 + rnd() * 34;
      }
    };
    drawBuildings(h * 0.78, h * 0.55, '#0a0e16', false);
    drawBuildings(h * 0.88, h * 0.44, '#11151f', true);
    const road = g.createLinearGradient(0, h * 0.8, 0, h);
    road.addColorStop(0, '#14171d'); road.addColorStop(1, '#0a0c10');
    g.fillStyle = road; g.fillRect(0, h * 0.8, w, h * 0.2);
    g.fillStyle = 'rgba(255,255,255,.22)';
    for (let lx = 0; lx < w; lx += 95) g.fillRect(lx, h * 0.9, 46, 3);
    return c;
  }

  function updateEyeHud(rel, dist, brg) {
    const lte = S.tracker.age < 4 ? '▮▮▮▮' : S.tracker.age < 6 ? '▮▮▮▯' : '▮▮▯▯';
    const stopped = S.target.dwellLeft > 0;
    const dev = Devices[S.device];
    const pkt = dev.packet({
      mode: S.mode, rel: Math.round(rel), dist: fmtDist(dist), eta: fmtDur(dist / 1.3),
      target: stopped ? '停止' : '移動中',
      age: Math.round(S.tracker.age), battery: S.tracker.battery, lte,
      risk: dist > 400 ? 'critical' : dist > 250 ? 'warn' : 'ok',
      pred: S.pred && S.started ? S.pred.label + ' ' + S.pred.pct + '%' : null,
    });
    els.eyeDevLabel.textContent = dev.label;
    els.eyeRecTime.textContent = els.recTime.textContent;
    els.eyeHudG2.classList.toggle('hidden', S.device !== 'evenG2');
    els.eyeHudRokid.classList.toggle('hidden', S.device !== 'rokid');
    if (S.device === 'evenG2') {
      els.eyeHudG2.innerHTML =
        `<div style="font-size:11px;opacity:.75">${S.mode === 'lost-guide' ? 'LKP GUIDE' : 'TRACKING'} · TRK-4417</div>` +
        `<div style="font-size:26px"><span class="eyeArrow" style="display:inline-block;transform:rotate(${Math.round(rel)}deg)">▲</span> ${pkt.lines[0]}</div>` +
        pkt.lines.slice(1).map((l) => `<div>${l}</div>`).join('') +
        (pkt.prediction ? `<div style="opacity:.8">予測 ${pkt.prediction}</div>` : '');
    } else {
      els.eyeHudRokid.innerHTML =
        `<div style="display:flex;gap:16px;align-items:center">` +
        `<span class="eyeArrow" style="font-size:34px;display:inline-block;transform:rotate(${Math.round(rel)}deg)">▲</span>` +
        `<div><div style="font-size:24px;font-weight:700">${pkt.card.distance}</div>` +
        `<div style="font-size:12px;opacity:.85">${compassJa(brg)} / ${Math.round(brg)}° · 徒歩 ${pkt.card.eta}</div></div></div>` +
        `<div style="font-size:12px;margin-top:6px;opacity:.9">対象: ${pkt.card.targetState}${pkt.card.prediction ? ' · 予測: ' + pkt.card.prediction : ''}</div>` +
        `<div style="font-size:11px;opacity:.7">TRK-4417 · ${Math.round(S.tracker.age)}秒前 · BAT ${Math.round(S.tracker.battery)}%</div>`;
    }
  }

  // 注: この実行環境では requestAnimationFrame の連続発火が保証されないため setInterval 駆動にする
  function eyeFrame() {
    if (!eyeOpen) return;
    try {
      drawEye();
    } catch (e) {
      window.__eyeErr = String((e && e.stack) || e); // デバッグ用
    }
  }

  function drawEye() {
    window.__eyeFrames = (window.__eyeFrames || 0) + 1; // デバッグ計測
    const cv = els.eyeCanvas, g = cv.getContext('2d');
    const W = cv.width, H = cv.height;
    if (!pano) pano = buildPanorama(W * 4, H);
    if (S.eyeAuto && !S.replay.active) eyeYaw = lerpAngle(eyeYaw, S.inv.heading, 0.08);
    const yaw = ((eyeYaw % 360) + 360) % 360;
    const sx = (yaw / 360) * pano.width % pano.width;
    const w1 = Math.min(W, pano.width - sx);
    g.clearRect(0, 0, W, H);
    g.drawImage(pano, sx, 0, w1, H, 0, 0, w1, H);
    if (w1 < W) g.drawImage(pano, 0, 0, W - w1, H, w1, 0, W - w1, H);

    const p = eyePositions();
    const brg = bearing(p.inv, p.tgt);
    const rel = norm180(brg - yaw);
    const d = haversine(p.inv, p.tgt);
    if (S.started) {
      const half = EYE_FOV / 2;
      if (Math.abs(rel) <= half) {
        const mx = W / 2 + (rel / half) * (W / 2) * 0.92;
        const my = H * 0.52;
        g.strokeStyle = 'rgba(255,95,109,.35)'; g.lineWidth = 1;
        g.beginPath(); g.moveTo(mx, my - 16); g.lineTo(mx, my - H * 0.3); g.stroke();
        g.strokeStyle = 'rgba(255,95,109,.95)'; g.lineWidth = 2;
        g.beginPath(); g.arc(mx, my, 14, 0, Math.PI * 2); g.stroke();
        g.fillStyle = 'rgba(255,95,109,.9)';
        g.beginPath(); g.arc(mx, my, 4, 0, Math.PI * 2); g.fill();
        g.font = '12px monospace'; g.textAlign = 'center';
        g.fillText('TARGET ' + fmtDist(d), mx, my - H * 0.3 - 8);
        g.textAlign = 'left';
      } else {
        const left = rel < 0;
        g.fillStyle = 'rgba(255,95,109,.9)';
        g.font = '22px monospace'; g.textAlign = 'center';
        g.fillText(left ? '◀' : '▶', left ? 26 : W - 26, H / 2);
        g.font = '12px monospace';
        g.fillText('対象 ' + fmtDist(d) + ' · ' + compassJa(brg), left ? 70 : W - 70, H / 2 + 4);
        g.textAlign = 'left';
      }
    }
    updateEyeHud(rel, d, brg);
  }

  function openEyeView() {
    if (!S.started) { toast('セッション開始後に利用できます'); return; }
    eyeOpen = true;
    eyeYaw = S.inv.heading;
    els.eyeView.classList.remove('hidden');
    const cv = els.eyeCanvas;
    cv.width = cv.clientWidth || innerWidth;
    cv.height = cv.clientHeight || innerHeight;
    pano = null;
    eyeTimer = setInterval(eyeFrame, 33);
    eyeFrame();
    toast('装着視界シミュレータ — ドラッグで首を振れます');
  }
  function closeEyeView() {
    eyeOpen = false;
    if (eyeTimer) clearInterval(eyeTimer);
    eyeTimer = null;
    els.eyeView.classList.add('hidden');
  }

  /* ---------------- 調査報告書の自動生成 ---------------- */
  async function genReport() {
    if (!S.chain || !S.chain.entries.length) { toast('記録がありません'); return; }
    const v = await S.chain.verify();
    const stats = `
      <tr><th>追跡時間</th><td>${fmtDur(S.elapsed)}</td><th>対象移動距離</th><td>${fmtDist(S.stats.moveM)}</td></tr>
      <tr><th>停止検知</th><td>${S.stats.stops}回</td><th>証拠撮影</th><td>${S.photoCount}件</td></tr>
      <tr><th>装着デバイス</th><td>${escapeHtml(Devices[S.device].label)}</td><th>チェーン検証</th><td>${v.ok ? 'OK (改竄なし)' : 'NG — ' + escapeHtml(v.reason || '')}</td></tr>`;
    const rows = S.chain.entries.map((e) =>
      `<tr><td>${e.seq}</td><td>${fmtClock(e.ts)}</td><td>${e.type}</td><td>${escapeHtml(briefOf(e))}</td><td>${e.actor}</td></tr>`).join('');
    const root = S.chain.entries[S.chain.entries.length - 1].hash;
    els.reportBody.innerHTML = `
      <h2 style="margin:0 0 4px;font-size:20px;color:#1a3d5c">調査報告書（ドラフト）</h2>
      <div style="color:#666;font-size:12px;margin-bottom:16px">TailSight TS-G1 自動生成 — ${new Date().toLocaleString('ja-JP')}</div>
      <table class="rmeta">
        <tr><th>案件</th><td>${CASE_ID}</td><th>調査員</th><td>調査員A</td></tr>
        <tr><th>同意宣誓書</th><td>CONS-2026-0118</td><th>トラッカー</th><td>TRK-4417（依頼者所有・同意取得済み）</td></tr>
        ${stats}
      </table>
      <h3>状況サマリー（DEDUCE 推理エンジン）</h3>
      <p>${escapeHtml(buildSummary())}</p>
      <h3>証拠タイムライン（${S.chain.entries.length}件・ハッシュチェーン記録）</h3>
      <table class="rtl"><thead><tr><th>#</th><th>時刻</th><th>種類</th><th>概要</th><th>端末</th></tr></thead><tbody>${rows}</tbody></table>
      <p style="font-size:11px;color:#666;margin-top:12px">チェーン根本ハッシュ: <code style="word-break:break-all">${root}</code><br>
      本書は TailSight が証拠チェーンから自動生成したドラフトです。事実確認・署名のうえ提出してください。</p>`;
    els.reportModal.classList.remove('hidden');
    toast('報告書ドラフト生成 — 印刷/保存可能');
  }
  function downloadReport() {
    const html = `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><title>調査報告書 ${CASE_ID}</title>
<style>body{font-family:"Hiragino Kaku Gothic ProN",sans-serif;margin:32px;color:#111}
h2{color:#1a3d5c}h3{color:#1a3d5c;font-size:14px}table{width:100%;border-collapse:collapse;font-size:12px}
th{background:#eef2f6;text-align:left;padding:5px 8px;border:1px solid #d5dde5}td{padding:5px 8px;border:1px solid #d5dde5;vertical-align:top}</style>
</head><body>${els.reportBody.innerHTML}</body></html>`;
    const blob = new Blob([html], { type: 'text/html' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `tailsight-report-${CASE_ID}.html`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  /* ---------------- 起動シーケンス演出 ---------------- */
  function runBoot() {
    const lines = [
      'TAILSIGHT TS-G1  v1.1',
      '[ OK ] 生体認証 — 調査員A',
      '[ OK ] 案件 CASE-2026-0007 同意確認済',
      '[ OK ] トラッカー TRK-4417 接続 (LTE)',
      '[ OK ] 証拠チェーン初期化 — GENESIS',
      '>>> 追跡モード起動 — 真実はいつも一つ',
    ];
    els.bootOverlay.classList.remove('hidden');
    els.bootText.textContent = '';
    lines.forEach((l, i) => setTimeout(() => {
      els.bootText.textContent += (els.bootText.textContent ? '\n' : '') + l;
    }, 280 * (i + 1)));
    setTimeout(() => els.bootOverlay.classList.add('hidden'), 280 * (lines.length + 2));
  }

  /* ---------------- Sim tick ---------------- */
  function tick() {
    if (S.replay.active) return;
    if (!S.started || S.ended) { updateHUD(); return; }
    S.elapsed++;
    const dt = 1;

    // 対象 (トラッカー) の模擬挙動
    const t = S.target;
    if (t.dwellLeft > 0) {
      t.dwellLeft -= dt;
      t.stoppedFor += dt;
      if (t.dwellLeft <= 0 && S.flags.stopLogged) {
        S.flags.stopLogged = false; t.stoppedFor = 0;
        speak('対象が移動を再開。');
        logEvent('target.resume', { lat: t.pos.lat, lng: t.pos.lng }, 'phone');
      }
    } else {
      const step = t.baseSpeed * S.speedMult * dt;
      const wp = WAYPOINTS[t.idx];
      t.pos = moveToward(t.pos, wp, step);
      if (haversine(t.pos, wp) < 3) t.idx = (t.idx + 1) % WAYPOINTS.length;
      // ウェイポイント到達時に一定確率で停止(入店等を模擬)
      if (Math.random() < 0.006) t.dwellLeft = 15 + Math.random() * 25;
    }
    if (t.dwellLeft > 0 && t.stoppedFor >= 15 && !S.flags.stopLogged) {
      S.flags.stopLogged = true;
      S.stats.stops++;
      speak('対象が停止しました。' + (nearPOI(t.pos) ? '付近は' + nearPOI(t.pos) + 'です。' : ''));
      logEvent('target.stop_detected', { lat: t.pos.lat, lng: t.pos.lng, holdSec: Math.round(t.stoppedFor), poi: nearPOI(t.pos) }, 'phone');
    }
    t.trail.push({ ...t.pos });
    if (t.trail.length > 900) t.trail.shift();

    // トラッカー通信状態
    S.tracker.age = 2 + Math.random() * 4;
    S.tracker.battery = Math.max(5, S.tracker.battery - 0.008);
    S.tracker.lastFix = { pos: { ...t.pos }, ts: new Date().toISOString() };

    // 調査員の移動
    let moved = 0;
    if (S.invMode === 'auto') {
      const d = haversine(S.inv.pos, t.pos);
      if (d > 100) {
        const step = Math.min(2.2, 1.15 * t.baseSpeed * S.speedMult + 0.3) * dt;
        const np = moveToward(S.inv.pos, t.pos, step);
        moved = haversine(S.inv.pos, np);
        S.inv.pos = np;
        S.inv.dest = null;
      }
    } else if (S.inv.dest) {
      const step = 1.7 * dt;
      const np = moveToward(S.inv.pos, S.inv.dest, step);
      moved = haversine(S.inv.pos, np);
      S.inv.pos = np;
      if (haversine(S.inv.pos, S.inv.dest) < 2) S.inv.dest = null;
    }
    if (moved > 0.3) S.inv.heading = lerpAngle(S.inv.heading, bearing(S.inv.pos, S.invMode === 'auto' ? S.target.pos : (S.inv.dest || S.inv.pos)), 0.35);
    invTrail.push({ ...S.inv.pos });
    if (invTrail.length > 900) invTrail.shift();

    // 統計・POI滞在・予測・リプレイ用スナップショット
    if (t.trail.length >= 2) S.stats.moveM += haversine(t.trail[t.trail.length - 2], t.trail[t.trail.length - 1]);
    WAYPOINTS.forEach((w, i) => { if (haversine(w, t.pos) < 70) S.poiVisits[i]++; });
    updatePrediction();
    S.replay.snapshots.push({
      t: S.elapsed,
      inv: { lat: S.inv.pos.lat, lng: S.inv.pos.lng }, invH: S.inv.heading,
      tgt: { lat: t.pos.lat, lng: t.pos.lng }, stopped: t.dwellLeft > 0,
    });
    if (S.replay.snapshots.length > 7200) S.replay.snapshots.shift();

    // リスク判定 (追跡モード時)
    if (S.mode === 'track') {
      const d = haversine(S.inv.pos, S.target.pos);
      if (d > 400 && !S.flags.critLogged) {
        S.flags.critLogged = true;
        speak('危険。接触を失う可能性があります。');
        logEvent('risk.critical', { distance: Math.round(d) }, 'phone');
      } else if (d <= 400) S.flags.critLogged = false;
      if (d > 250 && d <= 400 && !S.flags.warnLogged) {
        S.flags.warnLogged = true;
        speak('警告。距離が拡大しています。');
        logEvent('risk.warn', { distance: Math.round(d) }, 'phone');
      } else if (d <= 250) S.flags.warnLogged = false;
    } else {
      // 見失い中: 再接近で自動再捕捉
      if (haversine(S.inv.pos, S.target.pos) < 150) reacquire('自動再捕捉');
    }

    updateHUD();
  }

  /* ---------------- Actions ---------------- */
  function declareLost() {
    if (!S.started || S.ended) return;
    if (S.mode === 'lost-guide') { toast('すでにLKP誘導モードです'); return; }
    S.mode = 'lost-guide';
    S.lkp = { pos: { ...(S.tracker.lastFix ? S.tracker.lastFix.pos : S.target.pos) }, ts: new Date().toISOString() };
    if (map) {
      mkLKP = L.circleMarker([S.lkp.pos.lat, S.lkp.pos.lng], { radius: 9, color: '#ffd166', fillOpacity: 0.9 })
        .addTo(map).bindTooltip('最終既知位置 (LKP)');
      circleLKP = L.circle([S.lkp.pos.lat, S.lkp.pos.lng], { radius: 60, color: '#ffd166', dashArray: '4 4', fillOpacity: 0.1 }).addTo(map);
    }
    logEvent('lost.declared', { lat: S.lkp.pos.lat, lng: S.lkp.pos.lng, fixTs: S.lkp.ts }, 'glasses');
    speak('接触喪失。最終既知位置への誘導に切り替えます。');
    toast('接触喪失を申告 — LKP誘導に切替');
    updateHUD();
  }

  function reacquire(how) {
    if (S.mode !== 'lost-guide') { toast('通常追跡モード中です'); return; }
    S.mode = 'track';
    if (map) { if (mkLKP) map.removeLayer(mkLKP); if (circleLKP) map.removeLayer(circleLKP); mkLKP = circleLKP = null; }
    const d = haversine(S.inv.pos, S.target.pos);
    logEvent('target.reacquired', { distance: Math.round(d), via: how }, 'glasses');
    speak('対象を再捕捉。追跡を再開。');
    toast('再捕捉 — 追跡モード復帰');
    updateHUD();
  }

  function takePhoto() {
    if (!S.started || S.ended) return;
    S.photoCount++;
    const file = 'EV-' + String(S.photoCount).padStart(4, '0') + '.jpg';
    logEvent('evidence.photo', {
      file,
      invPos: { lat: +S.inv.pos.lat.toFixed(6), lng: +S.inv.pos.lng.toFixed(6) },
      targetPos: { lat: +S.target.pos.lat.toFixed(6), lng: +S.target.pos.lng.toFixed(6) },
      distance: Math.round(haversine(S.inv.pos, S.target.pos)),
      bearing: Math.round(bearing(S.inv.pos, S.target.pos)),
      via: Devices[S.device].caps.camera ? 'glasses-camera' : 'phone-camera',
    }, Devices[S.device].photoActor);
    speak('証拠を記録しました。');
    toast('証拠撮影 (' + (Devices[S.device].caps.camera ? 'グラス' : 'スマホ') + 'カメラ): ' + file + ' → チェーン記録済');
  }

  function addMemo() {
    if (!S.started || S.ended) return;
    const text = els.inpMemo.value.trim();
    if (!text) { toast('メモ内容を入力してください'); return; }
    els.inpMemo.value = '';
    logEvent('evidence.memo', {
      text,
      invPos: { lat: +S.inv.pos.lat.toFixed(6), lng: +S.inv.pos.lng.toFixed(6) },
    }, 'glasses');
    toast('音声/テキストメモをチェーン記録しました');
  }

  // 顔認識の合法代替: 依頼者提供の参照写真1枚との1:1照合のみ。データベース照合・無差別収集はしない。
  function verifySubject() {
    if (!S.started || S.ended) return;
    toast('依頼者提供写真 (REF-PHOTO-07) と 1:1 照合中…');
    setTimeout(() => {
      logEvent('subject.verify', {
        reference: 'REF-PHOTO-07',
        result: '一致',
        confidence: 0.93,
        via: Devices[S.device].caps.camera ? 'glasses-camera' : 'phone-camera',
      }, Devices[S.device].photoActor);
      toast('本人確認: 一致 (信頼度93%) — チェーン記録済');
      speak('本人確認。参照写真と一致。');
      pushVoice('「本人確認」→ 参照写真と一致 (93%)');
    }, 1500);
  }

  // 盗聴の合法代替: 調査員⇔事務所オペレーター間の同意済み双方向音声リンク (対象者の音声は取得しない)
  function toggleAudioLink() {
    if (!S.started || S.ended) return;
    S.audioLink = !S.audioLink;
    logEvent('audio.link', {
      state: S.audioLink ? 'open' : 'closed',
      mode: 'two-way-consent',
      parties: '調査員+事務所オペレーター',
    }, 'phone');
    els.btnAudioLink.textContent = S.audioLink ? '通話を終了' : '事務所と通話';
    els.btnAudioLink.classList.toggle('active', S.audioLink);
    toast(S.audioLink ? '事務所と双方向音声リンク接続 (同意済み)' : '音声リンクを終了');
  }

  function pushVoice(line) {
    S.voiceLines.push(line);
    if (S.voiceLines.length > 3) S.voiceLines.shift();
    els.voiceLog.innerHTML = S.voiceLines.map((l) => '🎙 ' + l).join('<br>');
  }

  function handleVoice(value) {
    if (!value) return;
    const map_ = {
      '追跡開始': () => { pushVoice('「追跡開始」→ セッション' + (S.started ? 'は既に開始済み' : 'を開始しました')); },
      '状況': () => {
        const d = haversine(S.inv.pos, S.target.pos);
        const b = bearing(S.inv.pos, S.target.pos);
        pushVoice(`「状況」→ 対象${fmtDist(d)} ${compassJa(b)} ${S.target.dwellLeft > 0 ? '停止中' : '移動中'}`);
      },
      '証拠保存': () => { takePhoto(); pushVoice('「証拠保存」→ 撮影しチェーン記録'); },
      '見失った': () => { declareLost(); pushVoice('「見失った」→ LKP誘導へ切替'); },
      '再捕捉': () => { reacquire('音声コマンド'); pushVoice('「再捕捉」→ 通常追跡へ復帰'); },
    };
    if (map_[value]) {
      if (S.started && !S.ended) logEvent('voice.command', { utterance: value, intent: value }, 'glasses');
      map_[value]();
    }
    els.selVoice.value = '';
  }

  function endSession() {
    if (!S.started || S.ended) return;
    S.ended = true;
    logEvent('session.end', { elapsedSec: S.elapsed, eventCount: S.chain.entries.length + 1 }, 'phone');
    [els.btnPhoto, els.btnMemo, els.btnLost, els.btnFace, els.btnAuto, els.btnManual, els.inpMemo, els.selVoice, els.btnVerifySubj, els.btnAudioLink, els.btnOfficeWarn, els.btnOfficeDetour, els.btnOfficeAbort].forEach((b) => (b.disabled = true));
    toast('セッション終了 — 証拠チェーンを書き出せます');
    updateHUD();
  }

  /* ---------------- Consent gate / start ---------------- */
  function bindConsent() {
    const update = () => { els.startBtn.disabled = !els.checks.every((c) => c.checked); };
    els.checks.forEach((c) => c.addEventListener('change', update));
    els.startBtn.addEventListener('click', () => {
      els.modal.classList.add('hidden');
      S.started = true;
      S.startAt = Date.now();
      S.chain = new EvidenceChain(CASE_ID, 'SES-' + Date.now());
      els.caseId.textContent = CASE_ID;
      els.btnEnd.disabled = false;
      [els.btnPhoto, els.btnMemo, els.btnLost, els.btnFace, els.btnAuto, els.btnManual, els.inpMemo, els.selVoice, els.btnVerifySubj, els.btnAudioLink, els.btnReplay, els.btnHeat, els.btnReport, els.btnOfficeWarn, els.btnOfficeDetour, els.btnOfficeAbort, els.btnEyeView].forEach((b) => (b.disabled = false));
      runBoot();
      speak('追跡モード、起動。');
      logEvent('compliance.gate', { checks: els.checks.length, consentRef: 'CONS-2026-0118' }, 'phone');
      logEvent('session.start', { investigator: '調査員A', consentRef: 'CONS-2026-0118', trackerId: 'TRK-4417' }, 'phone');
      toast('セッション開始 — 追跡モード');
      setInterval(tick, 1000);
      updateHUD();
    });
  }

  /* ---------------- Export / verify ---------------- */
  function exportChain() {
    if (!S.chain || !S.chain.entries.length) { toast('記録がありません'); return; }
    const blob = new Blob([JSON.stringify(S.chain.toJSON(), null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `tailsight-evidence-${CASE_ID}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  async function verifyChain() {
    if (!S.chain || !S.chain.entries.length) { toast('記録がありません'); return; }
    const r = await S.chain.verify();
    els.verifyResult.textContent = r.ok ? `✔ 検証OK (${r.entries}件・改竄なし)` : `✘ 検証NG: ${r.reason}`;
    els.verifyResult.className = 'verify ' + (r.ok ? 'ok' : 'ng');
  }

  /* ---------------- Bind controls ---------------- */
  function bindControls() {
    els.selDevice.addEventListener('change', () => {
      S.device = els.selDevice.value;
      const dev = Devices[S.device];
      els.btnPhoto.textContent = dev.caps.camera ? '証拠撮影' : '撮影(スマホ)';
      els.btnAudioLink.textContent = S.audioLink ? '通話を終了' : '事務所と通話';
      toast(dev.label + ' に切替 — ' + (dev.caps.camera ? 'グラスカメラ使用可' : 'カメラなし: 証拠撮影はスマホカメラ') + (dev.caps.speaker ? '' : ' / 音声応答はイヤホン'));
      updateHUD();
    });
    els.btnVerifySubj.addEventListener('click', verifySubject);
    els.btnAudioLink.addEventListener('click', toggleAudioLink);
    els.btnTts.addEventListener('click', () => {
      S.tts = !S.tts;
      els.btnTts.textContent = S.tts ? '🔊 読上げON' : '🔇 読上げOFF';
      els.btnTts.classList.toggle('active', S.tts);
      if (S.tts) speak('音声読み上げ、有効。');
    });
    els.btnHeat.addEventListener('click', toggleHeat);
    els.btnReplay.addEventListener('click', () => (S.replay.active ? exitReplay() : enterReplay()));
    els.btnReplayPlay.addEventListener('click', toggleReplayPlay);
    els.btnReplayExit.addEventListener('click', exitReplay);
    els.replayRange.addEventListener('input', (e) => applyReplay(+e.target.value));
    els.btnReport.addEventListener('click', genReport);
    els.btnReportClose.addEventListener('click', () => els.reportModal.classList.add('hidden'));
    els.btnReportPrint.addEventListener('click', () => window.print());
    els.btnReportDl.addEventListener('click', downloadReport);
    els.btnOfficeWarn.addEventListener('click', () => officePush('warn'));
    els.btnOfficeDetour.addEventListener('click', () => officePush('detour'));
    els.btnOfficeAbort.addEventListener('click', () => officePush('abort'));
    els.btnEyeView.addEventListener('click', () => (eyeOpen ? closeEyeView() : openEyeView()));
    els.btnEyeClose.addEventListener('click', closeEyeView);
    els.eyeCanvas.addEventListener('pointerdown', (e) => {
      eyeDrag = { x: e.clientX, yaw: eyeYaw };
      S.eyeAuto = false;
    });
    window.addEventListener('pointermove', (e) => {
      if (!eyeDrag || !eyeOpen) return;
      eyeYaw = eyeDrag.yaw - ((e.clientX - eyeDrag.x) / (els.eyeCanvas.clientWidth || 1)) * EYE_FOV;
    });
    window.addEventListener('pointerup', () => { eyeDrag = null; });
    els.eyeCanvas.addEventListener('dblclick', () => {
      const p = eyePositions();
      eyeYaw = bearing(p.inv, p.tgt);
      S.eyeAuto = false;
      toast('視線を対象方向に固定しました');
    });
    els.eyeDevLabel.addEventListener('click', () => {
      S.device = S.device === 'rokid' ? 'evenG2' : 'rokid';
      els.selDevice.value = S.device;
      els.btnPhoto.textContent = Devices[S.device].caps.camera ? '証拠撮影' : '撮影(スマホ)';
    });
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && eyeOpen) closeEyeView(); });
    els.btnAuto.addEventListener('click', () => { S.invMode = 'auto'; els.btnAuto.classList.add('active'); els.btnManual.classList.remove('active'); toast('自動追跡モード'); });
    els.btnManual.addEventListener('click', () => { S.invMode = 'manual'; els.btnManual.classList.add('active'); els.btnAuto.classList.remove('active'); toast('手動モード — 地図クリックで移動指示'); });
    els.btnFace.addEventListener('click', () => {
      if (!S.started || S.ended) return;
      const focus = S.mode === 'lost-guide' && S.lkp ? S.lkp.pos : S.target.pos;
      S.inv.heading = bearing(S.inv.pos, focus);
      updateHUD();
    });
    els.btnLost.addEventListener('click', declareLost);
    els.btnPhoto.addEventListener('click', takePhoto);
    els.btnMemo.addEventListener('click', addMemo);
    els.inpMemo.addEventListener('keydown', (e) => { if (e.key === 'Enter') addMemo(); });
    els.btnEnd.addEventListener('click', endSession);
    els.btnExport.addEventListener('click', exportChain);
    els.btnVerify.addEventListener('click', verifyChain);
    els.selSpeed.addEventListener('change', () => { S.speedMult = parseFloat(els.selSpeed.value); });
    els.selVoice.addEventListener('change', () => handleVoice(els.selVoice.value));
  }

  /* ---------------- Boot ---------------- */
  document.addEventListener('DOMContentLoaded', () => {
    initMap();
    bindConsent();
    bindControls();
    [els.btnEnd, els.btnPhoto, els.btnMemo, els.btnLost, els.btnFace, els.inpMemo, els.selVoice, els.btnVerifySubj, els.btnAudioLink, els.btnReplay, els.btnHeat, els.btnReport, els.btnOfficeWarn, els.btnOfficeDetour, els.btnOfficeAbort, els.btnEyeView].forEach((b) => (b.disabled = true));
    renderPrediction();
    updateHUD();
  });
})();
