// 诊断 v2：超高 PNG 的 asset 服务与三种解码路径
const cf = window.__TAURI_INTERNALS__.convertFileSrc;
const p = "D:/code/zcoder/et/testdata/t13_tall_20000px.png";
const url = cf(p) + "?v=" + Math.random();

const out = [];
const r = await fetch(url);
out.push(`fetch: HTTP ${r.status} ${(await r.blob()).size}B`);

if (r.ok) {
  const blob = await (await fetch(url)).blob();
  try {
    const bmp = await createImageBitmap(blob);
    out.push(`createImageBitmap: OK ${bmp.width}x${bmp.height}`);
    bmp.close();
  } catch (e) {
    out.push(`createImageBitmap: FAIL ${String(e).slice(0, 90)}`);
  }
  const img = new Image();
  img.src = url;
  try {
    await img.decode();
    out.push(`img 元素: OK ${img.naturalWidth}x${img.naturalHeight}`);
  } catch (e) {
    out.push(`img 元素: FAIL ${String(e).slice(0, 90)}`);
  }
}
return out.join("\n");
