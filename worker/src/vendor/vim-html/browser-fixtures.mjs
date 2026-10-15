/** Disposable loopback fixtures for physical-key browser acceptance of the real
 * enhanceHtml seam. No owner documents, storage bindings or production secrets.
 */
import { createServer } from "node:http";
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const output = await build({ entryPoints: [root + "vim.ts"], bundle: true, write: false, platform: "node", format: "esm", target: "es2022" });
const { enhanceHtml } = await import("data:text/javascript;base64," + Buffer.from(output.outputFiles[0].text).toString("base64"));
const plain = `<!doctype html><html><head><meta charset="utf-8"><title>Authored fixture</title>
<style>body{margin:0;background:rgb(248,245,239);color:rgb(24,49,68);font:18px Georgia}main{margin:40px auto;width:620px}h1{font-size:37px}button,input,textarea{font:inherit}body::after{content:"Authored footer"}</style></head><body>
<main><h1>Authored fixture</h1><p>Alpha is the first point.</p><p>Needle is the searchable point.</p><p>Final comment target.</p>
<form><label>Notes <input id="notes"></label><label>Long notes <textarea id="long-notes"></textarea></label><button type="submit">Save notes</button></form>
<p id="result">Nothing submitted.</p><button id="native">Native button</button><p contenteditable="true" id="editable">Editable text.</p></main>
<script>window.authored={boots:1,keys:[],submitted:0,clicks:0};window.addEventListener('keydown',e=>window.authored.keys.push(e.key));document.querySelector('form').addEventListener('submit',e=>{e.preventDefault();window.authored.submitted++;document.querySelector('#result').textContent=document.querySelector('#notes').value});document.querySelector('#native').onclick=()=>window.authored.clicks++;</script></body></html>`;
// stdin/stdout uses the vendored, unchanged build.py --theme none path. Baking
// source/storage identity here tests that the hosting module never replaces it.
const baked = execFileSync("python3", ["-c", "import sys;sys.path.insert(0,sys.argv[1]);import build;print(build.build(sys.stdin.read(),theme='none',source='/synthetic/authored.html',key='baked-fixture')[0])", fileURLToPath(new URL("upstream/scripts", import.meta.url))], { input: plain, encoding: "utf8" });
const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url, "http://localhost").pathname;
    const source = path === "/baked" ? baked : path === "/fragment" ? "<h1>Fragment</h1><p>Alpha</p><p>Needle</p>" : plain;
    let response = new Response(source, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
    if (path !== "/raw") {
      response = await enhanceHtml(response, { id: "Ab12Cd34", title: "Authored fixture", publicUrl: `http://127.0.0.1:${server.address().port}${path}` });
      if (path === "/repeat") response = await enhanceHtml(response, { id: "Other123", title: "Must not replace", publicUrl: "https://wrong.example/Other123" });
    }
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) { res.writeHead(500); res.end(String(error)); }
});
server.listen(Number(process.env.DOCS_VIM_PORT || 0), "127.0.0.1", () => {
  console.log(`Vim fixtures: http://127.0.0.1:${server.address().port}/{plain,repeat,baked,fragment,raw}`);
});
