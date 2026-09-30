# TailSight TS-G1 🕶️📡

**名探偵コナンの「犯人追跡メガネ」を、法令に適合する形で業務製品化するオープンソース・プロジェクト。**
Rokid Glasses と Even Realities G2 の両方に対応した、探偵事務所向け調査支援スマートグラスシステム。

*Turn Detective Conan's "criminal-tracking glasses" into a lawful professional tool for licensed investigators — dual-platform (Rokid Glasses / Even Realities G2) smart glasses tracking system with an tamper-evident evidence chain.*

🎬 **デモ動画 (44s)**: https://github.com/toriumib/tailsight/releases/tag/v1.1

---

## ⚠️ 重要 / Important

- 本プロジェクトは**技術検証 (PoC)** であり法的助言ではありません。実運用前に弁護士の法務レビューを受けてください（[設計書 §15](docs/system-design.md)）
- **違法機能は仕様として存在しません**: 盗聴・無断GPS・無差別顔認識データベース照合は実装していません（[§3 コンプライアンス設計](docs/system-design.md)）。GPS追跡は「依頼者所有物＋同意宣誓書」をシステムが強制するゲート付きでのみ動作します
- 本リポジトリの位置データはすべて模擬データ（新宿周回コース）です
- 非公式ファンプロジェクトです。『名探偵コナン』(青山剛昌/小学館/ytv)、Rokid、Even Realities とは無関係です。商標は各権利者に帰属します
- 各国の法令（探偵業法・個人情報保護法・電気通信事業法・ストーカー規制法・電波法等）を遵守する利用者の責任で使用してください

## 何ができるか（PoCデモ）

ブラウザだけで動くシミュレータで一連の調査フローを体験できます:

1. **同意ゲート** — 所有権宣誓・公開場所限定・音声は調査員自身の発話のみ、の3確認を強制
2. **追跡HUD** — 方位矢印・距離・徒歩ETA・対象状態・トラッカー電波/電池。Rokid=カード型 / Even G2=短文4行を**送信パケット形式ごと再現**
3. **装着視界シミュレータ** — グラス越しの一人称視界（夜の街・世界固定ARピン・ドラッグで首振り・デバイス別HUD配置）
4. **推理エンジン DEDUCE** — 進行方向・滞在頻度から次の目的地を確率予測し自然文サマリー生成
5. **証拠ハッシュチェーン** — 全イベントをSHA-256チェーンで記録、改竄検証・JSON書き出し（`test/chain.test.js` で自動試験）
6. **見失い対応** — 申告→LKP（最終既知位置）誘導→自動再捕捉
7. **タイムリプレイ / 滞在ヒートマップ / 報告書自動生成（印刷可） / 音声読み上げ(ja-JP) / 事務所→調査員プッシュ指示 / 追跡起動シーケンス演出**

## クイックスタート

```bash
# 証拠チェーン+アダプタの試験 (Node 18+)
node test/chain.test.js
node test/device.test.js

# PoCデモ (ブラウザで開くだけ。地図タイルはCDN)
open poc/index.html
```

デモの流れ: 同意3項目にチェック → セッション開始 → 「事務所と通話」「本人確認」「見失い申告」→「滞在分析」「⏱リプレイ」「📄報告書生成」「👁装着視界」（視界内のデバイスラベルクリックで Rokid↔Even G2 切替）。

## 構成

| パス | 内容 |
|---|---|
| `docs/system-design.md` | システム設計書（アーキテクチャ・法務対応マトリクス・BOM・API・価格案・ロードマップ） |
| `poc/index.html` | 動くPoC: 追跡HUDシミュレータ＋装着視界シミュレータ |
| `poc/app.js` | 追跡ロジック（方位/距離/ETA、停止検知、リスク判定、LKP誘導、DEDUCE予測） |
| `poc/evidence-chain.js` | SHA-256証拠ハッシュチェーン・ライブラリ（ブラウザ/Node共用） |
| `poc/device-adapters.js` | Rokid / Even Realities G2 デバイスアダプタ（能力フラグで撮影経路・HUD形式を自動分岐） |
| `test/` | 改竄検出試験・アダプタ試験（全18項目） |

## アーキテクチャ（要点）

```
GPS+LTEトラッカー(依頼者所有・同意済み) ──┐
Rokid Glasses / Even G2 (薄い表示・入力端末) ─┤→ コンパニオンAndroid(追跡コア) → クラウド(ケース管理・証拠ボールト・ライブモニター)
```

- グラスは**表示・入力のみ**。ロジックはコンパニオン/サーバに集約（機種変更耐性・電池温存）
- 機種差は `caps{camera,speaker,mic,ring}` / `photoActor` / `packet(state)` の共通I/Fで吸収。証拠撮影は Rokid=グラスカメラ、**Even G2(カメラなし)=スマホカメラ**に自動分岐し、チェーンにactorとして記録
- 証拠チェーン: `hash = SHA-256(prevHash | canonical_json(entry))`、正準化JSONでキー順差異に耐性

Even G2 実機シミュレータ（公式 `@evenrealities/evenhub-simulator`）での開発手順は[設計書 §5](docs/system-design.md)参照。
単体のHUDプレビューアは別リポジトリで公開: [toriumib/tailsight-device-preview](https://github.com/toriumib/tailsight-device-preview)（Rokid / Even G2 装着視界シミュレータ・スタンドアロン）。

## コントリビュート

Issue/PR歓迎。特に: Even Hub SDK / Rokid SDK 実機アダプタ、チェーンのMerkle公証、報告書テンプレ、英語ドキュメント。

## License

[MIT](LICENSE) — TailSight contributors
