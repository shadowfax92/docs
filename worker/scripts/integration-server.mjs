import { Miniflare } from 'miniflare';
import { zipSync, strToU8 } from 'fflate';
import { mkdir, readFile, writeFile, readdir, access } from 'node:fs/promises';
import { createServer } from 'node:net';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { seedCachedCorpus } from './persistent-index-fixtures.mjs';

/** Disposable two-origin acceptance environment. All product code runs unchanged in workerd;
 * only the external account is replaced with shared native local D1 and R2 storage.
 * Never bind to non-loopback interfaces or load production .env/credentials here.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const run = process.env.DOCS_LOCAL_RUN || 'persistent-index-local';
if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(run)) throw new Error('DOCS_LOCAL_RUN must be a simple local run name');
if (!run.startsWith('persistent-index-')) throw new Error('Use a unique persistent-index-prefixed DOCS_LOCAL_RUN');
export const state = resolve(root, '.wrangler/integration', run);
const port = (name, fallback) => { const value = process.env[name] ?? String(fallback); if (!/^[0-9]+$/.test(value) || +value < 1024 || +value > 65535) throw new Error('Invalid fixture port'); return +value; };
const publicPort = port('DOCS_PUBLIC_PORT', 18977), catalogPort = port('DOCS_CATALOG_PORT', 18978);
if (publicPort === catalogPort) throw new Error('Fixture roles require distinct ports');
export const publicOrigin = `http://127.0.0.1:${publicPort}`;
export const catalogOrigin = `http://localhost:${catalogPort}`;
export const password = 'disposable-local-library-password';
export const sessionKey = 'disposable-local-session-key-32-bytes-minimum';
export const bearer = 'disposable-local-upload-token';
export const wordXml = text => `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`;

export function runtime() {
  const common = { modules: true, scriptPath: resolve(root, '.wrangler/build/index.js'),
    compatibilityDate: '2024-12-01', r2Buckets: { DOCS_BUCKET: 'local-docs' },
    d1Databases: { LIBRARY_DB: 'persistent-index-local' },
    outboundService: () => { throw new Error('Acceptance Workers may not fetch externally'); } };
  return new Miniflare({ host: '127.0.0.1', port: publicPort, cf: false, r2Persist: resolve(state, 'r2'),
    d1Persist: resolve(state, 'd1'),
    cachePersist: false, workers: [
      { ...common, name: 'public', bindings: { APP_ROLE: 'public', PUBLIC_DOCS_ORIGIN: publicOrigin, CATALOG_ORIGIN: catalogOrigin, AUTH_TOKEN: bearer } },
      { ...common, name: 'catalog', unsafeDirectSockets: [{ host: '127.0.0.1', port: catalogPort }],
        bindings: { APP_ROLE: 'catalog', PUBLIC_DOCS_ORIGIN: publicOrigin, CATALOG_ORIGIN: catalogOrigin, ALL_DOCS_PASSWORD: password, CATALOG_SESSION_KEY: sessionKey } },
    ] });
}

function pdf(text) {
  const objects = [ '<</Type/Catalog/Pages 2 0 R>>', '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 400 300]/Resources<</Font<</F1 4 0 R>>>>/Contents 5 0 R>>',
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>' ];
  const content = `BT /F1 18 Tf 30 240 Td (${text}) Tj ET`;
  objects.push(`<</Length ${content.length}>>\nstream\n${content}\nendstream`);
  let result = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((obj, i) => { offsets.push(result.length); result += `${i + 1} 0 obj\n${obj}\nendobj\n`; });
  const xref = result.length;
  result += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<</Size 6/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
  return result;
}

export async function seed(mf) {
  const bucket = await mf.getR2Bucket('DOCS_BUCKET', 'public');
  const mode = process.env.DOCS_FIXTURE_MODE ?? 'full';
  if (!['full', 'scale', 'operator'].includes(mode)) throw new Error('Invalid DOCS_FIXTURE_MODE');
  if (mode === 'scale') return seedCachedCorpus(mf);
  const fixtures = {};
  const put = async (id, filename, body, title = filename, mime = 'application/octet-stream', legacy = false) => {
    await bucket.put(`${id}/${filename}`, Buffer.isBuffer(body) ? new Uint8Array(body) : body, { customMetadata: legacy ? {} : { filename, contentType: mime, docName: title } });
    fixtures[id] = { filename, title, rawSha256: createHash('sha256').update(Buffer.from(body)).digest('hex') };
  };
  if (mode === 'operator') {
    for (let i = 0; i < 32; i++) await put(`Op${String(i).padStart(6,'0')}`, 'source.txt', `Native bounded backfill ${i} BodySentinel`, `Operator source ${i}`, 'text/plain');
    return fixtures;
  }
  await put('TextHi01', 'rank.txt', 'BodySentinel BodySentinel BodySentinel CaseNeedle literal.a+b', 'High body rank', 'text/plain');
  await put('TextLo01', 'rank.txt', 'BodySentinel caseneedle literalXaab', 'Low body rank', 'text/plain');
  await put('PlainHt1', 'authored.html', `<!doctype html><html><head><title>Authored page</title><style>body{background:rgb(240,230,220);font:18px sans-serif}p{margin:32px}</style></head><body><main><h1>Authored title</h1><p>First searchable paragraph</p><p>Second paragraph</p><form id="authored-form"><input aria-label="Authored input"><button>Submit</button><output></output></form>${Array.from({length:20},(_,i)=>`<p>Paragraph ${i + 3}</p>`).join('')}</main><script>window.authored=true;document.querySelector('form').onsubmit=e=>{e.preventDefault();document.querySelector('output').textContent=document.querySelector('input').value}</script></body></html>`, 'Authored page', 'text/html');
  const baked=execFileSync('python3',['-B','-c',"import sys;sys.path.insert(0,sys.argv[1]);import build;print(build.build(sys.stdin.read(),theme='none',source='/synthetic/original.html',key='integration-baked')[0])",resolve(root,'src/vendor/vim-html/upstream/scripts')],{input:'<!doctype html><title>Baked fixture</title><main><h1>Baked fixture</h1><p>First baked point</p><p>Second baked point</p></main>',encoding:'utf8'});
  await put('BuiltVim','baked.html',baked,'Baked fixture','text/html');
  const attack = `window.attack={};(async()=>{for(const [name,path,method,headers] of [['read','/all-docs/api/documents','GET',{}],['custom','/all-docs/api/documents','GET',{'X-Docs-Catalog':'1'}],['delete','/all-docs/api/delete','POST',{'Content-Type':'application/json','X-Docs-Catalog':'1'}]]){try{let r=await fetch('${catalogOrigin}'+path,{method,credentials:'include',headers,body:method==='POST'?'{}':undefined});window.attack[name]=r.status}catch{window.attack[name]='blocked'}}try{window.attack.opener=window.opener?window.opener.document.body.innerText:'no-opener'}catch{window.attack.opener='blocked'}window.attack.done=true})();`;
  await put('Hostile1', 'attack.html', `<!doctype html><title>Hostile public fixture</title><script>${attack}</script><iframe src="${catalogOrigin}/all-docs"></iframe><form action="${catalogOrigin}/all-docs/api/delete" method="post"><input name="items" value="[]"></form>`, 'Hostile public fixture', 'text/html');
  await put('HostSvg1', 'attack.svg', `<svg xmlns="http://www.w3.org/2000/svg"><script>${attack.replaceAll('&','&amp;').replaceAll('<','&lt;')}</script><text y="25">Hostile SVG fixture</text></svg>`, 'Hostile SVG fixture', 'image/svg+xml');
  await put('DocxOk01', 'report.docx', zipSync({ 'word/document.xml': strToU8(wordXml('DocxBodySentinel &amp; 😀')), 'word/media/ignored.bin': new Uint8Array(2 * 1024 * 1024) }));
  await put('DocxBad1', 'broken.docx', zipSync({ 'word/document.xml': strToU8('<!DOCTYPE x [<!ENTITY x SYSTEM "https://evil.example">]>' + wordXml('&x;')) }));
  const bomb = zipSync({ 'word/document.xml': strToU8(wordXml('x'.repeat(2 * 1024 * 1024))) });
  const view = new DataView(bomb.buffer, bomb.byteOffset, bomb.byteLength); view.setUint32(22,100,true);
  for (let i=0;i+46<=bomb.length;i++) if(view.getUint32(i,true)===0x02014b50) view.setUint32(i+24,100,true);
  await put('DocxBomb', 'bomb.docx', bomb);
  await put('PdfText1', 'text.pdf', pdf('Native PDF readable text fixture'), 'Text PDF', 'application/pdf');
  await put('PngImg01', 'pixel.png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=', 'base64'), 'PNG fixture', 'image/png');
  await put('JsonDat1', 'data.json', '{"precise":9007199254740993,"big":1e400,"z":-0}');
  await put('CsvData1', 'data.csv', 'name,note,amount\n"A, B","first\nsecond",42\n');
  await put('TsvData1', 'data.tsv', 'name\tamount\nalpha\t42\n');
  await put('SafeMark', 'safe.md', '# Safe Markdown\n\n**Strong**\n\n<script>window.markdownPwn=true</script>\n\n[x](javascript:alert(1))');
  await put('Unknown1', 'unknown.weird', new Uint8Array([0,255,1]));
  await put('Office01', 'old.doc', new Uint8Array([0,255,1]));
  await put('Archive1', 'archive.zip', zipSync({ 'file.txt': strToU8('inside archive') }));
  await put('TruncTxt', 'large.txt', 'x'.repeat(600 * 1024));
  await put('ZeroByte', 'empty.txt', '');
  await put('Legacy01', 'legacy.txt', 'LegacyBodySentinel', '', 'text/plain', true);
  await put('Group001', 'a.txt', 'primary body');
  await bucket.put('Group001/b.txt', 'secondary body');
  for (let i=0;i<205;i++) await put(`Scan${String(i).padStart(4,'0')}`, 'page.txt', `page fixture ${i}`, `Pagination fixture ${i}`, 'text/plain');
  for (let i=0;i<103;i++) await put(`Del${String(i).padStart(5,'0')}`, 'delete.txt', `disposable ${i}`, 'Delete cohort', 'text/plain');
  await put('AgeOld01', 'old.txt', 'Boundary older fixture', 'Age boundary older', 'text/plain');
  await put('AgeNew01', 'new.txt', 'Boundary newer fixture', 'Age boundary newer', 'text/plain');
  await put('FailHttp', 'failed.txt', 'Native SQLite failure fixture', 'HTTP failure cohort', 'text/plain');
  await put('FailDel1', 'failed.txt', 'Native SQLite failure fixture', 'Failure cohort', 'text/plain');
  await put('StaleDel', 'stale.txt', 'Original version', 'Stale cohort', 'text/plain');
  // Real media is generated locally; no conversion service or outbound fetch is used.
  execFileSync('ffmpeg', ['-loglevel','error','-y','-f','lavfi','-i','sine=frequency=440:duration=1',resolve(state,'tone.wav')]);
  execFileSync('ffmpeg', ['-loglevel','error','-y','-f','lavfi','-i','color=c=blue:s=160x90:d=1','-c:v','libvpx-vp9',resolve(state,'video.webm')]);
  await put('WaveAud1', 'tone.wav', await readFile(resolve(state,'tone.wav')), 'WAV fixture', 'audio/wav');
  await put('WebmVid1', 'video.webm', await readFile(resolve(state,'video.webm')), 'WebM fixture', 'video/webm');
  await put('BadMedia', 'bad.mp4', 'unsupported codec payload', 'Invalid MP4', 'video/mp4');
  await writeFile(resolve(state,'fixtures.json'), JSON.stringify(fixtures,null,2));
  return fixtures;
}

// Only disposable adapter metadata is edited, while workerd is stopped. Product timestamps and
// failure handling stay real. The trigger supplies an actual R2 storage error for per-ID proof.
async function prepareAdapter() {
  const files = [];
  async function walk(path) { for (const e of await readdir(path,{withFileTypes:true})) { const p=resolve(path,e.name); if(e.isDirectory()) await walk(p); else if(p.endsWith('.sqlite')) files.push(p); } }
  await walk(resolve(state,'r2'));
  execFileSync('python3', ['-c', `import sqlite3,sys,time
for path in sys.argv[1:]:
 c=sqlite3.connect(path)
 if not c.execute("SELECT name FROM sqlite_master WHERE name='_mf_objects'").fetchone(): continue
 c.execute("UPDATE _mf_objects SET uploaded=? WHERE key LIKE 'Scan00%/page.txt'", (int(time.time()*1000)-120*86400000,))
 c.execute("UPDATE _mf_objects SET uploaded=? WHERE key='AgeOld01/old.txt'", (int(time.time()*1000)-90*86400000-86400000,))
 c.execute("UPDATE _mf_objects SET uploaded=? WHERE key='AgeNew01/new.txt'", (int(time.time()*1000)-90*86400000+86400000,))
 c.execute("CREATE TRIGGER IF NOT EXISTS fail_fixture BEFORE DELETE ON _mf_objects WHEN OLD.key IN ('FailDel1/failed.txt','FailHttp/failed.txt') BEGIN SELECT RAISE(ABORT,'disposable native R2 failure'); END")
 c.commit()
`, ...files]);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // Never attach to another campaign's sockets or overwrite an old run. Availability checks
  // close only these short-lived owned listeners; the manifest records the retained process.
  for (const fixturePort of [publicPort, catalogPort]) await new Promise((resolvePort, reject) => {
    const probe = createServer(); probe.once('error', reject);
    probe.listen(fixturePort, '127.0.0.1', () => probe.close(resolvePort));
  });
  if (process.argv.slice(2).some(arg => arg !== '--resume')) throw new Error('Only --resume is supported');
  const resume = process.argv.includes('--resume');
  let previous;
  if (resume) {
    previous = JSON.parse(await readFile(resolve(state, 'server.json'), 'utf8'));
    if (previous.state !== state || previous.publicOrigin !== publicOrigin || previous.catalogOrigin !== catalogOrigin
      || previous.resources !== 'one shared native D1 and one native R2') throw new Error('Resume manifest does not match this fixture');
    if (previous.migrationSha256 !== createHash('sha256').update(await readFile(resolve(root,'migrations/0001_library_index.sql'))).digest('hex')) {
      throw new Error('Resume requires the same committed migration');
    }
    // Never take over a live process, even if it has temporarily released its sockets. Resume
    // is for this harness's stopped disposable run; it preserves the once-seeded scale corpus.
    try { process.kill(previous.pid, 0); throw new Error('Previous fixture process is still alive'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  } else {
    try { await access(resolve(state, 'server.json')); throw new Error('Fixture run already exists; choose a new DOCS_LOCAL_RUN'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  await mkdir(state,{recursive:true});
  let mf;
  if (!resume) {
    mf=runtime();
    try {
      await mf.ready;
      const db = await mf.getD1Database('LIBRARY_DB', 'public');
      const sql = await readFile(resolve(root, 'migrations/0001_library_index.sql'), 'utf8');
      const statements = sql.replace(/^\s*--.*$/gm, '').split(';').map(s => s.trim()).filter(Boolean);
      await db.batch(statements.map(s => db.prepare(s)));
      await seed(mf);
    } finally { await mf.dispose(); }
    await prepareAdapter();
  }
  mf=runtime(); await mf.ready;
  const bundleSha256=createHash('sha256').update(await readFile(resolve(root,'.wrangler/build/index.js'))).digest('hex');
  const sourceCommit=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
  const migrationSha256=createHash('sha256').update(await readFile(resolve(root,'migrations/0001_library_index.sql'))).digest('hex');
  const info={pid:process.pid,publicOrigin,catalogOrigin,state,sourceCommit,bundleSha256,migrationSha256,
    roles:['public','catalog'],resources:'one shared native D1 and one native R2',
    resumed:resume,previous:previous ? {pid:previous.pid,sourceCommit:previous.sourceCommit,bundleSha256:previous.bundleSha256} : null,
    startedAt:new Date().toISOString(),stop:`kill -TERM ${process.pid}`};
  await writeFile(resolve(state,'server.json'),JSON.stringify(info,null,2));
  console.log(JSON.stringify(info));
  // Out-of-band replacement is deliberately confined to one disposable legacy fixture, so an
  // acceptance run can prove a version frozen at review is refused after the object changes.
  process.on('SIGUSR1', async () => {
    const bucket = await mf.getR2Bucket('DOCS_BUCKET','public');
    await bucket.put('StaleDel/stale.txt', `Changed after review ${Date.now()}`, { customMetadata: { filename:'stale.txt', contentType:'text/plain', docName:'Stale cohort' } });
    console.log('Replaced disposable StaleDel after review');
  });
  for (const signal of ['SIGINT','SIGTERM']) process.once(signal,async()=>{await mf.dispose();process.exit(0);});
}
