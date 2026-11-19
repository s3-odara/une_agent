# 自作パーソナルエージェント 引き継ぎメモ

コードやテスト、コミットからは読み取れないこと（決めたことと理由、制約、確かめていないこと）を書く。
モデル向けの説明書は `manual/agent.md`、プロトコルは `src/gateway.ts` と `gateway/src/ipc.rs`。

## 目的

Hermes Agent / OpenAI dots / Meta Muse / Grok Bot のような常駐パーソナルエージェントを自作する。
Hermes の cron で Dreaming と Proactive を試したが、Muse ほど気が利かなかった。報告の条件が厳しすぎて天気や期日の
リマインドまで `[SILENT]` になり、通知済みの記録が無いので「繰り返さない」を守るには黙るのが安全になっていた。
そこで、送るかどうかはコードが判定し、送る文面だけをモデルに書かせる形にした。

## 決定（ユーザー明言）

- 基盤は **pi-durable**（`@earendil-works/pi-durable` 1.5.2 に固定）。実験的で API が変わるので、上げるときは現行の
  ドキュメントを確かめる
- Matrix は **matrix-rust-sdk**、通話は **matrix-rust-rtc**（element-hq、v0.5.0）。**最初から E2EE ルームに対応**
- 人格は **bot アカウント1つ、ルームごとに人格**。人格は口調（SOUL ファイル）、専用メモの有無、モデルを別々に指定する
  （Hermes の profile のように、口調を変えるだけで設定まで分かれるのは避ける）。人格ごとに会話は分かれる
- モデルの既定は Anthropic (Claude)。OpenAI Codex と OpenRouter も使える
- 記憶は**全人格で共有＋必要な人格だけ専用メモ**。会話中にツールで書かせ、上限つきの全文を毎回読ませる。
  判断の基準は「A に話したことを B が知っていてほしいか」。書いた人格は記録しない（専用メモでは冗長、共有でも応答に効かない）
- 記憶は**毎日 02:00 に整理**する（前回から変わった日だけ。間隔は設定で変えられる）。会話中に書かせた文は冗長になり、
  要らないことも残るため。以前の Dreaming（会話履歴からフォローアップ対象をまとめ直す）は作らない。予定とタスクの正は CalDAV
- CalDAV は `Work`（義務的な予定）、`Home`（個人的な予定）、`ToDo`（タスク）。**作成は自動、変更と削除はユーザーの承認後、
  タスクの完了は承認なし**
- 承認は**依頼へのリアクション（✅ approve / 🔁 approve_session / ♾️ approve_always / ❌ reject）か `!approve` などのコマンド**。
  approve_session はその実行（ターン）の間だけ、approve_always はツール単位。承認待ちの間の別の発言は拒否として扱い、
  その発言はそのままモデルに渡す
- 天気は**気象庁の予報 JSON**。外に送るのは府県単位の地域コードだけ
- ブラウザの操作（クリック、入力、ログイン）は**確認なしで任せる**。取り返しのつかない操作の前の確認はモデルへの指示で、コードでは強制しない
- 認証情報は **`!cred` で追加・一覧・削除**（Matrix は自前で信頼しているので、使い捨てリンクや Widget は採らない）。
  パスワードを含む発言の削除はユーザーが手で行う。TOTP の秘密鍵は持たず、**その都度コードをチャットで受け取って入力する**
  （メールのコードは英数字のことがあるので数字に限らない）。画面は**スクリーンショットでルームに送れる**。
  登録済みのサイトはシステムプロンプトに一覧しない（下の「ブラウザと認証情報」）
- 音声認識は **whisper.cpp の whisper-server、large-v3-turbo q8_0、Vulkan（本番は RX570）、VAD あり（余白0）、ビーム幅5**。
  音声合成は **VOICEVOX**。ボイスメッセージを通話より先に作った
- 通話は**許可ユーザーがルームの通話に入ったら bot も入り、全員抜けたら抜ける**。**ユーザーが話し始めたら bot は話すのを止める**。
  通話の発言はそのルームの会話の続きとして記録する
