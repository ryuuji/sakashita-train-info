// 坂下駅 通過時刻表（Cloudflare Workers 版）
// デプロイ: npx wrangler deploy（または GitHub Actions で main への push 時に自動デプロイ）
// / は public/ の静的ページ、GET /api/status が遅延データ（JSON）、POST /mcp が MCP エンドポイント
// JR東海への取得は Cache API で 60 秒キャッシュ（最大 1 分に 1 回）

const BASE = "https://traininfo.jr-central.co.jp/zairaisen/data";
const TTL = 60;
const UA = "sakashita-train-info/1.0 (+CALIL Inc)";
const SERVER_INFO = { name: "sakashita-train-info", version: "1.0.0" };
const TOOL = {
  name: "get_sakashita_status",
  title: "坂下駅 運行情報",
  description:
    "JR中央本線（中津川〜南木曽付近）の列車ごとの遅れ（分）と、中央線の運行情報メッセージを返す。" +
    "データ元はJR東海 在来線運行情報。取得は最大1分に1回で、それ以内の呼び出しにはキャッシュを返す。",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true, openWorldHint: true },
};
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, mcp-protocol-version, mcp-session-id, authorization",
  "access-control-allow-methods": "POST, GET, OPTIONS",
};

const pick = (v, lang) => (Array.isArray(v) ? (v.find((x) => x.lang === lang)?.name ?? v.find((x) => x.lang === lang)?.message ?? "") : (v ?? ""));
const ja = (v) => pick(v, "ja"), en = (v) => pick(v, "en");
const jst = (s) => (s && s.length >= 12 ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(8, 10)}:${s.slice(10, 12)}:${s.slice(12, 14) || "00"}+09:00` : null);

async function getJson(path) {
  const r = await fetch(`${BASE}/${path}`, { headers: { "user-agent": UA, accept: "application/json" } });
  if (!r.ok) throw new Error(`JR東海 ${path}: HTTP ${r.status}`);
  return JSON.parse((await r.text()).replace(/^﻿/, ""));
}

async function fetchStatus() {
  const [pos, unkou] = await Promise.all([getJson("zaisenichi.json"), getJson("trainInfo/json/unkou.json").catch(() => null)]);
  const trains = (pos.train_info || [])
    .filter((t) => ja(t.linename) === "中央線")
    .map((t) => ({
      trainNumber: t.trainnumber,
      type: ja(t.traintype),
      name: ja(t.nickname) || null,
      no: t.nickname_no && t.nickname_no !== "-1" ? Number(t.nickname_no) : null,
      direction: /名古屋/.test(ja(t.direction)) ? "nagoya" : "shiojiri",
      destination: ja(t.tostation),
      delayMin: Number(t.delay_lin) || 0,
    }));
  let line = { status: "normal", message: null, messageEn: null, cause: null };
  if (unkou) {
    const msg = (unkou.message_info || []).find((m) => ja(m.trainline).startsWith("中央線"));
    const evs = (unkou.events || []).filter((e) => ja(e.imp_line).startsWith("中央線") || /しなの/.test(ja(e.express_name)));
    const st = evs.map((e) => ja(e.status));
    line = {
      status: st.some((s) => s.startsWith("運転見合わせ")) ? "suspend" : st.length || msg ? "delay" : "normal",
      message: msg ? ja(msg.delivery_msg) : null,
      messageEn: msg ? en(msg.delivery_msg) : null,
      cause: evs[0]?.cause || null,
    };
  }
  return { source: "JR東海 在来線運行情報", fetchedAt: new Date().toISOString(), positionTime: jst(pos.create_time), line, trains };
}

async function getStatus(ctx) {
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const key = new Request("https://cache.local/sakashita-status");
  if (cache) {
    const hit = await cache.match(key);
    if (hit) return hit.json();
  }
  const data = await fetchStatus();
  if (cache) {
    const res = new Response(JSON.stringify(data), { headers: { "content-type": "application/json", "cache-control": `max-age=${TTL}` } });
    ctx?.waitUntil ? ctx.waitUntil(cache.put(key, res)) : await cache.put(key, res);
  }
  return data;
}

async function handleRpc(msg, ctx) {
  const { id, method, params } = msg;
  const ok = (result) => ({ jsonrpc: "2.0", id, result });
  const err = (code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });
  switch (method) {
    case "initialize":
      return ok({
        protocolVersion: params?.protocolVersion || "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: "坂下駅（JR中央本線）付近の列車の遅れを get_sakashita_status で取得できます。",
      });
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: [TOOL] });
    case "tools/call":
      if (params?.name !== TOOL.name) return err(-32602, `unknown tool: ${params?.name}`);
      try {
        const data = await getStatus(ctx);
        return ok({ content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data });
      } catch (e) {
        return ok({ isError: true, content: [{ type: "text", text: `運行情報を取得できませんでした: ${e.message}` }] });
      }
    default:
      if (id === undefined) return null;
      return err(-32601, `method not found: ${method}`);
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (url.pathname === "/healthz") return new Response("ok", { headers: CORS });
    if (url.pathname === "/api/status") {
      if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405, headers: { ...CORS, allow: "GET, HEAD" } });
      try {
        return Response.json(await getStatus(ctx), { headers: { ...CORS, "cache-control": "no-store" } });
      } catch (e) {
        return Response.json({ error: `運行情報を取得できませんでした: ${e.message}` }, { status: 502, headers: { ...CORS, "cache-control": "no-store" } });
      }
    }
    if (url.pathname !== "/mcp") return new Response("Not found", { status: 404, headers: CORS });
    if (request.method !== "POST") return new Response(null, { status: 405, headers: { ...CORS, allow: "POST" } });
    let msg;
    try { msg = await request.json(); }
    catch { return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }, { status: 400, headers: CORS }); }
    const out = Array.isArray(msg) ? (await Promise.all(msg.map((m) => handleRpc(m, ctx)))).filter(Boolean) : await handleRpc(msg, ctx);
    if (!out || (Array.isArray(out) && !out.length)) return new Response(null, { status: 202, headers: CORS });
    return Response.json(out, { headers: CORS });
  },
};
