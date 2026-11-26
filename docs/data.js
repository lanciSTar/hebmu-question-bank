// 从学校接口拉题库，转换成刷题页需要的结构
// 依赖：扩展的 host_permissions 允许跨域访问 webvpn

// 接口根路径。
//   - 扩展页（chrome-extension://）里不能用 location 推导，必须用固定的 WebVPN 代理地址
//   - App（WebView）启动时会注入 window.__ANDROID_BASE__，优先用它
// 接口地址（异步）：window 里没有就去 storage 找，最后才用写死的兜底。
// WebVPN 的路径 token 每次登录都会变，写死只是保底。
var __hbBasePromise = null;
function resolveSchoolBaseAsync() {
  try {
    if (window.__ANDROID_BASE__) return Promise.resolve(String(window.__ANDROID_BASE__).replace(/\/+$/, ''));
  } catch (e) {}
  if (!__hbBasePromise) {
    try {
      __hbBasePromise = chrome.storage.local.get(['hbmu_base']).then(function (s) {
        if (s && s.hbmu_base) return String(s.hbmu_base).replace(/\/+$/, '');
        return 'https://webvpn.hebmu.edu.cn/https/77726476706e69737468656265737421fae042882c7e60557c059ce29d51367b4d39/smuexam/studentEnd';
      }).catch(function () { return 'https://webvpn.hebmu.edu.cn/https/77726476706e69737468656265737421fae042882c7e60557c059ce29d51367b4d39/smuexam/studentEnd'; });
    } catch (e) {
      __hbBasePromise = Promise.resolve('https://webvpn.hebmu.edu.cn/https/77726476706e69737468656265737421fae042882c7e60557c059ce29d51367b4d39/smuexam/studentEnd');
    }
  }
  return __hbBasePromise;
}

// 同步版：只在已经知道地址时可用
function resolveSchoolBase() {
  try {
    if (window.__ANDROID_BASE__) return String(window.__ANDROID_BASE__).replace(/\/+$/, '');
  } catch (e) {}
  return 'https://webvpn.hebmu.edu.cn/https/77726476706e69737468656265737421fae042882c7e60557c059ce29d51367b4d39/smuexam/studentEnd';
}
const SCHOOL_BASE = ''; // 保留占位，实际请求统一走 resolveSchoolBase()


const QTYPE = {
  '151': ['A1型题', '0'], '152': ['A2型题', '0'], '153': ['A3型题', '0'], '154': ['A4型题', '0'],
  '155': ['B1型题', '0'], '156': ['C型题', '0'], '157': ['K型题', '0'], '158': ['X型题', '1'],
  '160': ['判断题', '0'], '161': ['填空题', '6'], '162': ['名词解释题', '6'], '163': ['中英互译', '6'],
  '164': ['填图题', '6'], '165': ['简答题', '6'], '166': ['论述题', '6'], '167': ['病例分析题', '6'],
  '168': ['综合题', '6'], '1003': ['视频题', '6'], '1004': ['读图题', '6'],
};
const TYPE_ORDER = ['A1型题', 'A2型题', 'A3型题', 'A4型题', 'B1型题', 'C型题', 'K型题', 'X型题',
  '判断题', '填空题', '名词解释题', '简答题', '论述题', '病例分析题', '综合题',
  '中英互译', '填图题', '读图题', '视频题'];

function clean(html) {
  if (!html) return '';
  let s = String(html);
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<img[^>]*>/gi, '');
  s = s.replace(/<\/p>\s*<p[^>]*>/gi, '\n');
  s = s.replace(/<[^>]+>/g, '');
  const el = document.createElement('textarea');
  el.innerHTML = s;
  s = el.value;
  s = s.replace(/\u00a0/g, ' ').replace(/\u3000/g, ' ');
  s = s.replace(/[ \t]+/g, ' ');
  s = s.replace(/\n\s*\n+/g, '\n');
  return s.trim();
}