- Web 検索は **Keenable の MCP**（Streamable HTTP）。ツールをそのままモデルに渡す（codemode は介さない）。
  本文の取得は Hermes の local-extract（Trafilatura + Crawl4AI）を移さず、**Playwright + Readability + Turndown** で作る
- モデルには pi-durable の `read` / `write` / `edit` / `bash` を**制限なしで渡す**。エージェント自身の設定もモデルが変える
- ブラウザ（`browser_*` と `web_extract`）の Chromium は**自身のサンドボックスを有効にし、外側を Landlock で囲う**
  （bwrap や AppArmor では囲わない）。Chromium は nixpkgs のもの。**Landlock ABI 10 以上が必須**で、満たさなければ
  ブラウザは起動しない（囲いを弱めて動かさない）。通信は内部に届かないプロキシだけ（LAN の中のサイトは見ない）
- 返答の途中経過（思考、ツール、再試行、要約）を notice 1件で見せ、進むたびに編集する。`!new` で止めた返答には何も送らない
- 作業中に届いた発言はその実行に合流させる（steer）。スケジューラのブリーフとリマインドは合流させず、作業のあとで別に答える
- 動かす先は **Ubuntu 26.10 の VM**（カーネル 7.3。26.04 の 7.0 は Landlock の ABI が足りない）。NixOS ではないので、
  Nix はビルドと開発環境に使い、常駐は systemd のユーザーサービス

## 構成

- `gateway/`（Rust）: matrix-rust-sdk で bot としてログインし、E2EE のデバイスを持つ。Node 用のバインディングが無いので別プロセス。
  エージェントが子プロセスとして起動し、stdin/stdout の JSON Lines で話す
- `src/`（Node）: pi-durable のエージェント
- `sandbox/`（Rust、依存は libc だけ）: Chromium を囲う `agent-sandbox`
- 状態は `data/`: `session.sqlite`（会話）、`host.sqlite`（ルーム、配送の台帳、承認、通知済み）、`matrix-store/`（暗号ストア）、
  `matrix-session.json`、`gateway-state.json`、`memory/`、`browser/<プロファイル>/`、`credentials.json`、`auth.json`、`web/`

依存の固定:

- matrix-sdk は crates.io 版ではなく git rev `56bc5911`。matrix-rust-rtc v0.5.0 が同じ rev に固定しているので、上げるときは一緒に
- livekit 系のクレートは matrix-rust-rtc の Cargo.lock と同じ版（新しい版の組み合わせはコンパイルできなかった）
- libwebrtc は `nix/libwebrtc.nix` で先に取って `LK_CUSTOM_WEBRTC` で渡す。タグは Cargo.lock の webrtc-sys-build の
  `WEBRTC_TAG` と一緒に上げる。Chromium の libc++ 向けなので C++ は clang 21 以上
- gateway は rustls の暗号プロバイダを起動時に選ぶ（livekit と matrix-sdk で2種類入っている）
- matrix-rust-rtc は AGPL-3.0（または Element の商用ライセンス）。これを含む gateway も AGPL の条件に従う

### 落ちても1回だけ答える

- ゲートウェイは受信した発言を `gateway-state.json` に書いてから渡し、ack で消す。起動時に未 ack 分を再送する
- エージェントは Matrix のイベント ID を `requestId` にして submit する（同じ ID は同じ submission が返る）
- 回答は `reply:<イベントID>`、音声は `voice:<イベントID>`、途中経過は `progress:<イベントID>` をトランザクション ID にする。
  同じ ID の再送は homeserver が1件にまとめる
- 合流した発言はすべて同じ答え（か同じ失敗）で決着するので、返事は1回。答えのエントリを `answers` に先に記録した発言が送る。
  失敗なら `runFailure.inputs` の最初の発言が送る。次の実行で `runFailure` が消えていたらそれぞれが送る（二重になっても黙るよりよい）
- 通話の返答（`Bridge.ask`）は配送の台帳に載せない。落ちても後から文字では送らない

## 部品ごとの判断と制約

### 会話と時刻

- 各発言の先頭に送信時刻を付けてモデルに渡す（`[2026-11-17(火) 09:00] ...`、音声は `音声`、通話は `通話` を添える）。
  システムプロンプトに現在時刻を入れるとプロンプトキャッシュが効かなくなるため
