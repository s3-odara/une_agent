# 自作パーソナルエージェント 引き継ぎメモ

コードやテスト、コミットからは読み取れないこと（決めたことと理由、制約、確かめていないこと）だけを書く。
モデル向けの手順書は `skills/`、IPC プロトコルは `src/gateway.ts` と `gateway/src/ipc.rs`、状態遷移の形式検証モデルは `spec/`。

## 目的と基本方針

常駐パーソナルエージェント（Hermes Agent / OpenAI dots / Meta Muse 相当）の自作。

- **基盤**: `@earendil-works/pi-durable`（実験的で API が変わりやすい）＋ Matrix（最初から E2EE 対応、**AGPL-3.0**）。
- **人格と会話**: bot アカウントは1つ、ルームごとに人格（SOUL・専用メモ・モデルを分離）。
- **記憶と予定**: 全人格共有メモ＋任意で専用メモ。毎日整理（変化日のみ）。予定とタスクの正は CalDAV（`Work` / `Home` / `ToDo`）で、日時の決まった予定・タスクは記憶に書かせない。
- **自分から話しかける**: 起こす時刻・頻度はコードが決め、話しかけるかと文面はモデルがルームの会話を fork した会話（aside）で判断する。黙った確認は会話に残さず、話しかけた確認だけを採用する（黙った履歴が並ぶとモデルがますます黙る方向に引っ張られるため）。
- **権限と承認**: `read` / `write` / `edit` / `bash` とブラウザ操作は制限なしでモデルに任せる。CalDAV の変更・削除のみユーザー承認（リアクションかコマンド）を必須とし、作成とタスク完了は自動。
- **認証情報**: `!cred` で管理（Matrix を信頼）。TOTP 秘密鍵は持たず都度チャットで受け取る。画像認証はスクリーンショットと `browser_click_at` でモデルに解かせてよい。
- **ブラウザ隔離**: nixpkgs の Chromium 自身のサンドボックス＋外側を Landlock（**ABI 10 以上必須**、満たさなければ起動しない）で囲う。LAN へは egress プロキシで遮断。
- **実行環境**: Ubuntu 26.10 VM（カーネル 7.3+。26.04 の 7.0 は Landlock ABI 不足）。Nix はビルドと開発環境に使い、常駐は systemd ユーザーサービス。

## 構成と依存の制約

- `gateway/`（Rust）: E2EE デバイスを持つ Matrix クライアント。Node バインディングが無いため子プロセスで動かし、stdin/stdout の JSON Lines で通信する。
- `src/`（Node）: `pi-durable` のエージェント本体。
- `sandbox/`（Rust、依存は `libc` のみ）: Chromium を囲う `agent-sandbox`。
- **依存の固定**:
  - `@earendil-works/pi-durable` 系は `package.json` で厳密バージョン指定し、週次の自動更新 PR で `@earendil-works/*` を揃えて上げる（マージ前に保存形式の変更を確認する）。
  - `matrix-rust-rtc` は v0.5.0、`matrix-sdk` は git rev `56bc5911`（`matrix-rust-rtc` と揃える）。`livekit` 系も含め自動更新せず手動で揃える（将来的に `matrix-rust-rtc` が crates.io 版 `matrix-sdk` に依存するようになれば git rev 固定は外せる。また次に `matrix-sdk` を上げる際、上流から消えていれば `[patch.crates-io] const_panic` も削除できる。`matrix-rust-rtc` が送信時に stable 識別子 `m.rtc.member`・`sticky_key`・`m.rtc.encryption_key` を出すようになったら、`gateway/src/call.rs` の `StableWireBackend` / `JoinedCall` と追加依存を外して `LiveKitCall::join` に戻す）。
  - `libwebrtc` は `nix/libwebrtc.nix` で `WEBRTC_TAG` と揃えて渡す（clang 21+ 必須）。
  - `playwright-core` は npm に入れず、nixpkgs の `playwright-driver` を `node_modules/playwright-core` にリンクする（`npm install` で消えるので開発シェルに入り直す）。

## 部品ごとの判断と制約

### Matrix・配信・会話・途中経過