function splitOptions(text) {
  let t = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  t = t.replace(/[ \t]*([A-E])[.、．][ \t]*/g, (m, k) => '\n' + k + '. ');
  const parts = t.split('\n').map(x => x.trim()).filter(Boolean);
  const opts = [];
  const stem = [];
  for (const p of parts) {
    const m = p.match(/^([A-E])[.、．]\s*(.+)$/);
    if (m && m[2].trim()) opts.push(m[1] + '. ' + m[2].trim());
    else stem.push(p);
  }
  if (opts.length >= 3) {
    let list = opts;
    if (list.length > 5) {
      const seen = {};
      for (const o of list) if (!seen[o[0]]) seen[o[0]] = o;
      list = Object.keys(seen).sort().map(k => seen[k]);
    }
    return [stem.join('\n'), list];
  }
  return [text, []];
}

function optionsFromAnswer(row) {
  const arr = row.answer || [];
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    const txt = arr[i].CONTENT;
    if (!txt || String(txt).trim().length <= 1) return [];
    out.push(String.fromCharCode(65 + i) + '. ' + String(txt).trim());
  }
  return out.length >= 2 ? out : [];
}

function convert(cid, name, rows) {
  const qs = [];
  let n = 0;
  for (const row of rows) {
    const qtype = QTYPE[String(row.qtid)] || ['简答题', '6'];
    const tname = qtype[0], atid = qtype[1];
    const stem = clean(row.content);
    const branch = row.branch || [];
    const chapter = row.__chapter || '未分类';

    if (String(row.ismain) === '1' && branch.length) {
      for (const b of branch) {
        n += 1;
        const q = clean(b.content);
        const a = clean(b.rightAns);
        let body = stem ? (stem + '\n' + q).trim() : q;
        let opts = [];
        if (atid === '0' || atid === '1') {
          const r = splitOptions(body);
          body = r[0]; opts = r[1];
          if (!opts.length) opts = optionsFromAnswer(b);
        }
        qs.push({ id: cid + '-q' + n, ch: chapter, t: tname, atid, q: body, a, o: opts });
      }
    } else {
      n += 1;
      let a = clean(row.rightAns);
      if (!a && row.answer) {
        for (const av of row.answer) if (av.CONTENT_6) { a = clean(av.CONTENT_6); break; }
      }
      let body = stem, opts = [];
      if (atid === '0' || atid === '1') {
        const r = splitOptions(stem);
        body = r[0]; opts = r[1];
        if (!opts.length) opts = optionsFromAnswer(row);
      }
      qs.push({ id: cid + '-q' + n, ch: chapter, t: tname, atid, q: body, a, o: opts });
    }
  }

  const order = [];
  for (const q of qs) if (!order.includes(q.ch)) order.push(q.ch);
  const chapters = order.map(ch => ({ name: ch, n: qs.filter(q => q.ch === ch).length }));
  const groups = {};
  for (const q of qs) groups[q.t] = (groups[q.t] || 0) + 1;
  const sortedGroups = {};
  Object.keys(groups).sort((a, b) => {
    const ia = TYPE_ORDER.indexOf(a), ib = TYPE_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  }).forEach(k => { sortedGroups[k] = groups[k]; });

  return { id: cid, name, chapters, groups: sortedGroups, questions: qs };
}

