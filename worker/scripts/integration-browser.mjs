import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { publicOrigin as pub, catalogOrigin as cat, password, state } from './integration-server.mjs';

/** Physical browser interactions against actual built Worker roles/native R2. Headless Chromium
 * has an isolated profile; no owner browser/window/clipboard/storage is attached or activated.
 */
await mkdir(resolve(state,'screenshots'),{recursive:true});
const checks=[];
const check=(name,details={})=>{checks.push({name,...details});console.log(`PASS ${name}`);};
const browser=await chromium.launch({headless:true,channel:'chromium',...(process.env.DOCS_CHROMIUM?{executablePath:process.env.DOCS_CHROMIUM}:{})});
const context=await browser.newContext({viewport:{width:1440,height:1000},permissions:['clipboard-read','clipboard-write']});
const errors=[];
const page=await context.newPage();page.on('pageerror',e=>errors.push(String(e)));
const shot=async(p,name)=>p.screenshot({path:resolve(state,'screenshots',name+'.png'),fullPage:false});
try {
  await page.goto(pub+'/PlainHt1');await page.waitForFunction(()=>window.__VH?.cursor);
  assert.equal(await page.evaluate(()=>window.authored),true);
  assert.equal(await page.evaluate(()=>getComputedStyle(document.body).backgroundColor),'rgb(240, 230, 220)');
  await page.getByLabel('Authored input').pressSequentially('j k search comments');
  await page.getByRole('button',{name:'Submit',exact:true}).click();
  assert.equal(await page.locator('output').textContent(),'j k search comments');
  await page.evaluate(()=>document.activeElement.blur());await page.keyboard.press('Escape');await page.keyboard.type('gg');
  assert.equal(await page.evaluate(()=>window.__VH.cursor.get()),1);
  await page.keyboard.press('j');assert.equal(await page.evaluate(()=>window.__VH.cursor.get()),2);
  await page.keyboard.press('k');assert.equal(await page.evaluate(()=>window.__VH.cursor.get()),1);
  await page.keyboard.press('/');await page.keyboard.type('searchable');await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(()=>window.__VH.cursor.get()),2);
  await page.keyboard.type('gcc');await page.locator('.vh-editor-note').fill('Native integration comment');await page.keyboard.press('Enter');
  await page.waitForFunction(()=>window.__VH.comments.all().length===1);
  await page.keyboard.type('gy');await page.waitForFunction(async()=> (await navigator.clipboard.readText()).includes('Native integration comment'));
  await page.keyboard.type('ggVj');await page.keyboard.press('Enter');await page.locator('.vh-editor-note').fill('Native visual selection');await page.keyboard.press('Enter');
  await page.waitForFunction(()=>window.__VH.comments.all().length===2);
  await shot(page,'public-authored');
  check('authored scripts/forms/style/input, default vim j/k/search, line+visual comments and real clipboard export');
  const bakedRaw=await (await fetch(pub+'/BuiltVim/raw')).text(),bakedPage=await(await fetch(pub+'/BuiltVim')).text();assert.equal(bakedPage,bakedRaw);
  await page.goto(pub+'/BuiltVim');await page.waitForFunction(()=>window.__VH?.cursor);
  assert.equal(await page.evaluate(()=>window.__VH.cfg.source),'/synthetic/original.html');
  await page.keyboard.type('ggj');assert.equal(await page.evaluate(()=>window.__VH.cursor.get()),2);
  assert.equal(await page.locator('#vh-ui').count(),1);
  check('real upstream-built vim HTML stays byte-exact, single runtime and original comment identity');
  await page.goto(pub+'/PngImg01');await page.waitForFunction(()=>document.querySelector('[data-image]')?.naturalWidth===1);
  await page.goto(pub+'/WaveAud1');await page.waitForFunction(()=>document.querySelector('audio')?.readyState>=1);
  assert.equal(await page.locator('audio').evaluate(e=>e.duration),1);
  await page.locator('audio').evaluate(e=>e.play());await page.waitForFunction(()=>document.querySelector('audio').currentTime>0);
  await page.goto(pub+'/WebmVid1');await page.waitForFunction(()=>document.querySelector('video')?.videoWidth===160);
  await page.locator('video').evaluate(e=>e.play());await page.waitForFunction(()=>document.querySelector('video').currentTime>0);
  await shot(page,'public-video');
  await page.goto(pub+'/BadMedia');await page.locator('[data-media-error]').waitFor({state:'visible'});
  check('browser decodes PNG, plays PCM WAV and VP9 WebM; unsupported MP4 displays codec fallback');
  await page.goto(pub+'/PdfText1');assert.equal(await page.locator('iframe').getAttribute('src'),pub+'/PdfText1/raw');await shot(page,'public-pdf');
  await page.goto(pub+'/DocxOk01');assert((await page.locator('main').innerText()).includes('DocxBodySentinel & 😀'));await shot(page,'public-docx-light');
  await page.getByRole('button',{name:'Switch to dark theme'}).click();await shot(page,'public-docx-dark');
  const mobile=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,deviceScaleFactor:1});const mp=await mobile.newPage();
  await mp.goto(pub+'/CsvData1');await shot(mp,'public-csv-mobile');
  assert(await mp.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await mobile.close();
  check('real text-PDF native wrapper, actual DOCX text and public light/dark/mobile screenshots');
  // Authenticate in this browser, then open hostile uploaded markup without even relying on
  // noopener. COOP/cookie host isolation/CORS/frame denial must protect the trusted catalog.
  const trusted=await context.newPage();await trusted.goto(cat+'/all-docs');
  const auth=await trusted.evaluate(async({password})=>{const r=await fetch('/all-docs/session',{method:'POST',headers:{'Content-Type':'application/json','X-Docs-Catalog':'1'},body:JSON.stringify({password})});return r.status;},{password});assert.equal(auth,200);
  const cookies=await context.cookies(pub);assert(!cookies.some(c=>c.name==='__Host-docs_catalog'));
  const popupPromise=context.waitForEvent('page');await trusted.evaluate(url=>window.open(url),pub+'/Hostile1');const hostile=await popupPromise;
  await hostile.waitForFunction(()=>window.attack?.done);
  assert.deepEqual(await hostile.evaluate(()=>window.attack),{read:'blocked',custom:'blocked',delete:'blocked',opener:'no-opener',done:true});
  const frame=hostile.frameLocator('iframe');assert.equal(await frame.locator('body').count(),1);
  assert(!((await frame.locator('body').innerText()).includes('All documents')));
  await page.goto(pub+'/HostSvg1/raw');assert.equal(await page.evaluate(()=>window.attack),undefined);
  check('authenticated browser hostile HTML credentialed reads/mutations and opener/frame attacks blocked; SVG scripts sandboxed');
  await hostile.close();await trusted.close();
  if (!process.argv.includes('--public-only')) await catalogProof(context,shot,check);
  assert.deepEqual(errors,[]);
} finally {
  await writeFile(resolve(state,'browser-results.json'),JSON.stringify({checks,errors,browser:browser.version(),limitations:'Headless local Chromium; other devices/codecs, OCR and deployed Cloudflare CPU/tier remain unverified.'},null,2));
  await browser.close();
}

async function catalogProof() { throw new Error('Catalog acceptance requires the merged UI contract'); }