- **E2EE とデバイス検証**: 非暗号化のメッセージ・リアクション・通話メンバーシップ（`m.rtc.member`）は拒否し、クロス署名済みデバイスのみと通信する（通話のメディア鍵交換 MSC4153 も同様）。クライアント側のデバイス検証が必須。
- **落ちても1回だけ答える**: ゲートウェイは受信を `gateway-state.json` に永続化して ack で消す。エージェントはイベント ID を `requestId` にして submit し、返信・音声・途中経過はイベント ID 由来のトランザクション ID で送る（通話の返答は台帳に載せない）。
- **プロンプトキャッシュ維持**:
  - 現在時刻はシステムプロンプトに入れず、各発言の先頭に付ける。
  - `memory` セクションは SOUL の直前に置く（会話途中で変わるのは記憶だけのため）。
  - ツール一覧は aside を含め全会話で同一にする。
- 秘密情報の規則は `self` と compaction の要約指示の両方に置く（Skills に置くと読まれるまで効かない）。
- `!new` は実行中の返答を `abort()` してから `reset()` する。`!help` 等のコマンドは承認待ち・確認コード待ちを中断しない。
- 途中経過は notice 1件を編集して見せる。生成中の本文は最終回答と二重に見えるため出さず、ツール出力は秘密漏洩防止のため出さない。思考は `thinking` 設定が `off` 以外のときだけ、1ブロック先頭 200 字まで出す。

### 記憶・カレンダー・承認

- 記憶の整理は予定を消すが、そこに含まれる事実（引っ越し先など）は残させる。モデルの出力は検証し（箇条書きでない・元より長い場合は不採用）、置き換え前を `data/memory/history/` に残す。
- 繰り返し予定は `TZID` + VTIMEZONE で書き、読むときは IANA 名として解決する（`src/zones.ts` で ical.js の `TimezoneService` を補完）。変更・削除は取り違え防止のため `scope`（`this` / `all`）を必須とし、「この回以降」は未実装（2件書き込み途中のクラッシュ対処が要るため）。繰り返しタスクは最初の回のみ対応。
- 承認はツール呼び出しの中で待機（24時間で拒否）。リアクションはゲートウェイの `inbox` に永続化しないため、受け渡し途中のクラッシュでは失われうる。

### 気象・ジオコーディング

- **プライバシー配慮**: 気象庁 API に現在地を知らせないよう、区域の3時間予報は発表地域内の全区域を取得してローカル選択、天気分布予報・15h 雨は GeoJSON をローカル照合する。1h 雨と今後の雪のみ `z=10` PNG のタイル番号が伝わる。
- 範囲系（`weather_forecast_grid` / `weather_rain_grid` / `weather_snow_grid`）は出力量が大きいため `codemode` から絞って使う前提。
- 気象系（天気・雨・雪）の時刻はすべて日本時間で表示する。
- `geocode` は事前生成した `geocode.sqlite` をローカル参照する（手順は `manual/geocode.md`）。

### 自分から話しかける（Proactive / Timer）

- aside 中は読み取り系ツールのみ `beforeTool` フックで許可する（ホワイトリスト方式。あとから足したツールや MCP を既定で拒むため）。`browser_screenshot` の `share` もチャット送信の副作用を避けるため aside 中は拒否する。
- `timer_add` は aside を使わず通常実行として動かす（aside 内で書き込みを許すと、ユーザー発言との競合で aside が破棄・再実行されたときに副作用が二重になるため）。
- **採らなかった案**:
  - `followup_add`: 会話中にモデルが気づかないと登録されないため、定時確認で会話を読み返す形にした。
  - systemd-timer: 常駐エージェントに外から起こしてもらう利点が無い。
  - VTODO の独自プロパティ: スマホアプリで見えず、編集時に残る保証がない。

### 音声・通話

- **STT**: whisper.cpp（`large-v3-turbo q8_0`、Vulkan、VAD 余白 0）。VAD が無いと 30 秒区切りで文が落ち、余白があると末尾無音に「はい」が出る。
- **通話の制約**:
  - **Sliding Sync + sticky events（MSC4143 / MSC4354）専用**: ホームサーバー側（Tuwunel 2.1.0+ 等）と Element Call 側の両方が sticky events 形式に対応している前提（旧 `state events` 互換は持たない）。
  - 交互に話す設計（bot の再生中＋500ms は相手の音声を捨てる）。エコーや言い終わる前の間での誤中断を防ぐため。返答は全文合成してから流す（ストリーミング未実装）。
  - `webrtc-vad` は `libwebrtc` と C シンボルが衝突するため、純 Rust の `earshot` を使用。

