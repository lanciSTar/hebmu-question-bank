// 抓题库：借用已登录的 Edge（--remote-debugging-port=9222）抓学校题库
// 用法：
//   node _tools/fetch_banks.mjs             # 抓默认名单
//   node _tools/fetch_banks.mjs 160 169     # 只抓指定 cid
// 产物：_banks/<cid>.json（原始行）+ _site_web/data/<cid>.json（网页版课程）
// 说明：脚本本身不含账号密码，完全依赖浏览器里已有的登录态。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(path.resolve('_testdeps') + '/');
const WebSocket = require('ws');

const CDP_PORT = Number(process.env.CDP_PORT || 9222);
const OUT_RAW = path.resolve('_banks');
const OUT_DATA = path.resolve('_site_web/data');
fs.mkdirSync(OUT_RAW, { recursive: true });
fs.mkdirSync(OUT_DATA, { recursive: true });

// 默认名单：考研 5 门 + 执业 8 门（按需改）
const DEFAULT_LIST = [
  [160, '外科学'], [169, '内科学'], [172, '生理学'], [173, '生物化学'], [175, '病理学-旧'],
  [471, '执业资格题库-西医临床综合'], [475, '执业资格题库-西医基础综合'],
  [657, '1-执业医师'], [658, '2-执业医师'], [659, '3-执业助理医师'], [660, '4-执业助理医师'],
  [667, '6-预防医学执业资格'], [668, '7-预防医学执业助理资格'],
];

// 题型
const QTYPE = {
  151: 'A1型题', 152: 'A2型题', 153: 'A3型题', 154: 'A4型题', 155: 'B1型题',
  156: 'C型题', 157: 'K型题', 158: 'X型题', 160: '判断题', 161: '填空题',
  162: '名词解释题', 163: '中英互译', 164: '填图题', 165: '简答题', 166: '论述题',
  167: '病例分析题', 168: '综合题', 1003: '视频题', 1004: '读图题',
};
const MULTI = new Set(['156', '157', '158']);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

