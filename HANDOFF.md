# 自作パーソナルエージェント 引き継ぎメモ

2026-11-17 時点の設計相談のまとめ。Claude Code でこの続きを進めるための前提資料。
「決定」はユーザーが明言したもの、「提案」は相談相手（Claude）の案でユーザー未承認のもの。

## 目的

Hermes Agent / OpenAI dots / Meta Muse / Grok Bot のような常駐パーソナルエージェントを自作する。
Hermes の cron で Dreaming と Proactive を試したが、Muse ほど気が利かなかった（後述）。

## 要件（ユーザー提示、下ほど未確定）

- ブラウザ操作、パスワード保存（暗号化は不要）
- Matrix から操作、VC で音声入力と音声合成
- CalDAV 操作
- 長期的なコンテキスト
- 人格を多数
- 人格ごとのコンテキスト分離の仕方
- 長期記憶の方式（逐一追加 / dreaming / compaction）
- 月一程度の整理

## 決定（ユーザー明言）

- 基盤は **pi-durable**（2026-11-17 決定。`@earendil-works/pi-durable` 1.5.2 に固定）
- Matrix は **matrix-rust-sdk**。通話は後で **matrix-rust-rtc**（element-hq、v0.5.0）で対応する
- **最初から暗号化（E2EE）ルームに対応**する
- 人格の見せ方は **bot アカウント1つ、ルームごとに人格**
- モデルは **Anthropic (Claude)**
- 記憶は**全人格で共有＋必要な人格だけ専用メモ**。会話中にツールでその場で書かせ、
  上限つきの全文を毎回読ませる（2026-11-17 決定）
- 人格ごとにセッションは分ける
- Hermes の profile のように、口調を変えたいだけで設定ファイルまで分離されるのは避けたい
- 既存 cron: Dreaming は毎日 02:00、Proactive は 06:00〜21:00 毎時（Asia/Tokyo）
- CalDAV のカレンダー: `Work`（義務的予定）、`Home`（個人的予定）、`ToDo`（タスク）

## 未決定（ユーザーに確認が必要）

- VC は MatrixRTC で参加する方針（matrix-rust-rtc）。ボイスメッセージを先に作るかは未決定
- Dreaming を残すか、compaction 頼りにするか（手順3でスケジューラができてから決める）
- 月一程度の記憶の整理をどう起動するか（同上）

## 手順1の実装（2026-11-17）

Matrix のテキスト bot と durable な会話。2プロセス構成。

- `gateway/`（Rust）: matrix-rust-sdk で bot としてログインし、E2EE のデバイスを保持する。
  matrix-rust-sdk に Node 用バインディングが無いので別プロセスにした。
- `src/`（Node）: pi-durable のエージェント。ゲートウェイを子プロセスとして起動し、
  stdin/stdout の JSON Lines で話す（形式は `src/gateway.ts` と `gateway/src/ipc.rs`）。
- matrix-sdk は crates.io 版ではなく git rev `56bc5911` に固定。matrix-rust-rtc v0.5.0 が
  同じ rev に固定しているため。上げるときは両方一緒に上げる。
- ツールは未登録。記憶・CalDAV・スケジューラ・ブラウザ・音声・通話は未実装。

### 動かし方

1. `cp config.example.json config.json` して homeserver、bot のユーザー ID、`allowedUsers` を書く
2. `cp .env.example .env` して `ANTHROPIC_API_KEY` を書く
3. `npm install`、`npm run build:gateway`
4. `npm run login`（パスワードは入力するか `MATRIX_PASSWORD` で渡す）
   - 新規アカウントならリカバリーキーが表示されるので控える
   - 既にリカバリー設定済みのアカウントなら `--recovery-key` を付けるか、
     後から `gateway/target/release/matrix-gateway recover --recovery-key '<key>'`
5. `npm start`。Element で暗号化ルームを作り、bot を招待して話しかける

状態は `data/` に入る（`session.sqlite` 会話、`host.sqlite` ルームと配送の台帳、
`matrix-store/` 暗号ストア、`matrix-session.json`、`gateway-state.json`）。消すときは `data/` ごと消す。

### 落ちても1回だけ答える仕組み

- ゲートウェイは受信した発言を `gateway-state.json` に書いてからエージェントに渡し、ack で消す。起動時に未 ack 分を再送する
- エージェントは Matrix のイベント ID を `requestId` にして submit する。同じ ID は同じ submission が返る
- 回答は `reply:<イベントID>` をトランザクション ID にして送る。同じ ID の再送は homeserver が1件にまとめる

### 未検証

実際の homeserver に繋いだ確認はまだ（開発環境に homeserver が無かった）。ログイン、E2EE、デバイス検証、
送受信、`kill -9` 後に回答が1回だけ届くことは、初回起動時に確認する。

## 手順2の実装（2026-11-17）

記憶ファイルと人格の分離。`src/memory.ts` が本体。

- 記憶は人が読める Markdown の箇条書き。`data/memory/shared.md`（全人格が読む）と
  `data/memory/persona/<人格名>.md`（`privateMemory: true` の人格だけが持つ）
- 各項目の末尾に書いた日付が自動で付く: `- ユーザーは緑茶を好む (2026-11-17)`。
  書いた人格は付けない（2026-11-17 決定。専用メモでは冗長で、共有でも応答に効かないため）