- `!new` は pi-durable の `reset()`。会話そのもの（ルームとの対応、台帳、ブラウザのタブ）は使い続け、記録は `session.sqlite` に残る。
  書いている途中の返答は先に `abort()` する（止めないとリセットはその返答を待ち、返答も送られる）
- `!help` などのコマンドはハンドラーより先に受け取るので、承認待ちや確認コード待ちを取り消さない。`!new` はハンドラーのあと

### 途中経過（`src/progress.ts`）

- notice は通知を鳴らさない（`.m.rule.suppress_notices`）。ただし暗号化ルームではサーバーが msgtype を見られず、クライアント次第
- 編集は2秒に1回まで。Matrix の編集は全文の新しいイベントなので1文字ずつにはしない。3000字を超えたら古いほうから省く
  （編集は本文を2回持ち、イベントは 64KiB まで）
- 書きかけの文と思考は、最後の改行か文末までだけを出す（書きかけの Markdown を見せない）
- ツールの実行中の出力（`bash` など）は見せない。秘密情報がルームに流れるため
- スケジューラの実行と通話では出さない
- 思考は `thinking`（既定 `off`）。off のままだと思考は出ない

### 記憶（`src/memory.ts`、`src/tidy.ts`）

- 人が読める Markdown の箇条書きで、末尾に書いた日付を付ける。手で編集してよい（次の書き込みで形が揃う）
- 3つのツールはどれも繰り返して結果が変わらないので、クラッシュ後に再実行してよい
- 整理は記憶ごとに道具なしの別会話でモデルに見直させる。答えは信用しすぎない（箇条書きでなければ不採用、元より長ければ不採用、
  変えなかった項目は元の日付を保つ）。置き換える前を `data/memory/history/` に残し、何を消して何を足したかをルームに知らせる

### カレンダーと承認（`src/calendar.ts`、`src/caldav.ts`、`src/approval.ts`）

- 予定は UTC で書く。読むときは TZID を IANA のゾーン名として読み、ファイル内の VTIMEZONE は見ない（今のクライアントは
  IANA 名を書く）。ゾーン名でない TZID（Outlook）と floating はユーザーのゾーンで読む
- 繰り返し予定は読めるが作れない。変更と削除は全ての回に効く
- ツールはどれもクラッシュ後に再実行してよい（作成は UID を呼び出しごとに記憶する）
- 承認は呼び出しの中で待ち、モデルには「実行した」か「実行していない理由」だけが返る。24時間で拒否。依頼の ID も呼び出しごとに
  記憶するので、落ちて再実行されても同じ依頼のまま待つ。リアクションはゲートウェイが保存しないので、止まっている間に押された
  ものは届かない（押し直すかコマンドで）
- 以前は「確認コードを返して次の実行でもう一度呼ばせる」方式だったが、承諾かどうかの判断がモデル任せで、2回呼ぶ流れも不自然だったのでやめた

### スケジューラ（`src/scheduler.ts`）

- 既定15分ごと。送ると決まったときだけ、`proactive.roomId` の人格がそのルームの会話の中で書く（あとで「今朝のブリーフの件」と聞ける）
- 朝ブリーフは `briefTime` 以降の最初のチェックで1日1回。止まっていて逃した日はその日の次のチェックで送る
- 追加・変更の知らせは、ETag が変わり、かつ項目の更新時刻が前回のチェック以降のものだけ。エージェント自身の書き込みは知らせない。削除は検知しない
- CalDAV に繋がらないときは黙らず、1日1回そう知らせる
- 気温の最低・最高は値の大小で決めている。気象庁の JSON は当日分の時刻ラベルと値の対応が一貫していなかった（正式な仕様では確かめていない）

### 音声（`src/stt.ts`、`src/tts.ts`）

- whisper-server は最初の音声で Unix ソケットに起動し、`idleMinutes` 使われなければ止める（読み込みは1秒未満）。
  録音は ffmpeg で 16kHz モノラルの WAV にして渡す（サーバーは Ogg を読めない）