class CDP {
  constructor(u) { this.ws = new WebSocket(u); this.id = 0; this.pending = new Map(); }
  open() {
    return new Promise((res, rej) => {
      this.ws.on('open', res);
      this.ws.on('error', rej);
      this.ws.on('message', (b) => {
        const m = JSON.parse(b.toString());
        if (m.id && this.pending.has(m.id)) {
          const p = this.pending.get(m.id); this.pending.delete(m.id);
          m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
        }
      });
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  close() { try { this.ws.close(); } catch (e) {} }
}

async function listTabs() {
  const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
  return await r.json();
}

async function evalIn(cdp, expr) {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'page error');
  return r.result.value;
}

// 在页面里（带登录 cookie）拉一章
const PAGE_PULL = `
async function pullChapter(base, cid, th1id, qtid) {
  const rows = [];
  let total = 0;
  for (let page = 1; page <= 400; page++) {
    const body = new URLSearchParams({ cid: cid, th1id: th1id || '', th2id: '', qtid: qtid || '', page: String(page), rows: '10' });
    const r = await fetch(base + '/queryquestionList', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8', 'x-requested-with': 'XMLHttpRequest' },
      body: body.toString(),
      credentials: 'include',
    });
    if (!r.ok) { await new Promise(z => setTimeout(z, 300)); continue; }
    let j = null;
    try { j = await r.json(); } catch (e) { break; }
    if (page === 1) total = Number(j.total || 0);
    const list = j.rows || [];
    if (!list.length) break;
    for (const x of list) rows.push(x);
    if (total && rows.length >= total) break;
  }
  return { total, rows };
}
`;

function clean(s) {
  if (!s) return '';
  let t = String(s);
  t = t.replace(/<br\s*\/?>/gi, '\n').replace(/<img[^>]*>/gi, '');
  t = t.replace(/<\/p>\s*<p[^>]*>/gi, '\n').replace(/<[^>]+>/g, '');
  t = t.replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  return t.replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
}

function splitOptions(text) {
  let t = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  t = t.replace(/[ \t]*([A-E])[.、．]/g, (m, k) => '\n' + k + '. ');
  const parts = t.split('\n').map(x => x.trim()).filter(Boolean);
  const opts = [], stem = [];
  for (const p of parts) {
    const m = p.match(/^([A-E])[.、．]\s*(.+)$/);
    if (m && m[2].trim()) opts.push(m[1] + '. ' + m[2].trim());
    else stem.push(p);
  }
  return opts.length >= 2 ? [stem.join('\n'), opts] : [String(text || ''), []];
}

function toQuestion(row, cid) {
  const qtid = String(row.qtid || '');
  let answer = String(row.rightAns || '').trim();
  if (!answer) {
    const a0 = (row.answer || []).find(x => x && x.CONTENT_6);
    if (a0) answer = clean(a0.CONTENT_6);
  }
  const [stem, opts] = splitOptions(clean(row.content));
  return {
    id: String(cid) + '-' + String(row.qid),
    ch: clean(row.__chapter) || '未分类',
    t: QTYPE[qtid] || '简答题',
    atid: MULTI.has(qtid) ? '1' : (opts.length ? '0' : '6'),
    q: stem || clean(row.content),
    a: answer,
    o: opts,
    ex: '',
  };
}

function buildCourse(cid, name, qs) {
  const order = [];
  for (const q of qs) if (!order.includes(q.ch)) order.push(q.ch);
  const chapters = order.map(ch => ({ name: ch, n: qs.filter(q => q.ch === ch).length }));
  const groups = {};
  for (const q of qs) groups[q.t] = (groups[q.t] || 0) + 1;
  return { id: String(cid), name, chapters, groups, questions: qs };
}

async function main() {
  // 1) 连 CDP
  let tabs;
  try { tabs = await listTabs(); } catch (e) {
    console.error('连不上 ' + CDP_PORT + '，先用调试端口启动浏览器并登录学校系统：');
    console.error('  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" --remote-debugging-port=9222 --user-data-dir="C:\\Users\\肖卓昊\\edge-debug"');
    process.exit(2);
  }
  let tab = tabs.find(t => t.type === 'page' && /smuexam/.test(t.url || ''));
  if (!tab) {
    // 没开题库页：新开一个
    const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent('https://webvpn.hebmu.edu.cn/')}`, { method: 'PUT' });
    tab = await r.json();
    console.log('已新开标签页，请确认已登录学校系统');
    await sleep(3000);
  }
  const cdp = new CDP(tab.webSocketDebuggerUrl);
  await cdp.open();
  await cdp.send('Runtime.enable');
  await sleep(500);

  const info = await evalIn(cdp, `(function(){
    const p = location.pathname;
    const m = p.match(/^(.*\\/smuexam)/);
    return { base: m ? location.origin + m[1] + '/studentEnd' : '', url: location.href };
  })()`);
  if (!info.base) {
    console.error('当前页面不是题库系统：' + info.url);
    console.error('请在调试浏览器里登录 webvpn.hebmu.edu.cn 并进入题库学生端，然后重跑。');
    process.exit(3);
  }
  console.log('接口根:', info.base);

  // 2) 逐门抓
  const list = process.argv.slice(2).length
    ? process.argv.slice(2).map(x => { const [id, name] = x.split(':'); return [Number(id), name || ('题库 ' + id)]; })
    : DEFAULT_LIST;

  for (const [cid, name] of list) {
    console.log('\n== 抓 ' + cid + ' ' + name);
    // 章节
    const themes = await evalIn(cdp, `(async function(){
      const r = await fetch(${JSON.stringify(info.base)} + '/QuestionList?c_id=${cid}', { credentials: 'include' });
      const html = await r.text();
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const sel = doc.querySelector('#theme1List') || doc.querySelector('select[id*=theme1]');
      const out = [];
      if (sel) for (const o of sel.options) { const v=(o.value||'').trim(); const t=(o.textContent||'').trim(); if(v&&t) out.push({id:v,name:t}); }
      return out;
    })()`);
    console.log('  章节:', themes.length);

    const seen = new Set();
    const qs = [];
    const push = (rows) => {
      for (const row of rows) {
        const qid = String(row.qid || '');
        if (!qid || seen.has(qid)) continue;
        seen.add(qid);
        qs.push(toQuestion(row, cid));
      }
    };

    // 2.1 按章节
    let done = 0;
    for (const th of themes) {
      const res = await evalIn(cdp, `(async function(){ ${PAGE_PULL}; return await pullChapter(${JSON.stringify(info.base)}, '${cid}', ${JSON.stringify(th.id)}, ''); })()`);
      push(res.rows || []);
      done++;
      process.stdout.write('\r  章节 ' + done + '/' + themes.length + ' · 合计 ' + qs.length + ' 题   ');
    }
    console.log('');

    // 2.2 补一轮全量（没有主题词的题）
    const all = await evalIn(cdp, `(async function(){ ${PAGE_PULL}; return await pullChapter(${JSON.stringify(info.base)}, '${cid}', '', ''); })()`);
    push(all.rows || []);
    console.log('  补全后:', qs.length, '题');

    if (!qs.length) { console.log('  没抓到题，跳过'); continue; }

    const course = buildCourse(cid, name, qs);
    fs.writeFileSync(path.join(OUT_DATA, cid + '.json'), JSON.stringify(course), 'utf8');
    fs.writeFileSync(path.join(OUT_RAW, cid + '.json'), JSON.stringify({ cid, grand: all.total || qs.length, rows: qs }, null, 0), 'utf8');
    console.log('  已写入 data/' + cid + '.json（' + qs.length + ' 题，' + course.chapters.length + ' 章）');
  }

  cdp.close();
  console.log('\n全部完成。接着跑: node _tools/build_site_entry.mjs');
}

main().catch(e => { console.error(e); process.exit(1); });