async function api(path, body) {
  const __base = await resolveSchoolBaseAsync();
  const r = await fetch(__base + path, {
    method: body ? 'POST' : 'GET',
    credentials: 'include',
    headers: body ? {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
    } : undefined,
    body,
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r;
}

async function fetchCourseName(cid) {
  try {
    const r = await api('/QuestionList?c_id=' + cid);
    const html = await r.text();
    const m = html.match(/《([^》]{1,40})》/);
    return m ? m[1].trim() : String(cid);
  } catch (e) {
    return String(cid);
  }
}

async function pullRange(cid, th1id, onProgress) {
  const seen = new Set();
  const out = [];
  let total = 0;

  const ROWS = 10;          // 实测：10 条/页零失败；>=48 必 500
  const CONC = 8;           // 实测：并发 8 不触发限流
  const MAX_PAGES = 2000;   // 兜底上限

  // 记录失败的页码，全部扫完后再回头重试
  const failedPages = new Set();

  // 拿一页；失败重试 2 次
  async function fetchPage(pageNo, extra) {
    const body = 'cid=' + cid + '&th1id=' + th1id + '&th2id=&qtid=' + (extra || '') +
                 '&page=' + pageNo + '&rows=' + ROWS;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const r = await api('/queryquestionList', body);
        const j = JSON.parse(await r.text());
        if (j && j.rows) return j;
      } catch (e) {
        // 忽略，重试
      }
      await new Promise(x => setTimeout(x, 250));
    }
    return null;
  }

  async function oneRound(extra) {
    let pageNo = 1;
    let emptyStreak = 0;
    let failStreak = 0;
    let added = 0;

    while (pageNo <= MAX_PAGES) {
      // 并发抓一批
      const pages = [];
      for (let k = 0; k < CONC && pageNo + k <= MAX_PAGES; k++) pages.push(pageNo + k);
      const results = await Promise.all(pages.map(p => fetchPage(p, extra)));

      let addedInBatch = 0;

      for (let i = 0; i < results.length; i++) {
        const j = results[i];
        if (!j) {
          failStreak++;
          failedPages.add(pages[i]);   // 记下来，最后统一重试
          continue;
        }
        failedPages.delete(pages[i]);
        failStreak = 0;
        total = j.total || total;
        const rows = j.rows || [];
        for (const row of rows) {
          if (row && row.qid && !seen.has(row.qid)) {
            seen.add(row.qid);
            out.push(row);
            added++;
            addedInBatch++;
          }
        }
      }

      if (onProgress) onProgress(out.length, total);

      // 关键：用「新增题数」判断，重复页不算有效数据，否则会一直翻到上限
      if (addedInBatch > 0) {
        emptyStreak = 0;
      } else {
        emptyStreak += results.length;
      }

      if (emptyStreak >= CONC * 2) break;          // 连续两批没新题 → 到底
      if (failStreak >= CONC * 3) break;           // 连续失败太多
      if (total > 0 && out.length >= total) break; // 拿够了
      if (pageNo > 400) break;                     // 兜底

      pageNo += results.length;
      await new Promise(x => setTimeout(x, 120));
    }

    return { added, exhausted: total > 0 && out.length >= total };
  }

  // 回头重试失败的页：隔一会儿再来，服务端可能已经缓过来了
  async function retryFailed(extra) {
    if (!failedPages.size) return;
    for (let round = 0; round < 4 && failedPages.size; round++) {
      await new Promise(x => setTimeout(x, 1500));
      const remain = Array.from(failedPages);
      const results = await Promise.all(remain.map(p => fetchPage(p, extra)));
      for (let i = 0; i < results.length; i++) {
        const j = results[i];
        if (!j) continue;
        failedPages.delete(remain[i]);
        total = j.total || total;
        const rows = j.rows || [];
        for (const row of rows) {
          if (row && row.qid && !seen.has(row.qid)) {
            seen.add(row.qid);
            out.push(row);
          }
        }
      }
      if (onProgress) onProgress(out.length, total);
    }
  }

  await oneRound('');
  // await retryFailed('');  // 实测那几页是永久 500，重试无意义，已停用

  // 没抓满：补一轮
  if (total > 0 && out.length < total) {
    await new Promise(x => setTimeout(x, 400));
    await oneRound('');
  }

  // 还差：按题型细分补（只补差额，成本可控）
  if (total > 0 && out.length < total) {
    const QT = ['151', '152', '153', '154', '155', '156', '157', '158', '160',
                '161', '162', '165', '166', '167', '168', '1003', '1004'];
    for (let pass = 0; pass < 2; pass++) {
      if (out.length >= total) break;
      for (const qt of QT) {
        if (out.length >= total) break;
        await oneRound(qt);
      }
    }
  }

  return { rows: out, total };
}