- VAD は必須（無いと30秒の区切りで1文を丸ごと落とした）。余白は0（既定の30ms では末尾の無音に「はい」が出た）
- 選んだ根拠（2026-11-17、Ryzen 7 PRO 8840HS / Radeon 780M、33秒と3〜6秒の録音計4本）: whisper.cpp q8_0 + VAD 余白0 は
  CER 0.015 で、faster-whisper int8（CPU）の 0.019 より良く、33秒を 2.3秒（faster-whisper は 8.7秒）。常駐させると 33秒が約2.0秒、
  短文が約0.85秒。large-v3 は turbo より良くならず、f16 も q8_0 より良くならなかった。RX570 にない機能を切った条件で 3.1秒
  （目安）。文末の「?」が落ちることがある
- 返答の読み上げは Markdown の記号、URL、表の罫線、コードを除き、`maxChars` を超える分は文の切れ目で止めて「続きは文字で」と言う
- 声は人格の `voice`（VOICEVOX のスタイル ID）、無ければ `voice.tts.speaker`。公開して使うならキャラクターごとのクレジット表記などの規約に従う
- 一度会話に入った音声は、再送されても文字起こしし直さない

### 通話（`gateway/src/call.rs`、`src/call.ts`）

- 参加者は `org.matrix.msc3401.call.member` のルーム状態（Element Call の「state events」互換形式）で書く。matrix-rust-rtc が
  Element Call に見える形で書けるのはこれだけで、普通の `/sync` で届くのもこれだけ（今の形式は sliding sync の sticky events が要る）。
  **Element Call 側も Developer 設定で互換形式を state events にしておく**
- 期限（`created_ts + expires`）切れの参加は数えない。30秒ごとにも見直す
- 相手の音声を 16kHz に間引き、earshot（純 Rust の VAD）で発話を切る。webrtc-vad クレートは libwebrtc と同じ C の関数を持っていて
  リンクできなかった
- 話し始めを検知した時点でゲートウェイが再生を止める（10ms 単位で送っている）
- 割り込まれたら、次の発言の頭にどこまで話したかを付けて伝える。返答ができる前にまた話し始めたら、その返答は読まずに「伝わっていない」と伝える
- 聞き取れたら短い効果音を鳴らす（`src/chime.ts` がコードで作る）。文字起こしと返答の全文はルームに notice で書く（話した人は書かない。許可ユーザーが1人の前提）
- **クロス署名されていないデバイスとはメディアの鍵を交換しない**（MSC4153、ライブラリの既定）。使うクライアントのデバイスは検証しておく

### Web 検索と本文（`src/mcp.ts`、`src/extract.ts`、`src/page.ts`、`src/web-tools.ts`）

- MCP クライアントは自作。pi-durable には無く、公式の `@modelcontextprotocol/sdk` は express や hono などサーバー用の依存を約90個
  連れてくるため。初期化、`tools/list`、`tools/call` だけを持ち、サーバーからの要求と通知は扱わない
- サーバーが落ちていても起動は待たせない。試し直してつながった時点でツールが現れる
- Keenable は `fetch_page_content` も持つが、本文の取得は自作に一本化するので `tools` は `search_web_pages` だけ。鍵なしでも使える（回数制限あり）
- `web_extract` はブラウザのツールとは別の Chromium で、ページごとに新しいコンテキスト（cookie もログインも無し）で開く
- Readability が本文と判定した部分が200字未満ならページ全体を読む。`whole` で判定を飛ばせる。Trafilatura と「記事かどうか」の判定は入れない
- `web_extract` は CSP を無視する（`bypassCSP`）。ログインしたブラウザ（`browser_read`）では外さない（XSS の危険）ので、
  Trusted Types を求めるページでは本文を判定できず、ページ全体を読む
- 長いページは `maxChars` ごとに区切って `offset` で続きを読む。読んだページは1時間 `data/web/` に置き、続きはそこから読む
- 内部のネットワークへは `src/egress.ts` のプロキシで届かない。プロキシが自分で名前を引き、公開アドレスでなければ断り、引いた IP に
  そのまま接続する（DNS rebinding も通らない）。名前のアドレスに1つでも公開でないものがあればその名前ごと断る。IPv6 は 2000::/3 のうち
  Teredo、6to4、文書用を除いたものだけで、IPv4 を IPv6 で書いたアドレスは常に公開でない

