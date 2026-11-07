// CDP 调试辅助：在 PicaView WebView 中执行表达式 / 截图
// 用法: node tools/cdp-eval.mjs eval "表达式"
//       node tools/cdp-eval.mjs shot 输出.png

const PORT = 9223;

async function getPageWs() {
  const list = await (await fetch(`http://localhost:${PORT}/json/list`)).json();
  const page = list.find((t) => t.type === "page");
  if (!page) throw new Error("未找到页面");
  return page.webSocketDebuggerUrl;
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    ws.onopen = () => resolve({
      send(method, params) {
        return new Promise((res, rej) => {
          const mid = ++id;
          pending.set(mid, { res, rej });
          ws.send(JSON.stringify({ id: mid, method, params }));
        });
      },
      close: () => ws.close(),
    });
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
      }
    };
    ws.onerror = reject;
  });
}

const [, , cmd, arg] = process.argv;
const ws = await connect(await getPageWs());

if (cmd === "file") {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(arg, "utf8");
  const r = await ws.send("Runtime.evaluate", {
    expression: `(async () => {\n${src}\n})()`,
    returnByValue: true,
    awaitPromise: true,
  });
  console.log(
    r.exceptionDetails
      ? "EXC: " + JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails, null, 2)
      : String(r.result?.value),
  );
} else if (cmd === "eval") {
  const r = await ws.send("Runtime.evaluate", {
    expression: arg,
    returnByValue: true,
    awaitPromise: true,
  });
  console.log(JSON.stringify(r.result?.value ?? r, null, 2));
} else if (cmd === "shot") {
  const r = await ws.send("Page.captureScreenshot", { format: "png" });
  const { writeFileSync } = await import("node:fs");
  writeFileSync(arg, Buffer.from(r.data, "base64"));
  console.log("saved:", arg);
}
ws.close();
