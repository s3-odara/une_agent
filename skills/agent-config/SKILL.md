---
name: agent-config
description: このエージェントの設定（人格、ルームの人格、モデル、思考の深さ、自分から話しかける時刻など）を変えるとき。このエージェントの仕組み、ファイルの場所、チャットのコマンドを聞かれたとき。
---

# このエージェントの設定と仕組み

ユーザーに頼まれたら、ここに書いたやり方で自分の設定を変えてよい。

## 構成

- Matrix の bot。ルームごとに会話が分かれ、ルームごとに人格が決まる。bot のアカウントは1つ
- 2つのプロセス: Matrix とやり取りするゲートウェイ（Rust）と、このエージェント（Node、pi-durable）
- 常駐しているときは systemd のユーザーサービス `agent.service`。ログは `journalctl --user -u agent.service`。
  `agent_restart` で起動し直すのは常駐しているときだけで、それ以外（`just run`）では止まったままになる
- `!` で始まるコマンド（会話のやり直し、承認、認証情報の登録など）はモデルに届かない。ユーザーは `!help` で一覧を見られる

## ファイル（設定ファイルのあるディレクトリから見た場所）

| 場所 | 中身 | 変更が効くとき |
|---|---|---|
| `config.json` | 設定（下の節） | `agent_restart` のあと |
| `env` | API キーやパスワード（常駐時）。開発時はリポジトリの `.env` | 再起動のあと（`agent_restart` では読み直さない。ユーザーに `systemctl --user restart agent` を頼む） |
| `personas/*.md` | 人格の口調や振る舞い（SOUL ファイル） | 次の発言から |
| `skills/<名前>/SKILL.md` | ユーザーが足した手順書。システムプロンプトに名前と説明が一覧される | 次の発言から |
| `data/memory/shared.md`、`data/memory/persona/<人格>.md` | 長期記憶。ふだんは memory_* ツールで書く | すぐ |
| `data/credentials.json` | サイトの認証情報。ユーザーは `!cred` で登録する | すぐ |
| `data/auth.json` | モデルのログイン（OpenAI Codex） | すぐ |
| `data/session.sqlite`、`data/host.sqlite` | 会話と台帳（約束の時刻も） | 動いている間は書き換えない |
| `data/matrix-store/`、`data/matrix-session.json` | Matrix の暗号鍵とログイン | 触らない（消すと暗号化ルームが読めなくなる） |

## config.json の主な項目

```json
{
	"model": "anthropic/claude-fable-5-2",
	"personas": {
		"default": { "soul": "personas/default.md", "privateMemory": false, "browserProfile": "default", "voice": 2 },
		"butler": { "soul": "personas/butler.md", "privateMemory": true, "model": "openai-codex/gpt-6.2-sol" }
	},
	"defaultPersona": "default",
	"rooms": { "!abc:example.org": "butler" }
}
```

- `model`: 全人格の既定のモデル。`"プロバイダー/モデル"`。プロバイダーは `anthropic`（`ANTHROPIC_API_KEY`）、
  `openai-codex`（ChatGPT のログイン）、`openrouter`（`OPENROUTER_API_KEY`、`openrouter/anthropic/claude-fable-5.2` のように書く）
- `thinking`: 思考の深さ。`off`（既定）、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`。深いほど遅く、高くつく。
  思考は返答の前の途中経過の通知に表示される
- `personas`: 人格の名前 → 設定。値は SOUL ファイルのパスだけでもよい
  - `soul`: SOUL ファイル（設定ファイルからの相対パス）
  - `privateMemory`: その人格だけの専用メモを持つか
  - `model`: その人格だけ別のモデルにする
  - `thinking`: その人格だけ思考の深さを変える
  - `browserProfile`: ブラウザの cookie とログインをどれと共有するか（既定 `default`）
  - `voice`: 読み上げの声（VOICEVOX のスタイル ID）
- `defaultPersona`: `rooms` に無いルームの人格
- `rooms`: ルーム ID → 人格の名前
- `proactive`: 自分から話しかける仕組み。決まった時刻と、カレンダーの動きがあったときに、会話を読み返して話しかけるかを決める
  - `roomId`: 話しかけるルーム
  - `briefTime`: 朝のブリーフの時刻
  - `checkTimes`: ほかに会話を読み返す時刻の一覧（例 `["12:00", "18:00"]`）。`roomId` のルームは毎回、ほかのルームは前回からユーザーが
    発言したときだけ読み返す。増やすほど気が利くが、そのたびに会話の全体を読むので高くつく
  - `windowStart`、`windowEnd`: カレンダーの動き（予定が近い、期日、追加・変更）で起きてよい時間帯
  - `tickMinutes`: カレンダーを見に行く間隔（モデルは使わない）
  - `eventLeadMinutes`: 予定の何分前から「近い」とみなすか
  - `dueLeadDays`: タスクの期日の何日前に気にかけるか
- `compaction.at`: 会話がモデルのコンテキストの上限のどれだけに達したら、古い部分を要約に置き換え始めるか（既定 `0.5`）。
  小さいほど安く速いが、細部が要約に変わるのが早くなる
- ほかに `matrix`、`timezone`、`memory`（記憶の上限と整理の時刻）、`caldav`、`weather`、`browser`、`web`、`mcp`、
  `voice` がある。分からない項目は変えない
- `voice.call.chime`: 通話で発言を聞き取れたときに効果音を鳴らすか（既定 `true`）
- `voice.call.transcript`: 通話の文字起こしと返答をルームに notice で書くか（既定 `true`）

## よくある変更

いずれも、変える前に `cp config.json config.json.bak` で控えを取り、変えたら `agent_restart` を呼ぶ。
`agent_restart` は設定を読み込めるか、人格の SOUL ファイルがあるか、モデルが使えるかを確かめてから再起動する。
誤りがあれば再起動せずに理由を返すので、直すか控えに戻す。

- **このルームの人格を変える**: `rooms` に「このルームの ID: 人格名」を足す。ルーム ID はシステムプロンプトにある
- **人格を足す**: `personas/<名前>.md` に口調と振る舞いを書き、`personas` に足す。既存の `personas/default.md` を手本にする
- **人格の口調だけ変える**: その SOUL ファイルを編集する。再起動は要らない
- **モデルを変える**: `model`（全体）か、人格の `model` を書き換える。モデル名が分からなければ `agent_restart` が
  使えるモデルの一覧を返す

再起動は、書いている途中の返答をすべて送ってから行う。通話中なら通話は一度切れる。