### ブラウザと認証情報（`src/browser.ts`、`src/browser-tools.ts`、`src/credentials.ts`、`src/codes.ts`）

- ページは要素のツリーとして読み、ツリーに付く ref で操作する。ツールはどれもクラッシュ後に再実行しない
- プロファイルは既定で全人格が `default` を共有し、人格の `browserProfile` で分けられる。会話ごとに別のタブ
- 常にヘッドレス。画面を開いて手でログインする仕組みは使っていなかったので消した（表示のために囲いを広げていた）。
  二段階認証は `browser_request_code`、画像認証などはスクリーンショットを送って止まる
- コードで守っていること:
  - パスワードを入れるのは `browser_fill_credential` だけ。入力先がパスワード欄で、その欄の文書のオリジンが登録と完全に一致するときだけ
  - スナップショットではパスワード欄の中身を常に伏せる。ツリーは入力欄の値をそのまま出すので、自動入力された未登録のパスワードまで渡る（実 Chromium で確認）
  - ツールが返す文字列から、登録済みのパスワードをすべて伏せる。確認コードも伏せる
  - スクリーンショットではパスワード欄（name に pass を含む欄も）を塗りつぶす
  - 開けるのは http と https だけ。スケジューラが始めた実行ではブラウザを使えない
- 登録済みのサイトをシステムプロンプトに一覧しないのは、`!cred add` のたびにキャッシュが切れるのと、実機で会話の途中の一覧の
  更新が届いていたのに、モデル（`openai-codex/gpt-6.2-sol`）が古い一覧と自分の前の返答を信じて「未登録」と答えたため。
  代わりに、登録済みのサイトのページを開いたときだけツールの結果に書く
- `!cred` で始まる発言は書き方が間違っていても必ず受け取る（パスワードを含みうるため）。`browser` の設定が無くても受け取る
- 確認コードの待ちはメモリだけ（ページもプロセスと一緒に消えるので、再起動をまたいで待たない）
- **守れていないこと**: `bash` と `read` を制限なしで渡しているので、モデルは `credentials.json`、`auth.json`、`env` を読める。
  読めば会話ログとモデルの提供元に届く。ページの文面に誘導されてそうする余地もある。説明書には「秘密情報の中身をチャットに書かない」とだけ書いた

### Chromium の囲い（`src/sandbox.ts`、`sandbox/`）

守れるのは「ページを開いただけで乗っ取られる」経路。Playwright は `chromiumSandbox: true` を渡さないと `--no-sandbox` で起動し、
以前はレンダラーの脆弱性でエージェントと同じ権限になっていた。

- Chromium のサンドボックス: レンダラーは別のユーザー・PID・ネットワークの名前空間に入り、root が空のディレクトリになる
  （テストは root が `/` でないことで確かめる。seccomp は `--no-sandbox` でもかかっていて違いが出なかった）
- Ubuntu はプロファイルを持たないプログラムがユーザー名前空間を作るのを禁じている。`apparmor/agent-chromium`（Ubuntu の Chrome 用と
  同じ、`userns` だけを足した unconfined のプロファイル。パスは glob）を `just apparmor` で入れる
