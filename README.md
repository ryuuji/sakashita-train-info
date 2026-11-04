# sakashita-train-info

JR中央本線 坂下駅の「通過時刻表」ページ（claude.ai のアーティファクト）に、列車の遅れを渡すための MCP サーバーです。
Cloudflare Workers で動きます。

JR東海「在来線運行情報」の列車走行位置データ（`zaisenichi.json`）と運行情報（`unkou.json`）を取得し、
中央線の列車ごとの遅れ（分）と運行情報メッセージだけを返します。

- JR東海への取得は **最大 1 分に 1 回**（Cache API で 60 秒キャッシュ）
- 依存パッケージなし・認証なし・ステートレス
- `POST /mcp`（MCP Streamable HTTP、JSON 応答） / `GET /healthz`
- ツール: `get_sakashita_status`（引数なし・読み取り専用）

## 返すデータ

```json
{
  "source": "JR東海 在来線運行情報",
  "fetchedAt": "2026-11-03T23:59:30.000Z",
  "positionTime": "2026-11-04T08:59:20+09:00",
  "line": { "status": "normal | delay | suspend", "message": "…", "messageEn": "…", "cause": "…" },
  "trains": [
    { "trainNumber": "1002M", "type": "特急", "name": "しなの", "no": 2,
      "direction": "nagoya | shiojiri", "destination": "名古屋", "delayMin": 4 }
  ]
}
```

`trains` に含まれるのは、その時点で走行中の中央線の列車だけです。

## はじめてのデプロイ

```sh
npm install
npm test            # 本物のデータを 1 回取得して確認
npx wrangler login  # 個人の Cloudflare アカウントでログイン
npm run deploy
```

デプロイ後の URL: `https://sakashita-train-info.<アカウントのサブドメイン>.workers.dev/mcp`

## GitHub Actions での自動デプロイ

`main` に push すると自動でデプロイします。リポジトリの Settings → Secrets and variables → Actions に次の 2 つを登録してください。

| 名前 | 値 |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Cloudflare の「API トークン」→ テンプレート「Edit Cloudflare Workers」で作成 |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare ダッシュボード右側の「Account ID」 |

## claude.ai への追加

設定 → コネクタ → カスタムコネクタを追加

- 名前: **Sakashita Train Info**（ページはこの名前で呼び出すので一字一句同じに）
- URL: `https://sakashita-train-info.<サブドメイン>.workers.dev/mcp`

ページを開いたときに利用の許可を求められるので、許可すると遅れが表示されます。

## 動作確認

```sh
curl -s -H 'content-type: application/json' https://sakashita-train-info.<サブドメイン>.workers.dev/mcp \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_sakashita_status","arguments":{}}}'
```

## 注意

JR東海の公式APIではなく、運行情報サイトが内部で使っているデータです。予告なく形式が変わることがあります。
利用にあたっては JR東海のサイト利用規約を確認してください。