### Web・MCP・codemode

- MCP は `@earendil-works/pi-mcp`（依存が少ない）。GET ストリーム・stdio・OAuth は未対応。LAN 内サーバーも使えるよう egress プロキシを通さない。
- MCP の既定は `exposure: "codemode"`（`deferred` にして接続遅延でツール一覧が変わらないようにする）。よく使う Keenable のみ `direct`。
- `web_extract` はログイン済みブラウザとは別の Chromium（cookie なし・`bypassCSP` あり）。`browser_read` は XSS 防止のため `bypassCSP` なし。
- PDF 解析は Poppler を Landlock 下で stdin 渡し（`pymupdf4llm` は表・字下げ崩れと依存の大きさで不採用）。OCR はしない。
- `codemode` は QuickJS（256MiB 上限）。ブラウザのパスワード伏せ字や実行コンテキスト判定はスクリプト経由でも効く。

### ブラウザ・認証情報・Chromium サンドボックス

- 常にヘッドレス。ツールが返した画像は直近3枚だけモデルに送り、3枚まとめて古い順に省略する（1枚ずつ外すとキャッシュが切れるため）。ブラウザのスナップショットも同様に、直近2枚を残して3枚まとめて古い順にツリー本体のみ省略する（URL・タイトル・操作メモは残す）。
- 登録済みサイトはシステムプロンプトに一覧しない（`!cred add` のキャッシュ切れと、モデルが古い一覧を信じる問題のため）。該当ページを開いたときだけツール結果に添える。
- **守れていないこと**: `bash` と `read` が無制限なので、モデルは `credentials.json` / `auth.json` / `env` を読める（プロンプトインジェクション経由で漏れる余地がある）。
- **Chromium 囲いの要点と残存リスク**:
  - Ubuntu の userns 制限対策として `apparmor/agent-chromium` を `just apparmor` で入れる。
  - エージェントの `TMPDIR` は渡さない（SQLite や `bash` が使うため）。結果としてブラウザからのダウンロードは不可。
  - 残存リスク: カーネル脆弱性（Ubuntu 26.10 は9か月サポートなので更新運用が必須）、ブラウザ本体乗っ取り時のログイン済みセッション悪用、Landlock TCP がポート番号のみ判定する点（ランダムポートで軽減）。

### compaction・モデル

- 裏の compaction は `compaction.maxTokens`（既定 200,000）で始め、さらに `Scheduler.tick()` で定時チェックの前にアイドル状態の会話（`idleMinutes` 経過かつ `idleTokens` 以上、既定 60 分 / 64,000）を圧縮する（アクティブ中はキャッシュと文脈を活かしつつ、キャッシュが切れた後の定時チェック・再開コストを抑えるため）。要約は「あとで聞くとよさそうなこと」を残す独自指示。
- OpenAI Responses API ではサーバー compaction（`compaction_trigger`）も併用し、`host.sqlite` に保存して `beforeProviderRequest` で差し替える。
- モデルカタログは pi.dev から取得して `dataDir/model-catalog.json` にキャッシュする（User-Agent に pi-ai の版が必要）。
- API キーは `~/.config/agent/env`、`just model-login` は OAuth 専用（`auth.json` のキーが環境変数より優先される）。

## 動かし方とテスト

- **テスト・検証**: `just check`（型・Node・gateway）、`just spec` / `just verify`（Quint モデルのシミュレーション・有界モデル検査）、`just test-caldav`、`just test-stt`。Chromium を2つ開くテストはプロセス数上限に当たることがあるため、必要に応じて `systemd-run --user --scope -p TasksMax=400` で回す。
- **テストの方針**（`AGENTS.md` に加えて）:
  - 外から見える結果（送られたメッセージ、モデルへの入力、ファイル/カレンダー状態）で検証し、内部 DB や iCalendar 生文字列は見ない。
  - 時間は偽時計/偽タイマーで進める。
  - `test/protocol.ts` を変えたら `just protocol` で `test/protocol.json` を再生成する。
- **初回セットアップ（Ubuntu VM）**:
  1. ユーザーを `nix-users` グループに追加して再ログイン
  2. `just setup` → `~/.config/agent/config.json` と `env` を編集
  3. `just vulkan` で GPU 確認 → `just install`（未コミット変更があると止まる）
  4. `just login`（OAuth は `just model-login`）→ `systemctl --user restart agent.service`