- 外側の囲い: Playwright はブラウザに実行ファイルと環境変数しか渡せないので、`executablePath` をラッパーにして方針を環境変数で渡す
  - ファイル: 読めるのは `/nix/store`、`/etc`、`/usr`、`/sys`、フォント、`/run/systemd/resolve`、Chromium の場所。書けるのは
    起動ごとの `HOME`（中に `TMPDIR`）、プロファイル（`--user-data-dir=` を見て与える）、`/proc`、`/dev` のいくつか。
    `/proc` に書けないと uid_map を書けず起動しない。外のプロセスの `/proc` は Landlock が止める
  - エージェントの一時ディレクトリは与えない。SQLite とモデルの `bash` が使うため。エージェントの `TMPDIR` を替える案は、
    プロセスの中で一時ファイルを使うものを洗い出せないのでやめた。結果としてダウンロードはできない
  - `HOME` を深い場所に置くと、Chromium が `TMPDIR` に作る UNIX ソケットのパスが上限（107バイト）を超える。共有すると並列の起動が互いを待つ
  - 環境変数は決めたものだけを渡す（以前は API キーや CalDAV のパスワードまで渡っていた）
  - TCP はプロキシのポートへの接続だけ。待ち受けと UDP は禁止。外で作られた UNIX ソケット（ユーザーの D-Bus。systemd に頼んで
    囲いの外でプロセスを起動できる）にはつながらない。書ける場所にも `RESOLVE_UNIX` は与えない
  - seccomp で io_uring と x86_64 以外のシステムコールを断る
- 選ばなかったもの:
  - Hermes の AppArmor と systemd の構成。root のサービスと sudoers が要り（ユーザーサービスでは `IPAddressDeny` が効かない）、
    AppArmor はパスが読み込み時に固定で設定の場所に追従できず、開発機でテストできない
  - `web_extract` だけを bwrap で包むこと。そこまでする相手は、モデルを誘導して `browser_*` で同じページを開かせられる
  - 実行できるプログラムを Chromium に絞ること。ブラウザ本体で任意のコードを動かせる相手は、`python3` や `curl` でできることを
    自分のコードでもできる。実行したものも同じ囲いの中で、`no_new_privs` で setuid も効かない
  - seccomp に攻撃に使われやすいシステムコールを足すこと。効くのはカーネルの脆弱性で抜ける段階だけで、`bpf` などは Ubuntu の既定で
    使えず、下準備の手段（`msgsnd`、パイプ）は残る。ユーザー名前空間から触れる nf_tables などは、Chromium のサンドボックスが
    ユーザー名前空間を要るので塞げない
  - ヘッドレスで `--disable-gpu`。GPU プロセスは残り、スレッドも減らなかった
- 残っている危険:
  - カーネルの脆弱性で囲いごと抜けられること。カーネルの更新を続けるのが一番効く。Ubuntu 26.10 は9か月で更新が終わるので、
    次のリリースへの更新と、自動更新のあとの再起動を運用に入れる
  - ブラウザ本体を乗っ取られると、プロファイルのログイン済みのセッションは使われる。ログインしておくサイトを必要なものに絞る
  - Landlock の TCP の規則はポート番号だけを見る。乗っ取った相手は、プロキシと同じ番号のポートなら LAN とこのホストにもつなげる
    （プロキシのポートは起動ごとにランダムなので影響は小さい）。塞ぐにはネットワーク名前空間を分ける必要があり、やっていない

Chromium と Playwright の出どころ:

- Chromium は nixpkgs の `chromium`（Chrome の安定版の修正に数日で追いつく。Playwright 同梱のものは Playwright のリリースを待つ）。
  Playwright が保証するのは同梱の版で、nixpkgs は1つ新しいことがある。ヘッドレスシェルは nixpkgs に無いので通常の Chromium を使う
  （1回の起動で約130スレッド）
- `playwright-core` は npm の依存に入れず、nixpkgs の `playwright-driver` を `node_modules/playwright-core` にリンクする
  （パッケージは `nix/agent.nix`、開発用シェルは入るときに張る。`npm install` するとリンクが消えるので、シェルに入り直す）

### シェルと自分の設定（`src/self.ts`）

- 作業ディレクトリは設定ファイルの置き場所（常駐時は `~/.config/agent`）。隔離はしていない
- 説明書 `manual/agent.md` はモデルが必要なときに `read` で読む（システムプロンプトには場所だけを書くので、長くしてもキャッシュと
  文脈を食わない）。設定やファイルの置き場所を変えたら説明書も直す
- `agent_restart` は設定、SOUL ファイル、モデルを確かめてから終了コード 75 で終わり、systemd（`RestartForceExitStatus=75`）が起動し直す。
  壊れた設定で再起動するとチャットから直せなくなるため。起動時も同じ確認をする。通話中の再起動は読み上げの途中で切れることがある