- 全文と使い方をシステムプロンプトの `memory` セクションに毎回入れる。上限は `config.json` の
  `memory.sharedLimit`（既定 2000 文字）と `memory.privateLimit`（既定 1000 文字）。
  上限を超える変更はツールが拒否し、まとめるか消すようモデルに返す
- ツールは `memory_add` / `memory_replace` / `memory_remove`。同じ操作を繰り返しても結果が変わらない
  ので、3つとも「クラッシュ後に再実行してよいツール」（`replay: "safe"`）にしてある
- 人格は3軸を別々に指定する。`personas` の値は SOUL ファイルのパスだけでもよく、
  オブジェクトにすると `soul`（口調）、`privateMemory`（専用メモ）、`model`（上書き、無ければ共通設定）を持てる
- ファイルは手で編集してよい。次にツールが書き込むとき、箇条書きの形に揃え直される

Dreaming と月一の整理は未実装（手順3のスケジューラ待ち）。

### 手順6（通話）に向けたメモ

- matrix-rust-rtc は `LiveKitCall::join(&room, LiveKitCallOptions)` で `matrix_sdk::Room` から通話に入れる。
  音声の受信は `crates/matrix-rtc-call-sdk/examples/join_and_record.rs` が出発点
- homeserver 側に LiveKit SFU と lk-jwt-service が必要
- matrix-sdk の `automatic-room-key-forwarding` は切らない。切ると進行中の通話が新しいデバイスから見えなくなる
- matrix-rust-rtc は AGPL-3.0（または Element の商用ライセンス）

## 提案（未承認）

### 基盤
pi-durable 寄り。記憶と人格を自分で設計したいなら、組み込み型のライブラリのほうが握りやすい。
dsh は既製プラグイン（dsh-agent-team など）を流用したい場合の選択肢。

- pi-durable: https://github.com/earendil-works/pi/tree/main/packages/durable
  （npm: `@earendil-works/pi-durable`。実験的で API が変わるので、着手時に必ず現行ドキュメントを確認すること）
- dsh: https://github.com/deepseek-ai/deepseek-harness （alpha）

### ツールの冪等性
クラッシュ後にツールが再実行されうる。ブラウザ操作と CalDAV 書き込みは冪等でないので、
「再実行してよいツール」と「結果を記録して二度実行しないツール」を最初に分ける。

### 各部品
- Matrix: matrix-rust-sdk（決定済み、上記）。ルーム = 会話。
- ブラウザ: Playwright 系の MCP / CLI を繋ぐ。人格ごとの永続プロファイルで cookie を保持。
- パスワード: 平文ファイルでよいが、モデルには見せない。`fill_credential(site)` のようなツールで
  フォームへ直接注入し、会話ログ・記憶ファイルに残さない。
- CalDAV: tsdav などで 一覧 / 作成 / 更新 / 削除 の4ツール。
- 音声: まずボイスメッセージの STT → 返答 → TTS。リアルタイム VC は最後。
  （Element Call は MatrixRTC + LiveKit のはずだが未確認。着手時に調べること）

### 人格
人格を束にせず、3軸を別々の参照にする。

- 口調（SOUL ファイル1枚）
- 記憶の範囲（デフォルトは共有、必要な人格だけ専用メモを追加）
- 設定・ツール（ベースを継承、必要なら上書き）

記憶は「ユーザーは〜を希望」のような中立な文体で書く。（書いた人格をタグで残す案は不採用。上の「手順2の実装」参照）
判断基準は「A に話したことを B が知っていてほしいか」。

### 記憶とプロアクティブ動作
予定とタスクの正は CalDAV。会話中に意思が明示されたらその場で ToDo に登録させれば、
Dreaming の主な仕事は不要になる。「いま何をしているか」は長寿命セッション + compaction で足りる可能性が高い。

ただしスケジューラは必要。構成案:

1. 朝ブリーフ（06:00、必ず送る）: 今日と明日の予定、外出を伴う予定の天気、7日以内の期日と未着手タスク
2. 毎時トリガー（コードで判定、LLM なし）: 予定の2時間前、期日の3日前と前日、予定の追加・変更。
   該当があった時だけエージェントを起こす
3. 通知済み台帳（別ファイル）: イベントID、種類、日付 を追記して重複通知を防ぐ
4. 天気はどのツールで取るかを明示する

## 既存 Hermes プロンプトの問題点（Proactive）

- 報告条件が「重要な発見や判断が必要な場合のみ」で、天気や期日リマインドが `[SILENT]` になる
- 「最近の予定」が過去寄りに読め、先を見る範囲も「何日前に言うか」の基準もない
- 通知済みの状態がなく、「繰り返さない」を守るには黙るのが安全になっている
- 「有益な調査・準備」に具体例がない
- 朝のまとめと毎時巡回が同じプロンプト

元のプロンプト2本（proactive.md、dreaming.md）は別途リポジトリに置く。
dreams.md は 1000 文字以内の「フォローアップ対象リスト」として設計されていた。

## 作る順番（提案）

1. Matrix のテキスト bot と durable な会話
2. 記憶ファイルと人格の分離
3. CalDAV と朝ブリーフ / 毎時トリガー / 台帳
4. ブラウザ
5. ボイスメッセージ
6. VC

## Claude Code への最初の依頼例

> HANDOFF.md を読んで、未決定事項のうち実装を始めるのに必要なものを質問してください。
> その後、pi-durable の現行ドキュメントを確認したうえで、手順1（Matrix のテキスト bot と durable な会話）の
> 最小構成を提案してください。