async function loadCourse(cid, themes, onProgress) {
  const name = await fetchCourseName(cid);
  const all = [];
  const seen = new Set();
  const list = (themes && themes.length) ? themes : [{ id: '', name: '未分类' }];

  for (let i = 0; i < list.length; i++) {
    const t = list[i];
    const r = await pullRange(cid, t.id, (got, total) => {
      if (onProgress) onProgress({ stage: 'chapters', index: i + 1, total: list.length, got, inChapter: total, chapter: t.name, collected: all.length });
    });
    let added = 0;
    for (const row of r.rows) {
      if (!seen.has(row.qid)) {
        seen.add(row.qid);
        row.__chapter = t.name;
        all.push(row);
        added++;
      }
    }
    if (onProgress) onProgress({ stage: 'chapters', index: i + 1, total: list.length, chapter: t.name, added, collected: all.length });
  }

  // 补一遍全量，兜住没有主题词的题
  if (onProgress) onProgress({ stage: 'rest', index: list.length, total: list.length, collected: all.length });

  // 先探一下全量有多少题：章节已经基本覆盖就跳过补齐（能省一大半时间）
  let grandTotal = 0;
  try {
    const pr = await api('/queryquestionList', 'cid=' + cid + '&th1id=&th2id=&qtid=&page=1&rows=1');
    const pj = JSON.parse(await pr.text());
    grandTotal = (pj && pj.total) || 0;
  } catch (e) {}

  const needRest = grandTotal > 0 ? (all.length < grandTotal * 0.97) : true;

  if (needRest) {
    const rest = await pullRange(cid, '', (got, total) => {
      if (onProgress) onProgress({ stage: 'rest', index: list.length, total: list.length, got, inChapter: total, collected: all.length });
    });
    for (const row of rest.rows) {
      if (!seen.has(row.qid)) { seen.add(row.qid); row.__chapter = '未分类'; all.push(row); }
    }
  }

  const course = convert(cid, name, all);
  course.__diag = {
    rawRows: all.length,
    uniqueQid: seen.size,
    questions: course.questions.length,
    grand: grandTotal || 0,
  };
  return course;
}

window.HBMU = { loadCourse, fetchCourseName, convert, clean, splitOptions };

// 从学校页面解析主题词（扩展页里没有那个下拉，只能抓 HTML）
async function fetchThemes(cid) {
  try {
    const r = await api('/QuestionList?c_id=' + cid);
    const html = await r.text();
    const nameM = html.match(/《([^》]{1,40})》/);
    const name = nameM ? nameM[1].trim() : String(cid);
    // 用 DOMParser 解析，比正则可靠：
    //   - 不受属性顺序/引号/选中状态影响
    //   - option 里嵌了标签也能取到文字
    var themes = [];
    try {
      var doc = new DOMParser().parseFromString(html, 'text/html');
      var sel = doc.querySelector('#theme1List') || doc.querySelector('select[id*=theme1]');
      if (sel) {
        for (var i = 0; i < sel.options.length; i++) {
          var op = sel.options[i];
          var val = (op.value || '').trim();
          var txt = (op.textContent || '').trim();
          if (val && txt) themes.push({ id: val, name: txt });
        }
      }
    } catch (e) {}

    return { name, themes };
  } catch (e) {
    return { name: String(cid), themes: [] };
  }
}

window.HBMU.fetchThemes = fetchThemes;

// 扫描全部课程：遍历 c_id，抓《课程名》。结果缓存到 chrome.storage
async function scanCourses(onProgress) {
  const ids = [];
  for (let i = 100; i <= 860; i++) ids.push(i);

  const found = [];
  let cursor = 0;
  const CONC = 8;

  async function worker() {
    while (cursor < ids.length) {
      const cid = ids[cursor++];
      try {
        const __b = await resolveSchoolBaseAsync();
        const r = await fetch(__b + '/QuestionList?c_id=' + cid, { credentials: 'include' });
        const html = await r.text();
        const m = html.match(/《([^》]{1,40})》/);
        if (m && m[1].trim()) found.push({ id: String(cid), name: m[1].trim() });
      } catch (e) { /* 忽略单个失败 */ }
      if (onProgress) onProgress(found.length, cursor, ids.length);
    }
  }

  await Promise.all(Array.from({ length: CONC }, () => worker()));
  found.sort((a, b) => Number(a.id) - Number(b.id));
  return found;
}

window.HBMU.scanCourses = scanCourses;
