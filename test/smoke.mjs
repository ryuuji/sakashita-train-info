// ローカルでの簡易テスト（本物の JR東海データを 1 回取得します）: npm test
import worker from "../src/index.js";

const call = async (body) => {
  const res = await worker.fetch(
    new Request("https://example.workers.dev/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    {},
    { waitUntil() {} },
  );
  return { status: res.status, json: res.status === 200 ? await res.json() : null };
};

const init = await call({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
if (init.json?.result?.serverInfo?.name !== "sakashita-train-info") throw new Error("initialize failed");

const list = await call({ jsonrpc: "2.0", id: 2, method: "tools/list" });
if (list.json?.result?.tools?.[0]?.name !== "get_sakashita_status") throw new Error("tools/list failed");

const res = await call({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_sakashita_status", arguments: {} } });
const p = res.json?.result?.structuredContent;
if (!p || !Array.isArray(p.trains)) throw new Error("tools/call failed: " + JSON.stringify(res.json));
const api = await worker.fetch(new Request("https://example.workers.dev/api/status"), {}, { waitUntil() {} });
const a = api.status === 200 ? await api.json() : null;
if (!a || !Array.isArray(a.trains)) throw new Error(`/api/status failed: HTTP ${api.status}`);

console.log(`OK  位置情報 ${p.positionTime} / 中央線 ${p.line.status} / 列車 ${p.trains.length} 本`);
console.log("遅れ:", p.trains.filter((t) => t.delayMin > 0).map((t) => `${t.trainNumber} +${t.delayMin}分`).join(", ") || "なし");
