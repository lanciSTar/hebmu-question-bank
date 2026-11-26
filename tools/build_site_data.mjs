// 把题库文件转成网页版用的静态数据：site/data/<cid>.json + index.json
// 支持两种输入：
//   1) 学校原始课程：{ cid, grand, rows:[...] }
//   2) 自建题库格式：{ format:"hebmu-bank-v1", name, questions:[...] }
import fs from 'node:fs';
import path from 'node:path';

const SITE = '_site_web';
const DATA = path.join(SITE, 'data');
fs.mkdirSync(DATA, { recursive: true });

// 课程清单（编号 -> 名字）
const idxSrc = fs.readFileSync('_ext/course-index.js', 'utf8');
const idxMatch = idxSrc.match(/window\.HBMU_INDEX\s*=\s*(\[[\s\S]*\]);?\s*$/);
const COURSES = idxMatch ? JSON.parse(idxMatch[1]) : [];
const nameOf = (cid) => {
  const hit = COURSES.find(c => String(c.id) === String(cid));
  return hit ? hit.name : '题库 ' + cid;
};

const QTYPE = {
  '151': 'A1型题', '152': 'A2型题', '153': 'A3型题', '154': 'A4型题',
  '155': 'B1型题', '156': 'C型题', '157': 'K型题', '158': 'X型题',
  '160': '判断题', '161': '填空题', '162': '名词解释题', '163': '中英互译',
  '164': '填图题', '165': '简答题', '166': '论述题', '167': '病例分析题',
  '168': '综合题', '1003': '视频题', '1004': '读图题',
};
const MULTI_QTID = new Set(['156', '157', '158']);  // C/K/X 型按多选

function clean(html) {
  if (!html) return '';
  let s = String(html);
  s = s.replace(/<br\s*\/?>/gi, '\n').replace(/<img[^>]*>/gi, '');
  s = s.replace(/<\/p>\s*<p[^>]*>/gi, '\n').replace(/<[^>]+>/g, '');
  s = s.replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  return s.replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
}

function splitOptions(text) {
  let t = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  t = t.replace(/[ \t]*([A-E])[.、．]/g, (m, k) => '\n' + k + '. ');
  const parts = t.split('\n').map(x => x.trim()).filter(Boolean);
  const opts = [];
  const stem = [];
  for (const p of parts) {
    const m = p.match(/^([A-E])[.、．]\s*(.+)$/);
    if (m && m[2].trim()) opts.push(m[1] + '. ' + m[2].trim());
    else stem.push(p);
  }
  return opts.length >= 2 ? [stem.join('\n'), opts] : [String(text || ''), []];
}

// 学校原始行 -> 题目
function fromRow(row) {
  const qtid = String(row.qtid || '');
  const type = QTYPE[qtid] || '简答题';
  let answer = String(row.rightAns || '').trim();
  if (!answer) {
    const a0 = (row.answer || []).find(x => x && x.CONTENT_6);
    if (a0) answer = clean(a0.CONTENT_6);
  }
  const [stem, opts] = splitOptions(clean(row.content));
  const atid = MULTI_QTID.has(qtid) ? '1' : (opts.length ? '0' : '6');
  return {
    id: String(row.cid) + '-' + String(row.qid),
    ch: clean(row.__chapter) || '未分类',
    t: type,
    atid,
    q: stem || clean(row.content),
    a: answer,
    o: opts,
    ex: '',
  };
}

// 自建题库格式 -> 题目
function fromItem(item, cid, i) {
  const opts = Array.isArray(item.options)
    ? item.options.map((o, k) => {
        const s = String(o);
        const m = s.match(/^\s*([A-Za-z])[\.、\)]\s*(.*)$/);
        return m ? (m[1].toUpperCase() + '. ' + m[2].trim()) : (String.fromCharCode(65 + k) + '. ' + s.trim());
      })
    : [];
  const letters = String(item.answer || '').replace(/[^A-Za-z]/g, '');
  const atid = opts.length ? (letters.length > 1 ? '1' : '0') : '6';
  return {
    id: cid + '-q' + (i + 1),
    ch: String(item.chapter || '未分类').trim() || '未分类',
    t: String(item.type || (opts.length ? 'A1型题' : '简答题')),
    atid,
    q: String(item.stem || ''),
    a: Array.isArray(item.answer) ? item.answer.join(' / ') : String(item.answer == null ? '' : item.answer),
    o: opts,
    ex: String(item.explanation || ''),
    ...(Array.isArray(item.answer) && /填空/.test(String(item.type || '')) ? { blank: item.answer.map(String) } : {}),
  };
}

function buildCourse(cid, name, questions) {
  const order = [];
  for (const q of questions) if (!order.includes(q.ch)) order.push(q.ch);
  const chapters = order.map(ch => ({ name: ch, n: questions.filter(q => q.ch === ch).length }));
  const groups = {};
  for (const q of questions) groups[q.t] = (groups[q.t] || 0) + 1;
  return { id: String(cid), name, chapters, groups, questions };
}

const entries = [];

// 1) 原始课程文件
for (const f of fs.readdirSync('_build/courses').filter(x => x.endsWith('.json'))) {
  const raw = JSON.parse(fs.readFileSync(path.join('_build/courses', f), 'utf8'));
  if (!raw.rows) continue;
  const cid = String(raw.cid);
  const qs = raw.rows.map(fromRow).filter(q => q.q);
  const course = buildCourse(cid, nameOf(cid), qs);
  fs.writeFileSync(path.join(DATA, cid + '.json'), JSON.stringify(course), 'utf8');
  entries.push({ id: cid, name: course.name, count: qs.length, size: fs.statSync(path.join(DATA, cid + '.json')).size });
  console.log('原始课程', cid, course.name, qs.length, '题');
}

// 2) 额外的 hebmu-bank-v1 文件（命令行参数传入，形如 path:cid:name）
for (const arg of process.argv.slice(2)) {
  const [file, cid, name] = arg.split('|');
  if (!file) continue;
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const qs = (raw.questions || []).map((it, i) => fromItem(it, cid || 'custom', i)).filter(q => q.q);
  const course = buildCourse(cid || 'custom', name || raw.name || '自建题库', qs);
  fs.writeFileSync(path.join(DATA, course.id + '.json'), JSON.stringify(course), 'utf8');
  entries.push({ id: course.id, name: course.name, count: qs.length, size: fs.statSync(path.join(DATA, course.id + '.json')).size });
  console.log('题库文件', course.id, course.name, qs.length, '题');
}

entries.sort((a, b) => Number(a.id) - Number(b.id) || String(a.id).localeCompare(String(b.id)));
fs.writeFileSync(path.join(DATA, 'index.json'), JSON.stringify(entries, null, 1), 'utf8');
console.log('共生成', entries.length, '门；总大小', (entries.reduce((s, e) => s + e.size, 0) / 1024 / 1024).toFixed(1), 'MB');