### モデル（`src/harness.ts`、`src/model-auth.ts`、`src/model-catalog.ts`）

- モデルは `"プロバイダー/モデル"` の文字列。区切るのは最初の `/` だけ（OpenRouter のモデル名に `/` があるため）
- pi-ai の既定の認証情報ストアはメモリだけなので、`dataDir/auth.json`（pi-ai の CLI と同じ形）を読み書きする。
  OAuth の更新トークンは使うたびに変わるので書き戻す。OpenAI に送るインストールの ID は `dataDir/device-id` に保存する
- pi-ai 1.5.2 に組み込みのカタログは古い（`gpt-6.2-sol` が無い）。pi 本体と同じく pi.dev のカタログを重ね、`dataDir/model-catalog.json`
  に pi-ai の版と一緒に保存する（版が変われば捨てる）。pi.dev は User-Agent の版で絞る（`pi/1.0.0` では 6.2 が出ない）ので pi-ai 自身のものを送る
- 起動時は、設定のモデルが保存したカタログに全部あればそのまま起動して更新は裏で行う。無いときだけ pi.dev を最大15秒待つ

## 動かし方

開発:

1. `cp config.example.json config.json` で homeserver、bot のユーザー ID、`allowedUsers` を書く。`cp .env.example .env` で API キーを書く
2. `nix develop`（direnv なら自動）で入り、`npm install`
3. `just login`。新規アカウントならリカバリーキーを控える。設定済みなら `just login --recovery-key '<key>'`
4. `just run`。Element で暗号化ルームを作り、bot を招待して話しかける

テスト: `just check`（型、Node、gateway）。`just test-caldav`（Radicale を立てる）、`just test-stt 録音:… 台本:…`（whisper-server の実物）。
実 Chromium のテストは Chromium が無いときだけスキップし、起動しなければ失敗する。このマシンの Claude Code のセッションは
プロセス数の上限が小さく、Chromium を2つ開くテストで超えてセッションごと落ちたことがある（`systemd-run --user --scope -p TasksMax=400` の中で回す）。

常駐（Ubuntu の VM、初回）:

0. ユーザーを `nix-users` グループに入れてログインし直す（入っていないと Nix のデーモンに `Permission denied`）
1. `just setup`（linger、AppArmor のプロファイル（sudo）、`~/.config/agent/` に雛形）
2. `~/.config/agent/config.json` と `~/.config/agent/env` を書く
3. `just deployed-login`。Codex を使うなら `just deployed-model-login`（URL をブラウザで開いて ChatGPT でログイン）
4. `just vulkan` で GPU を確かめる（`AMD …（RADV …）` が出ればよい。llvmpipe だけなら CPU で動く）
5. `just install`。更新は `git pull` してもう一度。ログは `just logs`
6. VOICEVOX は `voicevox.service` が nixpkgs のものを起動する

- `just install` はチェックアウトしているコミットをビルドして `~/.local/state/agent/current` にリンクする。未コミットの変更があれば止まる
  （動いているものをコミットとして `just status` で見せるため）。`deployed-*` は `current` のコマンドを使う
- **定期的に `nix flake update`**（Playwright と Chromium を含む）。そのあと `just check`、コミット、`just install`
- パッケージは環境変数（`AGENT_GATEWAY_BIN`、`AGENT_WHISPER_SERVER`、`AGENT_STT_MODELS`、`AGENT_CHROMIUM`、`AGENT_SANDBOX_BIN`）で
  部品の場所を渡す。npm のビルドは `agent-unwrapped` に分けてあり、部品が変わってもやり直さない
- whisper-server は測定したコミットに固定し、Vulkan つきで CPU 向けコードは世代別に作る。GPU は nixpkgs の Mesa
  （AMD の native context に対応）を使い、ホストのドライバーは読まない
- VOICEVOX の onnxruntime は unfree 扱い。flake は名前が `voicevox` で始まるものだけ許可している

## 配置済みの環境でやること

- `~/.config/agent/config.json` を今の形に直す。モデルは文字列（`{ provider, modelId }` は読めない）。知らない項目はエラーになる
  （消した `browser.headless` が残っていれば消す）。思考を見せるなら `"thinking": "medium"` などを足す
