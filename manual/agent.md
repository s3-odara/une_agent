# このエージェントの説明書

あなた（このエージェント）自身の仕組みと設定の変え方。ユーザーに頼まれたら、ここに書いたやり方で自分の設定を変えてよい。

## 構成

- Matrix の bot。ルームごとに会話が分かれ、ルームごとに人格が決まる。bot のアカウントは1つ
- 2つのプロセス: Matrix とやり取りするゲートウェイ（Rust）と、このエージェント（Node、pi-durable）
- 常駐しているときは systemd のユーザーサービス `agent.service`。ログは `journalctl --user -u agent.service`。
  `agent_restart` で起動し直すのは常駐しているときだけで、それ以外（`just run`）では止まったままになる

## ファイル（設定ファイルのあるディレクトリから見た場所）

| 場所 | 中身 | 変更が効くとき |
|---|---|---|
| `config.json` | 設定（下の節） | `agent_restart` のあと |
| `env` | API キーやパスワード（常駐時）。開発時はリポジトリの `.env` | 再起動のあと（`agent_restart` では読み直さない。ユーザーに `systemctl --user restart agent` を頼む） |
| `personas/*.md` | 人格の口調や振る舞い（SOUL ファイル） | 次の発言から |
| `data/memory/shared.md`、`data/memory/persona/<人格>.md` | 長期記憶。ふだんは memory_* ツールで書く | すぐ |
| `data/credentials.json` | サイトの認証情報。ユーザーは `!cred` で登録する | すぐ |
| `data/auth.json` | モデルのログイン（OpenAI Codex） | すぐ |
| `data/session.sqlite`、`data/host.sqlite` | 会話と台帳 | 動いている間は書き換えない |
| `data/matrix-store/`、`data/matrix-session.json` | Matrix の暗号鍵とログイン | 触らない（消すと暗号化ルームが読めなくなる） |

`env`、`credentials.json`、`auth.json` は秘密情報。中身をチャットに書かない。

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
- `personas`: 人格の名前 → 設定。値は SOUL ファイルのパスだけでもよい
  - `soul`: SOUL ファイル（設定ファイルからの相対パス）
  - `privateMemory`: その人格だけの専用メモを持つか
  - `model`: その人格だけ別のモデルにする
  - `browserProfile`: ブラウザの cookie とログインをどれと共有するか（既定 `default`）
  - `voice`: 読み上げの声（VOICEVOX のスタイル ID）
- `defaultPersona`: `rooms` に無いルームの人格
- `rooms`: ルーム ID → 人格の名前
- ほかに `matrix`、`timezone`、`memory`（記憶の上限と整理の時刻）、`caldav`、`weather`、`browser`、`web`、`mcp`、
  `voice`、`proactive`（朝ブリーフとリマインドの送り先・時刻）がある。分からない項目は変えない

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

## チャットのコマンド

`!` で始まるコマンド（会話のやり直し、承認、認証情報の登録など）はモデルに届かない。ユーザーは `!help` で一覧を見られる。
