import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { publicOrigin as pub, catalogOrigin as cat, password, sessionKey, bearer, state } from './integration-server.mjs';

/** Actual HTTP proof against the two retained workerd sockets, with native R2 data/failures.
 * Credentials here are disposable fixture values. No .env, Cloudflare account or live URL is read.
 */
const checks=[];
const check=(name,details={})=>{checks.push({name,...details});console.log(`PASS ${name}`);};
const privateHeaders=r=>{
  assert.equal(r.headers.get('cache-control'),'no-store');
  assert.match(r.headers.get('x-robots-tag'),/noindex/);
  assert.match(r.headers.get('content-security-policy'),/frame-ancestors 'none'/);
  assert.equal(r.headers.get('access-control-allow-origin'),null);
};
let cookie='',csrf='';
const request=(path,options={})=>fetch(cat+path,{...options,headers:{'X-Docs-Catalog':'1',Origin:cat,Cookie:cookie,...options.headers}});
const deleteBatch=items=>request('/all-docs/api/delete',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify({version:1,items,confirmCount:items.length,confirmation:`DELETE ${items.length} documents`})});
const login=async value=>request('/all-docs/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:value})});
const scan=async()=>{let cursor=null,pages=0,items=[];do{const r=await request('/all-docs/api/documents'+(cursor?'?cursor='+encodeURIComponent(cursor):''));assert.equal(r.status,200);privateHeaders(r);const body=await r.json();items.push(...body.items);cursor=body.nextCursor;pages++;assert(pages<20);}while(cursor);return{items,pages};};
try {
  for(const path of ['/all-docs','/all-docs/api/documents','/no-such','/upload','/PlainHt1/raw','/%2e%2e/PlainHt1','/all-docs/assets/no.js']) {
    const r=await fetch(cat+path);privateHeaders(r);assert(!((await r.text()).includes('window.authored=true')));
  }
  const redirect=await fetch(pub+'/all-docs',{redirect:'manual'});assert.equal(redirect.status,302);assert.equal(redirect.headers.get('location'),cat+'/all-docs');
  check('private headers, public redirect and no catalog raw/upload/public fallback');
  let r=await login('wrong-password');assert.equal(r.status,401);privateHeaders(r);
  r=await login(password);assert.equal(r.status,200);privateHeaders(r);cookie=r.headers.get('set-cookie').split(';')[0];csrf=(await r.json()).csrfToken;
  for(const value of ['Secure','HttpOnly','SameSite=Strict','Path=/']) assert(r.headers.get('set-cookie').includes(value));
  assert.equal((await request('/all-docs/session')).status,200);
  check('wrong/right password, signed secure host-only session and reload bootstrap');
  for(const headers of [{Origin:pub},{'X-Docs-Catalog':''},{Origin:cat,'Sec-Fetch-Site':'cross-site'}]){r=await request('/all-docs/api/documents',{headers});assert.equal(r.status,403);privateHeaders(r);}
  r=await request('/all-docs/api/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});assert.equal(r.status,403);
  r=await fetch(cat+'/all-docs/api/documents',{method:'OPTIONS',headers:{Origin:pub,'Access-Control-Request-Headers':'x-docs-catalog'}});assert.equal(r.status,404);privateHeaders(r);
  check('cross-origin/custom-header/Fetch-Metadata/preflight and missing-CSRF refusal');
  // Sign a correctly authenticated but expired local fixture token; this tests expiry rather than
  // merely changing an unsigned payload. No production signer/key is involved.
  const now=Math.floor(Date.now()/1000);
  const key=createHmac('sha256',sessionKey).update(JSON.stringify(['docs-catalog-key-v1',cat,password])).digest();
  const sign=state=>{const payload=Buffer.from(JSON.stringify(state)).toString('base64url');return payload+'.'+createHmac('sha256',key).update('session-v1\n'+payload).digest('base64url');};
  const active={v:1,sid:'A'.repeat(43),csrf:'B'.repeat(43),iat:now,exp:now+43200};
  assert.equal((await request('/all-docs/session',{headers:{Cookie:'__Host-docs_catalog='+sign(active)}})).status,200);
  const expired=sign({...active,iat:now-43201,exp:now-1});
  assert.equal((await request('/all-docs/session',{headers:{Cookie:'__Host-docs_catalog='+expired}})).status,401);
  check('correctly signed expired session is refused');
  const {items,pages}=await scan();assert(pages>1);assert.equal(new Set(items.map(i=>i.id)).size,items.length);assert(items.length>300);
  assert(items.every(i=>i.timeSource==='r2'&&i.createdAt===null));assert(!JSON.stringify(items).includes('__docs_internal'));
  assert.equal(items.find(i=>i.id==='Group001').objectCount,2);
  assert(Date.parse(items.find(i=>i.id==='Scan0000').uploadedAt)<Date.now()-90*86400000);
  const text=async id=>{const doc=items.find(i=>i.id===id);const r=await request(`/all-docs/api/documents/${id}/text?version=${doc.version}`);assert.equal(r.status,200);privateHeaders(r);return r.json();};
  assert.equal((await text('Legacy01')).text,'LegacyBodySentinel');
  assert.equal((await text('TextHi01')).coverage,'full');
  assert.equal((await text('Group001')).coverage,'truncated');
  assert.equal((await text('PdfText1')).coverage,'metadata-only');
  assert.equal((await text('TruncTxt')).indexedBytes,512*1024);
  const docx=await text('DocxOk01');assert.equal(docx.text,'DocxBodySentinel & 😀');assert.equal(docx.coverage,'truncated');assert.match(docx.reason,/main-document/);
  for(const id of ['DocxBad1','DocxBomb']) {const record=await text(id);assert.equal(record.coverage,'error');assert.equal(record.text,'');}
  check('global pagination, native old dates, legacy/group metadata, coverage and bounded DOCX body extraction',{pages,documents:items.length});
  for(const [id,needle] of [['DocxOk01','DocxBodySentinel'],['DocxBad1','download-card'],['DocxBomb','expanded XML'],['PdfText1','<iframe'],['PngImg01','<img'],['WaveAud1','<audio'],['WebmVid1','<video'],['JsonDat1','9007199254740993'],['CsvData1','first\nsecond'],['TsvData1','alpha'],['Unknown1','download-card'],['Office01','download-card'],['Archive1','download-card']]) {
    r=await fetch(pub+'/'+id);assert.equal(r.status,200);assert((await r.text()).includes(needle),id);
  }
  r=await fetch(pub+'/SafeMark');const md=await r.text();assert(md.includes('<strong>Strong</strong>'));assert(!md.includes('<script>window.markdownPwn'));
  check('actual public format routes: DOCX, native PDF/image/media, data, safe Markdown and honest fallbacks');
  const original=await (await fetch(pub+'/PlainHt1/raw')).arrayBuffer();assert.deepEqual(await (await fetch(pub+'/PlainHt1/download')).arrayBuffer(),original);
  r=await fetch(pub+'/WaveAud1/raw');const etag=r.headers.get('etag'),bytes=new Uint8Array(await r.arrayBuffer());
  r=await fetch(pub+'/WaveAud1/raw',{headers:{Range:'bytes=4-15','If-Range':etag}});assert.equal(r.status,206);assert.deepEqual(new Uint8Array(await r.arrayBuffer()),bytes.slice(4,16));
  assert.equal((await fetch(pub+'/WaveAud1/raw',{headers:{'If-None-Match':etag}})).status,304);
  assert.equal((await fetch(pub+'/ZeroByte/raw',{headers:{Range:'bytes=0-'}})).status,416);
  check('byte-exact raw/download, actual native R2 range/If-Range/304 and zero-byte 416');
  const uploadBytes=Buffer.from('<!doctype html><title>Native upload</title><p>UploadedBodySentinel</p>');
  r=await fetch(pub+'/upload',{method:'PUT',headers:{Authorization:`Bearer ${bearer}`,'X-Filename':'native.html','Content-Type':'text/html','Content-Length':String(uploadBytes.length)},body:uploadBytes});assert.equal(r.status,200);const uploaded=await r.json();
  assert.equal(await (await fetch(pub+'/'+uploaded.id+'/raw')).text(),uploadBytes.toString());
  r=await fetch(pub+'/upload/'+uploaded.id,{method:'DELETE',headers:{Authorization:`Bearer ${bearer}`}});assert.equal(r.status,204);assert.equal(r.headers.get('x-docs-delete-result'),'deleted');
  assert.equal((await fetch(pub+'/'+uploaded.id+'/raw',{headers:{'If-None-Match':'*'}})).status,404);
  check('real known-length bearer upload, byte fidelity, marked deletion and cached/deleted 404');
  const stale=items.find(i=>i.id==='StaleDel'),fail=items.find(i=>i.id==='FailDel1');
  const info=JSON.parse(await readFile(resolve(state,'server.json'),'utf8'));process.kill(info.pid,'SIGUSR1');
  for(let attempt=0;attempt<30;attempt++){const latest=await scan();if(latest.items.find(i=>i.id===stale.id).version!==stale.version)break;await new Promise(r=>setTimeout(r,50));if(attempt===29)throw new Error('stale fixture replacement timed out');}
  r=await deleteBatch([{id:stale.id,version:stale.version},{id:fail.id,version:fail.version},{id:'Absent01',version:'a'.repeat(64)}]);assert.equal(r.status,200);
  assert.deepEqual((await r.json()).outcomes.map(o=>o.status),['changed','failed','not-found']);
  assert.equal((await fetch(pub+'/StaleDel/raw')).status,200);assert.equal((await fetch(pub+'/FailDel1/raw')).status,200);
  r=await deleteBatch(Array.from({length:101},(_,i)=>({id:`Del${String(i).padStart(5,'0')}`,version:'a'.repeat(64)})));assert.equal(r.status,400);
  check('frozen stale version, actual native R2 per-ID failure, missing outcome, retained docs and 100-ID server cap');
  r=await request('/all-docs/session',{method:'DELETE',headers:{'X-CSRF-Token':csrf}});assert.equal(r.status,204);assert.match(r.headers.get('set-cookie'),/Max-Age=0/);
  cookie='';assert.equal((await request('/all-docs/session')).status,401);
  check('logout clears cookie and anonymous bootstrap fails');
} finally {
  await writeFile(resolve(state,'http-results.json'),JSON.stringify({checks,limitations:'Local workerd/R2 only; no deployed-tier CPU, device, production or OCR proof.'},null,2));
}