- Chromium を nixpkgs のものに替えてパスが変わったので、`just apparmor` をやり直す

## 未検証

- 実際の homeserver（tuwunel）と Element / Sable で一通り: ログイン、E2EE、デバイスの検証、送受信、`kill -9` のあと回答が1回だけ届くこと、
  ボイスメッセージの受信と再生、返信の `m.relates_to`、画像の表示、notice の編集の表示と通知が鳴らないこと、送信回数の制限
- **`!cred add` の発言が `data/matrix-store/` に残るか**（matrix-sdk はイベントを SQLite にキャッシュすることがあり、ストアにパスフレーズは
  付けていない）。使ったあと、パスワードの文字列が残っていないか、ユーザーが消したあとに消えるかを確かめる
- 実際に使う CalDAV サーバー（Radicale 3.9 では往復テストが通っている。探索や ETag の返し方はサーバーで違うので、初回に同じテストを当てる）
- 実際のモデルの振る舞い: ブリーフの質、音声と通話で短く答えるか、ツリーを読んでブラウザを操作できるか、検索と `web_extract` の
  使い分けと `offset`・`whole`、思考を返すか（Claude の要約された思考、Codex の推論の要約）
- 実際の ChatGPT アカウントでのログインと、Codex での会話とトークンの更新
- 通話: Sable / Element Call との通話、tuwunel の MatrixRTC、遅延（区切り 0.8秒、文字起こし約1秒、返答の全文を待ってから合成。
  ストリーミングしていない）、複数の許可ユーザーが同時に話すとき、遅延イベント（MSC4140）に対応していない homeserver で
  ブラウザが落ちたまま期限（既定4時間）まで参加中とみなされること
- RX570 での whisper-server の速さと、RADV（Polaris）で動くか。virtio native context での GPU
- Ubuntu 26.10 の VM での一連（`just setup` から `just install`、systemd のユーザーサービス、linger、Ubuntu の制限の下での
  Chromium のサンドボックスの起動）。実在のサイト（重いページ、ボット対策、二段階認証）
- nixpkgs の Chromium の版が上がる `nix flake update` を実際に回すこと

確かめたこと（このマシン、Gentoo、kernel 7.3、Landlock ABI 11）: 全パッケージのビルドと、PATH に何も無い環境から gateway がローカルの
tuwunel につながること。tuwunel 2.0.0 + livekit-server で、通話への参加と退出、E2EE の鍵、発話の切り出しと文字起こし、bot の声が届くこと、
話し始めで止まること。実際の Keenable での検索と、公開アドレスだけのプロキシ越しに日本語のページを本文として読めること。
pi.dev のカタログで `gpt-6.2-sol` が見つかること。VOICEVOX 0.25.2 / 0.26.2 で合成して Ogg Opus と 48kHz WAV にできること。

## テストの方針

`AGENTS.md` に加えて:

- 1つのテストで1つの振る舞いを確かめ、名前はその振る舞いを文で書く。入力だけ違う場合は表にして1件ずつのテストにする
- 外から見える結果で確かめる（ルームに送られたもの、モデルに渡った内容、カレンダーや記憶ファイルの状態、再起動しても送り直さないこと）。
  内部の DB、送信 ID の書式、iCalendar の文字列は見ない（例外: 人が手で編集する記憶ファイルの形と、`SEQUENCE`）
- 文言は写さない。モデルに渡す決まった文は本体の定数や関数（`refusal()`、`OVERTAKEN`、`UNTRUSTED`）と比べる。
  ユーザー向けの通知は「通知であること」と「理由やデータを含むこと」までを確かめる
- 時間は偽の時計か偽のタイマーで進める。決まっているはずの結果は待たずに確かめる
- 共通の準備は `test/env.ts`、偽物とモデル側の補助は `test/fakes.ts`
- gateway とのやり取りの行は `test/protocol.ts` に型つきで書く。変えたら `just protocol` で `test/protocol.json` を作り直す
  （gateway の往復テストがそれを読み、ずれていると `test/protocol.test.ts` が落ちる）
