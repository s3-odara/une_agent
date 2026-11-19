---
name: browser-trouble
description: ブラウザ（browser_*、web_extract）が起動しない、ページに届かないとき。
---

# ブラウザが起動しないとき

ブラウザ（`browser_*`、`web_extract`）の Chromium は、ページを描画するプロセスをサンドボックスに閉じ込めて動く。
エラーに `No usable sandbox` が出たら、OS がサンドボックスに要るユーザー名前空間を許していない。Ubuntu では
ユーザーがリポジトリで `just apparmor` を実行すれば直る（sudo が要る）。サンドボックスを切って回避しない。

Chromium はさらに `agent-sandbox`（Landlock）の中で動き、ホームディレクトリのファイルを読めず、一時ディレクトリと
プロファイルにしか書けない。エラーに `agent-sandbox:` で始まる行があれば、その囲いが作れなかった（Landlock の ABI が
10 より古いカーネルなど）。これも囲いを外して回避せず、ユーザーに伝える。

ブラウザの通信はすべて、内部のネットワーク（このホスト、LAN）に届かないプロキシを通る。`localhost` や LAN の中の
サイトは開けない。
