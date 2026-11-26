window.__startDrill = function (ARG_BANK) {

(function(){
  "use strict";
  const BANK = ARG_BANK;
  const COURSES = Array.isArray(BANK.courses) && BANK.courses.length
    ? BANK.courses
    : [{ id: 'main', name: '题库', chapters: BANK.chapters || [], groups: BANK.groups || {}, questions: BANK.questions || [] }];
  const BUILD = window.__BUILD__ || 'dev';
  const KEY = 'epi-trainer-v2:' + BUILD;
  const THEMES = [['ink','墨'],['night','夜'],['sea','海']];
  // 刷题顺序：选择题在前，主观题在后
  const TYPE_ORDER = ['A1型题','A2型题','A3型题','A4型题','B1型题','C型题','K型题','X型题',
                      '判断题','填空题','名词解释题','简答题','论述题','病例分析题','综合题',
                      '中英互译','填图题','读图题','视频题'];
  const typeRank = (t) => { const i = TYPE_ORDER.indexOf(t); return i < 0 ? 99 : i; };
  const sortByType = (arr) => arr.slice().sort((a, b) => typeRank(a.t) - typeRank(b.t));

  const $ = (id) => document.getElementById(id);

  function syncFlowBg(){
    if (window.__flow && window.__flow.refresh) window.__flow.refresh();
  }

  const state = {
    courseId: COURSES[0].id,
    chapters: [],         // 空数组 = 全部章节
    types: [],            // 空数组 = 全部题型
    onlyTodo: false,
    random: false,
    mode: 'practice',
    theme: 'ink',
    idx: 0,
    ratings: {},          // qid -> 0|1|2
    answers: {},          // qid -> { picked:[keys], ok:bool }
    attempts: {},         // qid -> { n, ok } 累计作答次数与正确次数
    stars: {},            // qid -> 1 收藏
    starsOnly: false,
    onlyWrong: false,
    listKind: '',
    railCollapsed: false,
    seed: {},             // filterKey -> shuffled ids
    seedKey: '',
    daily: {},            // 'YYYY-MM-DD' -> { n, ok, sec } 学习统计
    failMin: 0,           // 错题里「错了至少几次」的筛选（0=不限）
    maxStreak: 0,         // 错题里「连对少于几次」的筛选（0=不限）
    rangeFrom: 0,         // 题号范围（0 = 不限）
    rangeTo: 0,
    round: { n: 0, ok: 0 } // 本轮（点「开始刷题」之后）的作答统计
  };

  let QS = [];
  let CHAPS = [];
  let GROUPS = {};
  let byCh = {};

  function currentCourse(){
    return COURSES.find(c => c.id === state.courseId) || COURSES[0];
  }

  // 稳定键：只给解析 / 新增题 / 提交用，不替代旧 id
  function hash64(str){
    let h1 = 0x811c9dc5, h2 = 0xc2b2ae35;
    for(let i = 0; i < str.length; i++){
      const c = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
      h2 = Math.imul(h2 ^ c, 0x85ebca6b) >>> 0;
    }
    return ('0000000' + h1.toString(16)).slice(-8) + ('0000000' + h2.toString(16)).slice(-8);
  }

  // 选项统一成 "A. 文本"：老版本导入的题库里存的是 { key, text }
  function optText(o, i){
    if(o == null) return '';
    if(typeof o === 'object'){
      const k = o.key || String.fromCharCode(65 + (i || 0));
      const t = o.text != null ? o.text : (o.value != null ? o.value : '');
      return String(k).toUpperCase() + '. ' + String(t).trim();
    }
    return String(o);
  }

  function qkeyOf(q){
    if(q && q.k) return q.k;
    const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    const src = norm(q && q.q) + '\u0001' +
      (q && q.o ? q.o.map((o, i) => norm(optText(o, i))).join('\u0001') : '') + '\u0001' + norm(q && q.a);
    return 'h:' + hash64(src);
  }

  /* ---------- 老题库的题型纠正 ---------- */
  // 老版本导入的选择题一律存成了「多选」，这里按答案字母数在打开题库时纠正 atid。
  // 只改内存，不动存档；下次打开还会再纠正一次。
  function normalizeQuestion(q){
    if(!q) return q;
    const hasOpts = !!(q.o && q.o.length);
    const letters = String(q.a || '').replace(/[^A-Za-z]/g, '');
    if(hasOpts){
      const multi = letters.length > 1 || /^X型题|^K型题|^C型题/.test(String(q.t || ''));
      q.atid = multi ? '1' : '0';
    }else if(Array.isArray(q.blank) && q.blank.length){
      q.atid = '6';
    }
    return q;
  }

  /* ---------- 解析里的 {{OPT:n}} ---------- */
  // 把解析正文里的占位符换成「字母. 选项文字」
  function optionRefText(q, token){
    if(!q || !q.o || !q.o.length) return '（无选项）';
    const n = q.o.length;
    let di = -1;
    if(/^\d+$/.test(token)) di = parseInt(token, 10) - 1;
    else if(/^[A-Za-z]$/.test(token)) di = token.toUpperCase().charCodeAt(0) - 65;
    if(di < 0 || di >= n) return '（选项 ' + token + '）';
    const text = optText(q.o[di], di).replace(/^\s*[A-Za-z][.、．]\s*/, '');
    return String.fromCharCode(65 + di) + '. ' + text;
  }

  // 安全地把带占位符的文本渲染进元素（不用 innerHTML）
  function renderRichText(el, text, q){
    if(!el) return;
    el.textContent = '';
    const s = String(text || '');
    if(s.indexOf('{{OPT:') < 0){ el.textContent = s; return; }
    const re = /\{\{OPT:([A-Za-z0-9]+)\}\}/g;
    let last = 0, m;
    while((m = re.exec(s))){
      if(m.index > last) el.appendChild(document.createTextNode(s.slice(last, m.index)));
      const span = document.createElement('span');
      span.className = 'ex-opt';
      span.textContent = optionRefText(q, m[1]);
      el.appendChild(span);
      last = re.lastIndex;
    }
    if(last < s.length) el.appendChild(document.createTextNode(s.slice(last)));
  }

  /* ---------- 作答记录（连对 / 本轮） ---------- */
  // ok=true 连对 +1，ok=false 清零；同时累计本轮统计
  function markAttempt(q, ok){
    if(!q) return;
    const at = state.attempts[q.id] || (state.attempts[q.id] = { n: 0, ok: 0, s: 0 });
    at.n = (at.n || 0) + 1;
    if(ok) at.ok = (at.ok || 0) + 1;
    at.s = ok ? (at.s || 0) + 1 : 0;
    if(!state.round) state.round = { n: 0, ok: 0 };
    state.round.n += 1;
    if(ok) state.round.ok += 1;
  }

  function streakOf(q){
    const at = state.attempts && state.attempts[q.id];
    return at ? (at.s || 0) : 0;
  }

  /* ---------- 题目去重 ---------- */
  function duplicateGroups(course){
    const map = new Map();
    const qs = (course && course.questions) || [];
    qs.forEach((q, i) => {
      const k = q.k || qkeyOf(q);
      if(!map.has(k)) map.set(k, []);
      map.get(k).push(i);
    });
    const out = [];
    map.forEach((idxs) => { if(idxs.length > 1) out.push(idxs); });
    return out;
  }

  /* ---------- 按答案形状推断题型 ---------- */
  // 导入的题库常常不写 type，或者题型和答案对不上
  function inferQuestion(item){
    const a = item && item.answer;
    const stem = String((item && (item.stem || item.content)) || '');
    const letters = (s) => /^[A-Za-z](?:\s*[,，、]?\s*[A-Za-z])*$/.test(String(s).trim());
    if(Array.isArray(a)){
      if(stem.indexOf('{{ANS}}') >= 0) return { t: '填空题', atid: '6', blank: a.map(String) };
      if(a.every(x => typeof x === 'string' && !letters(x))) return { t: '填空题', atid: '6', blank: a.map(String) };
      return { t: 'X型题', atid: '1' };
    }
    if(typeof a === 'boolean') return { t: '判断题', atid: '0' };
    if(typeof a === 'number') return { t: 'A1型题', atid: '0' };
    const s = String(a == null ? '' : a).trim();
    if(letters(s) && /[,，、\s]/.test(s)) return { t: 'X型题', atid: '1' };
    if(letters(s)) return { t: 'A1型题', atid: '0' };
    if(stem.indexOf('{{ANS}}') >= 0) return { t: '填空题', atid: '6', blank: [] };
    return { t: '简答题', atid: '6' };
  }

  // 题型 -> atid：多选只有 X/K/C 型；判断题按单选处理
  function atidByType(t){
    if(/^X型题|^K型题|^C型题/.test(t)) return '1';
    if(/简答|论述|名词|填空|综合|病例|中英|填图|读图|视频/.test(t)) return '6';
    return '0';
  }


  // ---------- 本机新增的题 ----------
  const ADDS_KEY = 'hbmu_local_adds';

  function loadAdds(){
    try{
      const raw = localStorage.getItem(ADDS_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr.filter(a => a && a.id && a.courseId) : [];
    }catch(e){ return []; }
  }
  function saveAdds(list){
    try{ localStorage.setItem(ADDS_KEY, JSON.stringify(list)); }catch(e){}
  }
  function addsOf(courseId){ return loadAdds().filter(a => a.courseId === courseId); }

  function rebuildMeta(){
    CHAPS = [];
    const order = [];
    for(const q of QS) if(!order.includes(q.ch)) order.push(q.ch);
    order.forEach(name => CHAPS.push({ name, n: QS.filter(q => q.ch === name).length }));
    GROUPS = {};
    QS.forEach(q => { GROUPS[q.t] = (GROUPS[q.t] || 0) + 1; });
    byCh = {};
    CHAPS.forEach(ch => { byCh[ch.name] = []; });
    QS.forEach(q => { (byCh[q.ch] = byCh[q.ch] || []).push(q); });
  }

  function courseTotal(course){
    if(!course) return 0;
    if(course.id === state.courseId) return QS.length;
    return (course.questions || []).length + addsOf(course.id).length;
  }

  function setCourse(id){
    const c = COURSES.find(x => x.id === id) || COURSES[0];
    state.courseId = c.id;
    QS = (c.questions || []).slice();
    QS.forEach(q => { if(!q.k) q.k = qkeyOf(q); normalizeQuestion(q); });
    // 本机新增的题合并进来；不写回 course.questions，避免重复合并
    for(const a of addsOf(c.id)){
      QS.push({
        id: a.id, k: a.k || qkeyOf(a), ch: a.ch, t: a.t, atid: a.atid,
        q: a.q, a: a.a, o: a.o || [], ex: a.ex || '', __local: 1,
        ...(Array.isArray(a.blank) && a.blank.length ? { blank: a.blank.slice() } : {}),
      });
    }
    rebuildMeta();
    // 筛选项存在 localStorage 里，换课程/换数据后可能对不上，清掉无效项
    if(state.chapters.length){
      const validCh = new Set((c.chapters || []).map(x => x.name));
      const kept = state.chapters.filter(n => validCh.has(n));
      if(kept.length !== state.chapters.length) state.chapters = kept;
    }
    if(state.types.length){
      const kept = state.types.filter(t => GROUPS[t]);
      if(kept.length !== state.types.length) state.types = kept;
    }
    return c;
  }

  // 改完题量 / 章节后重建当前题库的视图
  function refreshCourse(){
    setCourse(state.courseId);
    LIST = currentList();
    if(state.idx > LIST.length - 1) state.idx = Math.max(0, LIST.length - 1);
    renderChrome();
    renderCard(false);
    renderSheet();
    if(document.body.dataset.view === 'setup') renderSetup();
    save();
  }


  function typesList(){ return Object.entries(GROUPS); }

  // 换题库：清掉与旧题库绑定的筛选，保留主题/模式/收藏/自评
  function switchCourse(id){
    setCourse(id);
    state.chapters = [];
    state.types = [];
    state.onlyTodo = false;
    state.starsOnly = false;
    state.idx = 0;
    state.seed = {};
    LIST = currentList();
    renderChrome();
    renderCard(false);
    renderSheet();
    if(document.body.dataset.view === 'setup') renderSetup();
    save();
    emit('course', { action: 'switch', id: state.courseId });

    // 服务器题库：内容按需拉
    const cur = COURSES.find(x => x.id === state.courseId);
    if(cur && cur.__server && (!cur.questions || !cur.questions.length)){
      ensureServerCourse(cur.id).then(ok => {
        if(!ok) return;
        setCourse(cur.id);
        LIST = currentList();
        renderChrome();
        renderCard(false);
        renderSheet();
        if(document.body.dataset.view === 'setup') renderSetup();
      }).catch(() => {});
    }
  }

  /* ---------- 本地存储 ---------- */
  // 清掉其它构建版本留下的记录，避免 localStorage 越积越多
  function dropStaleKeys(){
    try{
      Object.keys(localStorage)
        .filter(k => k.indexOf('epi-trainer-v2') === 0 && k !== KEY)
        .forEach(k => localStorage.removeItem(k));
    }catch(e){}
  }

  function load(){
    try{
      const raw = localStorage.getItem(KEY);
      if(!raw) return;
      const s = JSON.parse(raw);
      if(s && typeof s === 'object'){
        if(s.ratings && typeof s.ratings === 'object') state.ratings = s.ratings;
        if(s.answers && typeof s.answers === 'object') state.answers = s.answers;
        if(s.attempts && typeof s.attempts === 'object') state.attempts = s.attempts;
        if(typeof s.theme === 'string' && THEMES.some(t=>t[0]===s.theme)) state.theme = s.theme;
        if(typeof s.mode === 'string') state.mode = s.mode;
        if(Array.isArray(s.chapters)) state.chapters = s.chapters.filter(c => c === 'all' ? false : true);
        if(Array.isArray(s.types)) state.types = s.types;
        if(typeof s.idx === 'number') state.idx = s.idx;
        if(typeof s.onlyTodo === 'boolean') state.onlyTodo = s.onlyTodo;
        if(typeof s.random === 'boolean') state.random = s.random;
        if(s.stars && typeof s.stars === 'object') state.stars = s.stars;
        if(typeof s.starsOnly === 'boolean') state.starsOnly = s.starsOnly;
        if(typeof s.railCollapsed === 'boolean') state.railCollapsed = s.railCollapsed;
        if(typeof s.onlyWrong === 'boolean') state.onlyWrong = s.onlyWrong;
        if(typeof s.listKind === 'string') state.listKind = s.listKind;
        if(typeof s.courseId === 'string' && COURSES.some(c => c.id === s.courseId)) state.courseId = s.courseId;
        if(s.seed && typeof s.seed === 'object') state.seed = s.seed;
        if(s.daily && typeof s.daily === 'object') state.daily = s.daily;
        if(typeof s.failMin === 'number') state.failMin = s.failMin;
        if(s.maxStreak && typeof s.maxStreak === 'number') state.maxStreak = s.maxStreak;
        if(typeof s.rangeFrom === 'number') state.rangeFrom = s.rangeFrom;
        if(typeof s.rangeTo === 'number') state.rangeTo = s.rangeTo;
      }
    }catch(e){}
  }
  let saveT = 0;
  function save(){
    clearTimeout(saveT);
    saveT = setTimeout(()=>{
      try{
        localStorage.setItem(KEY, JSON.stringify({
          ratings: state.ratings, answers: state.answers, attempts: state.attempts, theme: state.theme, mode: state.mode,
          chapters: state.chapters, idx: state.idx, onlyTodo: state.onlyTodo,
          random: state.random, types: state.types, seed: state.seed, daily: state.daily,
          stars: state.stars, starsOnly: state.starsOnly, courseId: state.courseId,
          railCollapsed: state.railCollapsed, onlyWrong: state.onlyWrong, listKind: state.listKind,
          failMin: state.failMin, maxStreak: state.maxStreak,
          rangeFrom: state.rangeFrom, rangeTo: state.rangeTo
        }));
        // 网页版登录后可以借这个钩子把进度同步到云端
        if(typeof window.__onSaveProgress === 'function'){
          try{ window.__onSaveProgress(); }catch(e){}
        }
      }catch(e){}
    }, 220);
  }

  /* ---------- 数据工具 ---------- */
  function attemptTag(qid){
    const at = state.attempts[qid];
    if(!at || !at.n) return '';
    const pct = Math.round(at.ok / at.n * 100);
    return '<span class="attempt">第 ' + at.n + ' 次作答 · 正确率 ' + pct + '%</span>';
  }

  function ratingOf(q){ const r = state.ratings[q.id]; return (r===0||r===1||r===2) ? r : -1; }

  function counts(){
    const total = QS.length;
    const done = QS.filter(q => ratingOf(q) === 2).length;
    const fuzzy = QS.filter(q => ratingOf(q) === 1).length;
    const bad = QS.filter(q => ratingOf(q) === 0).length;
    return { total, done, fuzzy, bad, todo: total - done - fuzzy - bad };
  }

  // 当前筛选范围内的统计（答题卡顶部用）
  function listCounts(){
    const total = LIST.length;
    const done = LIST.filter(q => ratingOf(q) === 2).length;
    const fuzzy = LIST.filter(q => ratingOf(q) === 1).length;
    const bad = LIST.filter(q => ratingOf(q) === 0).length;
    return { total, done, fuzzy, bad, todo: total - done - fuzzy - bad };
  }

  function filterKey(){
    return [state.chapters.slice().sort().join(','), state.types.slice().sort().join(','),
            state.onlyTodo?1:0, state.starsOnly?1:0, state.onlyWrong?1:0,
            state.failMin, state.maxStreak, state.rangeFrom, state.rangeTo].join('|');
  }

  // 这道题做错过几次（总次数 - 对次数）
  function failsOf(q){
    const at = state.attempts && state.attempts[q.id];
    if(!at) return 0;
    return Math.max(0, (at.n || 0) - (at.ok || 0));
  }

  // 题号范围：只保留第 from–to 题（1 起算，0 表示不限）
  function applyRange(arr){
    const from = Math.max(1, Number(state.rangeFrom) || 0);
    const to = Math.max(0, Number(state.rangeTo) || 0);
    if(from <= 1 && !to) return arr;
    const end = to > 0 ? to : arr.length;
    return arr.slice(from - 1, end);
  }

  function currentList(){
    let arr = QS;
    if(state.chapters.length) arr = arr.filter(q => state.chapters.includes(q.ch));
    if(state.types.length) arr = arr.filter(q => state.types.includes(q.t));
    if(state.starsOnly) arr = arr.filter(q => state.stars[q.id]);
    if(state.onlyWrong) arr = arr.filter(q => ratingOf(q) === 0);
    if(state.failMin > 0) arr = arr.filter(q => failsOf(q) >= state.failMin);
    if(state.maxStreak > 0) arr = arr.filter(q => streakOf(q) < state.maxStreak);
    if(state.onlyTodo) arr = arr.filter(q => ratingOf(q) < 2);
    arr = sortByType(arr);
    const k = filterKey();
    if(state.random){
      if(!state.seed[k] || state.seed[k].length !== arr.length){
        const ids = arr.map(q => q.id);
        for(let i=ids.length-1;i>0;i--){ const j = Math.floor(Math.random()*(i+1)); [ids[i],ids[j]]=[ids[j],ids[i]]; }
        state.seed[k] = ids;
        state.seedKey = k;
      }
      const order = new Map(state.seed[k].map((id,i)=>[id,i]));
      arr = arr.slice().sort((a,b)=> (order.get(a.id)??0) - (order.get(b.id)??0));
    }
    return applyRange(arr);
  }

  let LIST = [];
  let railSearchKw = '';   // 侧栏搜索关键词
  let wrongSubOpen = false; // 错题章节子项是否展开
  const railOpen = {};     // 题库展开状态 courseId -> bool

  /* ---------- 渲染 ---------- */
  function setTheme(t){
    state.theme = t;
    document.documentElement.dataset.theme = t;
    const name = (THEMES.find(x=>x[0]===t)||['','墨'])[1];
    $('themeName').textContent = name;
    syncFlowBg();
    save();
  }

  function answeredOf(list){
    let n = 0;
    for (const q of list) if (state.answers[q.id] || state.ratings[q.id] !== undefined) n++;
    return n;
  }

  // 题库名过长时自动缩小字号，保证单行
  function fitCrestTitle(el){
    el.style.fontSize = '';
    const box = el.parentElement ? el.parentElement.clientWidth : el.clientWidth;
    let size = parseFloat(getComputedStyle(el).fontSize) || 96;
    let guard = 0;
    while (el.scrollWidth > box && size > 30 && guard++ < 40) {
      size -= 3;
      el.style.fontSize = size + 'px';
    }
  }

  function renderChrome(){
    const c = counts();
    const doneAll = answeredOf(QS);
    $('doneN').textContent = doneAll;
    $('totalN').textContent = c.total;
    $('globalBar').style.transform = 'scaleX(' + (doneAll / c.total).toFixed(4) + ')';

    const rail = $('railList');
    rail.innerHTML = '';
    const kw = (railSearchKw || '').trim().toLowerCase();
    const hit = (t) => !kw || String(t).toLowerCase().includes(kw);

    const mkChapter = (parent, name, n, answered, isAll) => {
      const btn = document.createElement('button');
      btn.className = 'rail-item';
      const isCur = true;
      const active = isAll ? state.chapters.length === 0
                           : (state.chapters.length === 1 && state.chapters[0] === name);
      btn.setAttribute('aria-current', active ? 'true' : 'false');
      btn.innerHTML = '<span class="row"><span class="name"></span><span class="n"></span></span><span class="rail-line"><i class="bad"></i><i class="ok"></i></span>';
      btn.dataset.idx = isAll ? '全' : String(CHAPS.findIndex(c => c.name === name) + 1);
      btn.title = isAll ? '全部章节' : name;
      btn.querySelector('.name').textContent = isAll ? '全部章节' : name;
      btn.querySelector('.n').textContent = answered + '/' + n;
      const scope = isAll ? QS : QS.filter(q => q.ch === name);
      const okN = scope.filter(q => state.answers[q.id] && state.answers[q.id].ok === true).length;
      const badN = scope.filter(q => state.answers[q.id] && state.answers[q.id].ok === false).length;
      btn.querySelector('.rail-line i.bad').style.width = n ? (badN / n * 100).toFixed(1) + '%' : '0%';
      btn.querySelector('.rail-line i.ok').style.width = n ? (okN / n * 100).toFixed(1) + '%' : '0%';
      btn.addEventListener('click', () => showList(isAll ? 'all' : 'chapter', isAll ? '' : name));
      parent.appendChild(btn);
    };

    const curId = state.courseId;

    // 顶部：提交自建题库入口
    const addBank = document.createElement('button');
    addBank.className = 'rail-add-bank';
    addBank.type = 'button';
    addBank.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg><span>提交自建题库</span>';
    addBank.addEventListener('click', () => openBankModal());
    rail.appendChild(addBank);

    COURSES.forEach((course) => {
      const isCur = course.id === curId;
      const chapters = isCur ? CHAPS : (course.chapters || []);
      const courseHits = hit(course.name);
      const chapterHits = chapters.filter(ch => hit(ch.name));
      if (kw && !courseHits && !chapterHits.length) return;

      const open = kw ? true : (isCur ? (railOpen[course.id] !== false) : !!railOpen[course.id]);

      const head = document.createElement('button');
      head.className = 'rail-course';
      head.dataset.active = isCur ? 'true' : 'false';
      head.dataset.open = open ? 'true' : 'false';
      head.innerHTML = '<svg class="cv" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 6l6 6-6 6"/></svg><span class="cn"></span><span class="cc"></span>';
      head.querySelector('.cn').textContent = course.name;
      head.querySelector('.cc').textContent = courseTotal(course);
      head.addEventListener('click', () => {
        if (!isCur) {
          switchCourse(course.id);
          railOpen[course.id] = true;
        } else {
          railOpen[course.id] = !open;
        }
        renderChrome();
      });
      rail.appendChild(head);

      if (!open) return;
      const box = document.createElement('div');
      box.className = 'rail-chapters';
      rail.appendChild(box);

      if (isCur) {
        if (!kw || hit('全部章节')) mkChapter(box, '全部章节', QS.length, answeredOf(QS), true);
        const list = kw ? chapterHits : chapters;
        list.forEach((ch) => {
          const qs = byCh[ch.name] || [];
          mkChapter(box, ch.name, qs.length, answeredOf(qs), false);
        });
      } else {
        const list = kw ? chapterHits : chapters.slice(0, 40);
        list.forEach((ch) => {
          const btn = document.createElement('button');
          btn.className = 'rail-item';
          btn.setAttribute('aria-current', 'false');
          btn.innerHTML = '<span class="row"><span class="name"></span><span class="n"></span></span>';
          btn.querySelector('.name').textContent = ch.name;
          btn.querySelector('.n').textContent = ch.n || '';
          btn.addEventListener('click', () => { switchCourse(course.id); showList('chapter', ch.name); });
          box.appendChild(btn);
        });
      }
    });


    const lc = listCounts();
    $('sheetStats').textContent = '会了 ' + lc.done + ' · 模糊 ' + lc.fuzzy + ' · 不会 ' + lc.bad + ' · 没做 ' + lc.todo;
    $('jumpStarN').textContent = Object.keys(state.stars).length;
    $('jumpWrongN').textContent = QS.filter(q => ratingOf(q) === 0).length;

    // 错题子项已改到右侧页面，这里不再渲染侧栏展开
    $('jumpStar').setAttribute('aria-current', state.listKind === 'star' && document.body.dataset.view === 'list' ? 'true' : 'false');
    $('jumpWrong').setAttribute('aria-current', state.listKind === 'wrong' && document.body.dataset.view === 'list' ? 'true' : 'false');

    $('brandName').textContent = currentCourse().name;
    const crest = document.querySelector('.crest-title');
    if (crest) {
      crest.textContent = currentCourse().name;
      fitCrestTitle(crest);
    }
    $('railHint').innerHTML = '<b></b> 题没做 · <b></b> 题标记不会';
    const hb = $('railHint').querySelectorAll('b');
    hb[0].textContent = c.todo;
    hb[1].textContent = c.bad;
  }

  /* ---------- 填空题 / 题干渲染 ---------- */
  function hasBlank(q){
    return !!(q && Array.isArray(q.blank) && q.blank.length && String(q.q || '').indexOf('{{ANS}}') >= 0);
  }

  // 题干：填空题把 {{ANS}} 换成输入框
  function renderStem(q){
    const el = $('stem');
    const s = String((q && q.q) || '');
    const blanks = (q && q.blank) || [];
    if(!blanks.length || s.indexOf('{{ANS}}') < 0){ el.textContent = s; return; }
    el.textContent = '';
    const parts = s.split('{{ANS}}');
    parts.forEach((p, i) => {
      if(p) el.appendChild(document.createTextNode(p));
      if(i < parts.length - 1){
        const inp = document.createElement('input');
        inp.type = 'text';
        inp.className = 'blank-in';
        inp.autocomplete = 'off';
        inp.spellcheck = false;
        inp.dataset.i = String(i);
        el.appendChild(inp);
      }
    });
  }

  // 填空判分：去空格、去标点、忽略大小写
  function normBlank(s){
    return String(s == null ? '' : s)
      .replace(/[\s\u3000]/g, '')
      .replace(/[，,。.；;：:！!？?（）()【】\[\]“”"']/g, '')
      .toLowerCase();
  }

  function submitFill(q){
    const ins = [...$('stem').querySelectorAll('.blank-in')];
    if(!ins.length) return;
    const vals = ins.map(inp => inp.value);
    const okArr = ins.map((inp, i) => {
      const std = (q.blank || [])[i];
      const good = std != null && normBlank(vals[i]) !== '' && normBlank(vals[i]) === normBlank(std);
      inp.classList.toggle('is-right', good);
      inp.classList.toggle('is-wrong', !good);
      inp.disabled = true;
      return good;
    });
    const ok = okArr.every(Boolean);
    state.answers[q.id] = { blanks: vals, blankOk: okArr, ok };
    __reportStat(q.id, ok);
    markAttempt(q, ok);
    recordDaily(ok);
    q.__revealed = true;
    q.__judged = ok;
    state.ratings[q.id] = ok ? 2 : 0;
    [...$('rate').querySelectorAll('button')].forEach(b => {
      b.setAttribute('aria-pressed', Number(b.dataset.r) === state.ratings[q.id] ? 'true' : 'false');
    });
    $('btnSubmit').disabled = true;
    $('btnSubmit').dataset.done = '1';
    $('btnSubmit').textContent = ok ? '答对了' : '答错了';
    $('answer').querySelector('.ans-head').innerHTML =
      '<i class="dot"></i>' + (ok ? '回答正确' : '回答错误') + ' · ' + okArr.filter(Boolean).length + '/' + okArr.length + ' 空正确' + attemptTag(q.id);
    $('ansBody').textContent = q.a || '';
    $('ansBody').hidden = false;
    $('answer').dataset.open = 'true';
    $('rate').dataset.open = 'true';
    renderChrome(); renderSheet(); save();
    emit('rate', { id: q.id, value: state.ratings[q.id] });
    markDone(q); syncExplain(q);
    if(onlineOn() && typeof loadDiscuss === 'function') loadDiscuss();
  }

  function submitCurrent(){
    const q = LIST[state.idx];
    if(!q) return;
    if(hasBlank(q)) submitFill(q);
    else submitChoice();
  }

  function renderCard(animate){
    const card = $('card');
    if(!LIST.length){
      card.style.display = 'none';
      $('empty').dataset.open = 'true';
      $('posN').textContent = '0';
      $('posT').textContent = '0';
      return;
    }
    card.style.display = '';
    $('empty').dataset.open = 'false';

    if(state.idx < 0) state.idx = 0;
    if(state.idx > LIST.length - 1) state.idx = LIST.length - 1;
    const q = LIST[state.idx];
    state.__enterAt = Date.now();   // 学习统计：开始计时
    const r = ratingOf(q);

    $('qno').textContent = String(state.idx + 1).padStart(3, '0');
    $('qtype').textContent = q.t;
    $('qchap').textContent = q.ch;
    renderStem(q);

    // 选项（老题库里存成 {key,text} 的对象也兼容）
    const opts = $('opts');
    opts.innerHTML = '';
    if(q.o && q.o.length){
      opts.hidden = false;
      q.o.forEach((o, i) => {
        const ostr = optText(o, i);
        const m = ostr.match(/^([A-Za-z])[.、．]\s*([\s\S]*)$/);
        const key = m ? m[1].toUpperCase() : String.fromCharCode(65 + i);
        const li = document.createElement('li');
        const btn = document.createElement('button');
        btn.className = 'opt';
        btn.type = 'button';
        btn.setAttribute('aria-pressed','false');
        btn.dataset.key = key;
        btn.innerHTML = '<span class="k"></span><span class="txt"></span>';
        btn.querySelector('.k').textContent = key;
        btn.querySelector('.txt').textContent = m ? m[2] : ostr;
        btn.addEventListener('click', () => {
          if(q.atid === '0') pickSingle(btn);
          else togglePick(btn);
        });
        li.appendChild(btn);
        opts.appendChild(li);
      });
    } else {
      opts.hidden = true;
    }

    const note = $('optsNote');
    if(!opts.hidden && q.atid === '1'){
      note.hidden = false;
      note.textContent = '不定项选择 · 多选或少选均不得分';
    } else {
      note.hidden = true;
    }

    // 答案
    const ans = $('answer');
    const isFill = hasBlank(q);
    $('ansBody').textContent = q.a || (isFill ? '（未提供答案）' : '（系统未提供标准答案）');
    $('ansBody').hidden = false;
    ans.querySelector('.ans-head').innerHTML = '<i class="dot"></i>结果 · 标准答案';
    $('btnSubmit').textContent = '提交作答';
    if(!q.a) $('ansBody').classList.add('ans-empty');
    else $('ansBody').classList.remove('ans-empty');
    ans.dataset.open = (state.mode === 'recite' || q.__revealed) ? 'true' : 'false';
    $('btnReveal').querySelector('.lbl').textContent = ans.dataset.open === 'true' && q.__revealed ? '收起答案' : '看答案';

    // 按钮状态
    const isChoice = !!(q.o && q.o.length);
    const isSingle = isChoice && q.atid === '0';
    $('btnReveal').hidden = false;
    $('btnReveal').style.display = '';
    $('btnSubmit').hidden = !(isChoice || isFill);
    $('btnSubmit').style.display = (isChoice || isFill) ? '' : 'none';
    if(isChoice || isFill){
      $('btnSubmit').className = 'btn btn-primary';
      $('btnReveal').className = 'btn btn-ghost';
    } else {
      $('btnSubmit').className = 'btn btn-ghost';
      $('btnReveal').className = 'btn btn-primary';
    }
    if(isChoice){
      $('btnSubmit').disabled = true;
      $('btnSubmit').dataset.done = '';
    }
    if(isFill){
      $('btnSubmit').disabled = false;
      $('btnSubmit').dataset.done = '';
    }
    if(state.mode === 'recite'){
      $('btnReveal').hidden = true;
      $('btnSubmit').hidden = true;
      [...opts.querySelectorAll('.opt')].forEach(b => { b.disabled = true; });
    }

    // 已作答：还原选项与判定
    const trace = state.answers[q.id];
    if(trace && trace.picked && trace.picked.length){
      const rightKeys = (q.a || '').split(/[,，\s]+/).map(x=>x.trim().toUpperCase()).filter(Boolean);
      [...opts.querySelectorAll('.opt')].forEach(b => {
        const key = b.dataset.key;
        const picked = trace.picked.includes(key);
        b.setAttribute('aria-pressed', picked ? 'true' : 'false');
        if(rightKeys.includes(key)) b.classList.add('is-right');
        else if(picked) b.classList.add('is-wrong');
        b.disabled = true;
      });
      $('btnSubmit').disabled = true;
      $('btnSubmit').dataset.done = '1';
      $('btnSubmit').textContent = trace.ok ? '答对了' : '答错了';
      $('answer').querySelector('.ans-head').innerHTML =
        '<i class="dot"></i>' + (trace.ok ? '回答正确' : '回答错误') + attemptTag(q.id);
      $('ansBody').textContent = q.a || '';
      $('ansBody').hidden = false;
      $('answer').dataset.open = 'true';
    }
    // 填空题：还原每空的值和对错
    if(trace && Array.isArray(trace.blanks)){
      const ins = [...$('stem').querySelectorAll('.blank-in')];
      ins.forEach((inp, i) => {
        inp.value = trace.blanks[i] == null ? '' : trace.blanks[i];
        inp.disabled = true;
        const good = !!(trace.blankOk && trace.blankOk[i]);
        inp.classList.toggle('is-right', good);
        inp.classList.toggle('is-wrong', !good);
      });
      $('btnSubmit').disabled = true;
      $('btnSubmit').dataset.done = '1';
      $('btnSubmit').textContent = trace.ok ? '答对了' : '答错了';
      $('answer').querySelector('.ans-head').innerHTML =
        '<i class="dot"></i>' + (trace.ok ? '回答正确' : '回答错误') + (trace.blankOk ? ' · ' + trace.blankOk.filter(Boolean).length + '/' + trace.blankOk.length + ' 空正确' : '') + attemptTag(q.id);
      $('ansBody').textContent = q.a || '';
      $('ansBody').hidden = false;
      $('answer').dataset.open = 'true';
    }

    // 自评
    const rate = $('rate');
    rate.dataset.open = (r >= 0 || ans.dataset.open === 'true') ? 'true' : 'false';
    [...rate.querySelectorAll('button')].forEach(b => {
      b.setAttribute('aria-pressed', (r >= 0 && Number(b.dataset.r) === r) ? 'true' : 'false');
    });

    if(onlineOn() && typeof loadDiscuss === 'function') loadDiscuss();
    syncExplain(q);

    $('posN').textContent = state.idx + 1;
    $('posT').textContent = LIST.length;
    $('btnPrev').disabled = state.idx <= 0;
    $('btnNext').disabled = state.idx >= LIST.length - 1;

    const parts = [];
    if(state.chapters.length === 1) parts.push(state.chapters[0]);
    else if(state.chapters.length > 1) parts.push(state.chapters.length + ' 章');
    if(state.types.length === 1) parts.push(state.types[0]);
    else if(state.types.length > 1) parts.push(state.types.length + ' 种题型');
    if(state.onlyTodo) parts.push('未掌握');
    if(state.starsOnly) parts.push('收藏');
    if(state.random) parts.push('随机');
    if(state.rangeFrom > 1 || state.rangeTo > 0){
      parts.push('第 ' + Math.max(1, state.rangeFrom || 1) + (state.rangeTo ? '–' + state.rangeTo : ' 起') + ' 题');
    }
    if(state.failMin > 0) parts.push('错≥' + state.failMin);
    if(state.maxStreak > 0) parts.push('连对<' + state.maxStreak);
    $('filterTag').textContent = parts.length ? '· ' + parts.join(' · ') : '';
    $('filterTag').title = parts.length ? ('当前筛选：' + parts.join('、')) : '没有筛选，这个题库的题都在里面';
    const rd = $('roundStat');
    if(rd){
      const rn = state.round.n || 0, rok = state.round.ok || 0;
      rd.textContent = rn ? ('本轮 ' + rn + ' 题 · 对 ' + rok + '（' + Math.round(rok / rn * 100) + '%）') : '本轮还没开始';
    }
    $('btnOnlyTodo').setAttribute('aria-pressed', state.onlyTodo ? 'true':'false');
    $('btnRand').setAttribute('aria-pressed', state.random ? 'true':'false');
    $('btnMode').setAttribute('aria-pressed', state.mode === 'recite' ? 'true':'false');
    $('btnMode').querySelector('span').textContent = state.mode === 'recite' ? '刷题' : '背题';
    $('btnRand').textContent = state.random ? '随机中' : '随机顺序';
    $('btnOnlyTodo').textContent = '只看未掌握';
    $('btnOnlyStar').setAttribute('aria-pressed', state.starsOnly ? 'true':'false');
    $('btnStar').setAttribute('aria-pressed', state.stars[q.id] ? 'true':'false');
    $('btnStar').setAttribute('aria-label', state.stars[q.id] ? '取消收藏' : '收藏这道题');

    if(animate){ card.style.animation = 'none'; void card.offsetWidth; card.style.animation = ''; }
    save();
  }

  function refresh(animate){
    LIST = currentList();
    renderChrome();
    renderCard(animate);
    renderSheet();
    if(document.body.dataset.view === 'list') renderList();
  }

  /* ---------- 看答案 / 自评 ---------- */
  function reveal(){
    const q = LIST[state.idx];
    if(!q) return;
    q.__revealed = true;
    $('answer').dataset.open = 'true';
    $('ansBody').hidden = false;
    $('rate').dataset.open = 'true';
    $('btnReveal').querySelector('.lbl').textContent = '收起答案';
    save();
    if(onlineOn() && typeof loadDiscuss === 'function') loadDiscuss();
  }
  function conceal(){
    const q = LIST[state.idx];
    if(!q) return;
    q.__revealed = false;
    $('answer').dataset.open = 'false';
    const r = ratingOf(q);
    $('rate').dataset.open = r >= 0 ? 'true' : 'false';
    $('btnReveal').querySelector('.lbl').textContent = '看答案';
  }
  function toggleReveal(){
    const q = LIST[state.idx];
    if(!q) return;
    if($('answer').dataset.open === 'true' && !q.__revealed) return;
    if(q.__revealed) conceal(); else reveal();
  }

  function rate(v){
    const q = LIST[state.idx];
    if(!q) return;
    state.ratings[q.id] = v;
    // 主观题没有提交按钮，只能自评：按自评记一次连对
    if(!(q.o && q.o.length) && !hasBlank(q)) markAttempt(q, v === 2);
    [...$('rate').querySelectorAll('button')].forEach(b => {
      b.setAttribute('aria-pressed', Number(b.dataset.r) === v ? 'true':'false');
    });
    q.__revealed = true;
    $('answer').dataset.open = 'true';
    $('rate').dataset.open = 'true';
    renderChrome();
    renderSheet();
    save();
    emit('rate', { id: q.id, value: v });
    markDone(q);
    syncExplain(q);
    if(v === 2) setTimeout(()=>{ if(state.idx < LIST.length - 1) go(1); }, 210);
  }

  function go(d){
    if(!LIST.length) return;
    const next = state.idx + d;
    if(next < 0 || next > LIST.length - 1) return;
    LIST[state.idx].__revealed = false;
    state.idx = next;
    renderCard(true);
    renderSheetIfOpen();
    if(onlineOn() && typeof loadDiscuss === 'function') loadDiscuss();
  }

  function jump(i){
    if(i < 0 || i > LIST.length - 1) return;
    state.idx = i;
    renderCard(true);
    renderSheetIfOpen();
    if(onlineOn() && typeof loadDiscuss === 'function') loadDiscuss();
  }

  function renderSheetIfOpen(){
    if($('sheet').dataset.open === 'true') renderSheet();
  }

  // 跳到某道题；若被当前筛选挡住，逐层放宽
  function gotoQuestion(q){
    if(document.body.dataset.view !== 'practice') document.body.dataset.view = 'practice';
    let i = LIST.findIndex(x => x.id === q.id);
    if(i >= 0){ jump(i); return; }
    state.onlyTodo = false; state.starsOnly = false;
    refresh();
    i = LIST.findIndex(x => x.id === q.id);
    if(i < 0){ state.types = []; refresh(); i = LIST.findIndex(x => x.id === q.id); }
    if(i < 0){ state.chapters = []; refresh(); i = LIST.findIndex(x => x.id === q.id); }
    if(i >= 0) jump(i);
  }

  /* ---------- 选择题提交 ---------- */
  function togglePick(btn){
    if($('btnSubmit').dataset.done === '1') return;
    btn.setAttribute('aria-pressed', btn.getAttribute('aria-pressed') === 'true' ? 'false':'true');
    const n = [...$('opts').querySelectorAll('.opt')].filter(b => b.getAttribute('aria-pressed') === 'true').length;
    $('btnSubmit').disabled = n === 0;
    $('btnSubmit').textContent = n ? '提交作答 · 已选 ' + n : '提交作答';
  }

  function pickSingle(btn){
    if($('btnSubmit').dataset.done === '1') return;
    [...$('opts').querySelectorAll('.opt')].forEach(b => b.setAttribute('aria-pressed','false'));
    btn.setAttribute('aria-pressed','true');
    $('btnSubmit').disabled = false;
    $('btnSubmit').textContent = '提交作答';
  }

  // ---------- 学习统计 ----------
  function todayKey(){
    const d = new Date();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return d.getFullYear() + '-' + m + '-' + day;
  }

  function recordDaily(ok){
    try{
      const k = todayKey();
      const rec = state.daily[k] || (state.daily[k] = { n: 0, ok: 0, sec: 0 });
      rec.n += 1;
      if(ok) rec.ok += 1;
      // 本题实际耗时（秒）
      if(state.__enterAt){
        rec.sec += Math.max(0, Math.round((Date.now() - state.__enterAt) / 1000));
        state.__enterAt = Date.now();
      }
    }catch(e){}
  }

  // 汇总某段时间：今天 / 本周 / 本月 / 全部
  function dailyRange(kind){
    const now = new Date();
    let from = null;
    if(kind === 'day'){ from = todayKey(); }
    else if(kind === 'week'){
      const d = new Date(now); const wd = (d.getDay() + 6) % 7; // 周一=0
      d.setDate(d.getDate() - wd);
      from = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
    }else if(kind === 'month'){
      from = now.getFullYear() + '-' + String(now.getMonth()+1).padStart(2,'0') + '-01';
    }
    const today = todayKey();
    let n = 0, ok = 0, sec = 0;
    for(const [day, v] of Object.entries(state.daily || {})){
      if(from && day < from) continue;
      if(day > today) continue;
      n += v.n || 0; ok += v.ok || 0; sec += v.sec || 0;
    }
    return { n, ok, bad: Math.max(0, n - ok), sec, rate: n ? Math.round(ok / n * 100) : 0 };
  }

  window.__hbDaily = dailyRange;

  // 近 N 天每日题量（柱状图用）
  window.__hbDailySeries = function(days){
    const out = [];
    const today = new Date();
    for(let i = days - 1; i >= 0; i--){
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const k = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
      const v = (state.daily || {})[k];
      out.push({ day: k, n: v ? (v.n || 0) : 0 });
    }
    return out;
  };

  function submitChoice(){
    const q = LIST[state.idx];
    if(!q || !q.o) return;
    const btns = [...$('opts').querySelectorAll('.opt')];
    const on = btns.filter(b => b.getAttribute('aria-pressed') === 'true');
    const picked = on.map(b => b.dataset.key).sort();
    const right = (q.a || '').split(/[,，\s]+/).map(s=>s.trim().toUpperCase()).filter(Boolean).sort();
    const ok = picked.length === right.length && picked.every((v,i)=>v===right[i]);

    btns.forEach(b => {
      const key = b.dataset.key;
      if(right.includes(key)) b.classList.add('is-right');
      else if(b.getAttribute('aria-pressed') === 'true') b.classList.add('is-wrong');
      b.disabled = true;
    });
    $('btnSubmit').disabled = true;
    $('btnSubmit').dataset.done = '1';
    $('btnSubmit').textContent = ok ? '答对了' : '答错了';
    state.answers[q.id] = { picked, ok };
    __reportStat(q.id, ok);
    markAttempt(q, ok);
    recordDaily(ok);   // 学习统计
    $('answer').querySelector('.ans-head').innerHTML =
      '<i class="dot"></i>' + (ok ? '回答正确' : '回答错误') + attemptTag(q.id);
    $('ansBody').textContent = q.a || '（系统未提供标准答案）';
    $('ansBody').hidden = false;
    $('answer').dataset.open = 'true';
    $('rate').dataset.open = 'true';
    q.__revealed = true;
    q.__judged = ok;
    state.ratings[q.id] = ok ? 2 : 0;
    [...$('rate').querySelectorAll('button')].forEach(b => {
      b.setAttribute('aria-pressed', Number(b.dataset.r) === state.ratings[q.id] ? 'true' : 'false');
    });
    renderChrome(); renderSheet(); save();
    emit('rate', { id: q.id, value: state.ratings[q.id] });
    // 做完这题，讨论区立即开放
    markDone(q);
    syncExplain(q);
    if(onlineOn() && typeof loadDiscuss === 'function') loadDiscuss();
    if(ok) setTimeout(() => { if(state.idx < LIST.length - 1) go(1); }, 900);
  }

  /* ---------- 收藏 / 错题列表 ---------- */
  function listBase(kind){
    if(kind === 'star') return sortByType(QS.filter(q => state.stars[q.id]));
    if(kind === 'wrong'){
      // 选了「连对 < N」时，错题本切成「连对本」：显示连对不足 N 次的题（不管当前标记）
      if(state.maxStreak > 0) return sortByType(QS.filter(q => streakOf(q) < state.maxStreak));
      return sortByType(QS.filter(q => ratingOf(q) === 0));
    }
    if(kind === 'chapter') return sortByType(QS.filter(q => state.chapters.includes(q.ch)));
    return sortByType(QS);
  }

  function showList(kind, chapter){
    document.body.dataset.drawer = '';
    state.listKind = kind;
    state.chapters = chapter ? [chapter] : [];
    state.types = [];
    state.onlyTodo = false;
    state.onlyWrong = kind === 'wrong';
    state.starsOnly = kind === 'star';
    state.failMin = 0;
    state.maxStreak = 0;
    state.random = false;
    state.idx = 0;
    document.body.dataset.view = 'list';
    LIST = currentList();
    renderChrome();
    renderList();
    if (window.__syncBg) window.__syncBg();
    save();
  }

  function renderList(){
    const kind = state.listKind || 'star';
    const base = listBase(kind);   // 全量（用于算各个 chip 的数量）
    // 实际显示的列表：章节 + 错误次数 + 题型 三者叠加
    let list = base;
    if(state.chapters.length) list = list.filter(q => state.chapters.includes(q.ch));
    if(state.failMin > 0) list = list.filter(q => failsOf(q) >= state.failMin);
    if(state.maxStreak > 0) list = list.filter(q => streakOf(q) < state.maxStreak);
    if(state.types.length) list = list.filter(q => state.types.includes(q.t));

    const chName = state.chapters.length === 1 ? state.chapters[0] : '';
    $('lvTitle').textContent = kind === 'star' ? '收藏'
      : kind === 'wrong' ? (state.maxStreak > 0 ? '连对本 · 连对 < ' + state.maxStreak : (chName ? '错题 · ' + chName : '错题'))
      : kind === 'chapter' ? (state.chapters[0] || '章节')
      : '全部章节';
    $('lvSub').textContent = '';

    // ---------- 章节筛选（错题视图才有） ----------
    const chBox = $('lvChapterBox');
    const chWrap = $('lvChapters');
    if(chBox && chWrap){
      const showCh = (kind === 'wrong');
      chBox.hidden = !showCh;
      chWrap.innerHTML = '';
      if(showCh){
        const byCh = {};
        base.forEach(q => { byCh[q.ch] = (byCh[q.ch] || 0) + 1; });
        const mk = (label, count, active, onClick) => {
          const b = document.createElement('button');
          b.type = 'button'; b.className = 'chip';
          b.innerHTML = '<span class="t"></span><span class="c"></span>';
          b.querySelector('.t').textContent = label;
          b.querySelector('.c').textContent = count;
          b.setAttribute('aria-pressed', active ? 'true' : 'false');
          b.addEventListener('click', onClick);
          chWrap.appendChild(b);
        };
        mk('全部章节', base.length, state.chapters.length === 0, () => {
          state.chapters = []; renderChrome(); renderList();
        });
        Object.keys(byCh)
          .sort((a, b) => byCh[b] - byCh[a])
          .forEach(ch => {
            mk(ch, byCh[ch], state.chapters.length === 1 && state.chapters[0] === ch, () => {
              state.chapters = (state.chapters.length === 1 && state.chapters[0] === ch) ? [] : [ch];
              renderChrome(); renderList();
            });
          });
      }
    }

    // ---------- 错误次数筛选（错题视图才有） ----------
    const failBox = $('lvFailBox');
    const failWrap = $('lvFails');
    if(failBox && failWrap){
      const showFail = (kind === 'wrong');
      failBox.hidden = !showFail;
      failWrap.innerHTML = '';
      if(showFail){
        const mkF = (label, min, active) => {
          const b = document.createElement('button');
          b.type = 'button'; b.className = 'chip';
          b.innerHTML = '<span class="t"></span><span class="c"></span>';
          b.querySelector('.t').textContent = label;
          const n = min === 0 ? base.length : base.filter(q => failsOf(q) >= min).length;
          b.querySelector('.c').textContent = n;
          b.setAttribute('aria-pressed', active ? 'true' : 'false');
          b.addEventListener('click', () => {
            state.failMin = (state.failMin === min) ? 0 : min;
            renderChrome(); renderList();
          });
          failWrap.appendChild(b);
        };
        mkF('全部', 0, state.failMin === 0);
        mkF('错 2 次及以上', 2, state.failMin === 2);
        mkF('错 3 次及以上', 3, state.failMin === 3);
      }
    }

    // ---------- 连对次数筛选（错题视图才有）：只留「还没连续做对 N 次」的题 ----------
    const strBox = $('lvStreakBox');
    const strWrap = $('lvStreaks');
    if(strBox && strWrap){
      const showStr = (kind === 'wrong');
      strBox.hidden = !showStr;
      strWrap.innerHTML = '';
      if(showStr){
        const mkS = (label, max, active) => {
          const b = document.createElement('button');
          b.type = 'button'; b.className = 'chip';
          b.innerHTML = '<span class="t"></span><span class="c"></span>';
          b.querySelector('.t').textContent = label;
          b.querySelector('.c').textContent = max === 0 ? QS.length : QS.filter(q => streakOf(q) < max).length;
          b.setAttribute('aria-pressed', active ? 'true' : 'false');
          b.addEventListener('click', () => {
            state.maxStreak = (state.maxStreak === max) ? 0 : max;
            renderChrome(); renderList();
          });
          strWrap.appendChild(b);
        };
        mkS('不限', 0, state.maxStreak === 0);
        mkS('连对 < 1', 1, state.maxStreak === 1);
        mkS('连对 < 2', 2, state.maxStreak === 2);
        mkS('连对 < 3', 3, state.maxStreak === 3);
      }
    }

    // 题型筛选
    const box = $('lvTypes');
    box.innerHTML = '';
    const types = [];
    base.forEach(q => { if(!types.includes(q.t)) types.push(q.t); });
    types.sort((a, b) => typeRank(a) - typeRank(b));
    const addChip = (label, count, active, onClick) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.innerHTML = '<span class="t"></span><span class="c"></span>';
      b.querySelector('.t').textContent = label;
      b.querySelector('.c').textContent = count;
      b.setAttribute('aria-pressed', active ? 'true' : 'false');
      b.addEventListener('click', onClick);
      box.appendChild(b);
    };
    if(types.length){
      addChip('全部题型', base.length, state.types.length === 0, () => {
        state.types = [];
        renderList();
      });
      types.forEach(t => {
        addChip(t, base.filter(q => q.t === t).length, state.types.includes(t), () => {
          state.types = state.types.includes(t) ? [] : [t];
          renderList();
        });
      });
    }

    // 题号网格（超过 400 题只画前 400 个，避免一次塞太多 DOM）
    const shown = list.length > 400 ? list.slice(0, 400) : list;
    if(list.length > 400 && $('lvSub')){
      $('lvSub').textContent = '只显示前 400 题（共 ' + list.length + ' 题），用上面的筛选或搜索缩小范围';
    }
    const grid = $('lvGrid');
    grid.innerHTML = '';
    shown.forEach((q, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'lv-cell';
      const r = ratingOf(q);
      b.dataset.s = r >= 0 ? String(r) : '';
      b.textContent = String(i + 1);
      b.title = '第 ' + (i + 1) + ' 题 · ' + q.ch + ' · ' + q.t;
      b.addEventListener('click', () => {
        LIST = list;
        state.idx = i;
        document.body.dataset.view = 'practice';
        renderCard(true);
        renderChrome();
        if (window.__syncBg) window.__syncBg();
        save();
      });
      grid.appendChild(b);
    });

    const touched = list.filter(q => state.ratings[q.id] !== undefined || state.answers[q.id]).length;
    const rb = $('btnResetRange');
    rb.hidden = !touched;
    rb.dataset.armed = '';
    const label = kind === 'wrong' ? '重做这些错题' : '重刷这一范围';
    rb.textContent = label + ' · ' + touched + ' 题';
    rb.onclick = () => {
      if(rb.dataset.armed !== '1'){
        rb.dataset.armed = '1';
        rb.textContent = kind === 'wrong'
          ? '确认重做这 ' + touched + ' 题？错题会保留，再点一次'
          : '确认清空这 ' + touched + ' 题？再点一次';
        setTimeout(() => { if(rb.dataset.armed === '1'){ rb.dataset.armed = ''; rb.textContent = label + ' · ' + touched + ' 题'; } }, 3200);
        return;
      }
      list.forEach(q => {
        delete state.answers[q.id];
        if(kind !== 'wrong') delete state.ratings[q.id];
      });
      save();
      renderChrome();
      renderList();
      renderSheet();
    };

    const empty = $('lvEmpty');
    empty.hidden = list.length > 0;
    empty.textContent = kind === 'star'
      ? '还没有收藏的题。在题卡右上角点星标就能收藏。'
      : kind === 'wrong'
        ? '还没有标记「不会」的题。做题时点「3 不会」就收进这里。'
        : '这个范围里还没有题。';
    $('lvLegendEmpty') && ($('lvLegendEmpty').hidden = list.length === 0);
  }

  /* ---------- 答题卡（分页渲染，几千题也不会卡） ---------- */
  const SHEET_PAGE = 100;
  let sheetPage = 0;

  function renderSheet(){
    const body = $('sheetBody');
    if(!body) return;
    body.innerHTML = '';
    const total = LIST.length;
    if(!total){
      body.innerHTML = '<div class="sheet-empty">这个筛选下没有题</div>';
      return;
    }
    const pages = Math.ceil(total / SHEET_PAGE);
    const curPage = Math.floor(Math.max(0, state.idx) / SHEET_PAGE);
    if(sheetPage !== curPage) sheetPage = curPage;
    if(sheetPage > pages - 1) sheetPage = pages - 1;
    if(sheetPage < 0) sheetPage = 0;
    const from = sheetPage * SHEET_PAGE;
    const to = Math.min(total, from + SHEET_PAGE);

    const pager = document.createElement('div');
    pager.className = 'sheet-pager';
    const mkBtn = (label, disabled, fn) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'sheet-pg';
      b.textContent = label;
      b.disabled = !!disabled;
      if(!disabled) b.addEventListener('click', fn);
      return b;
    };
    pager.appendChild(mkBtn('‹ 上一页', sheetPage <= 0, () => { sheetPage--; renderSheet(); }));
    const info = document.createElement('span');
    info.className = 'sheet-pager-info';
    info.textContent = '第 ' + (sheetPage + 1) + '/' + pages + ' 页 · ' + (from + 1) + '–' + to + ' 题，共 ' + total;
    pager.appendChild(info);
    pager.appendChild(mkBtn('下一页 ›', sheetPage >= pages - 1, () => { sheetPage++; renderSheet(); }));
    body.appendChild(pager);

    // 当前页里出现哪些章节
    const pageIdx = [];
    for(let k = from; k < to; k++) pageIdx.push(k);
    const groups = [];
    pageIdx.forEach(k => { if(!groups.includes(LIST[k].ch)) groups.push(LIST[k].ch); });

    groups.forEach(name => {
      const idxs = pageIdx.filter(k => LIST[k].ch === name);
      if(!idxs.length) return;
      const sec = document.createElement('section');
      sec.className = 'sheet-ch';
      const h = document.createElement('h4');
      h.innerHTML = '<span class="t"></span><span class="n"></span>';
      h.querySelector('.t').textContent = name;
      h.querySelector('.n').textContent = idxs.filter(k => ratingOf(LIST[k]) === 2).length + '/' + idxs.length;
      sec.appendChild(h);
      const g = document.createElement('div');
      g.className = 'grid';
      idxs.forEach(k => {
        const q = LIST[k];
        const b = document.createElement('button');
        b.className = 'cell';
        const r = ratingOf(q);
        b.dataset.s = r >= 0 ? String(r) : '';
        b.textContent = String(k + 1);
        if(state.stars[q.id]) b.classList.add('is-star');
        if(k === state.idx) b.setAttribute('aria-current', 'true');
        b.title = '第 ' + (k + 1) + ' 题 · ' + q.t;
        b.addEventListener('click', () => { gotoQuestion(q); closeSheet(); });
        g.appendChild(b);
      });
      sec.appendChild(g);
      body.appendChild(sec);
    });
  }

  function openSheet(){ $('sheet').dataset.open = 'true'; renderSheet(); }
  function closeSheet(){ $('sheet').dataset.open = 'false'; }

  /* ---------- 搜索 ---------- */
  function renderCourseOptions(){
    const sel = $('searchCourse');
    sel.innerHTML = '';
    const all = document.createElement('option');
    all.value = '';
    all.textContent = '全部题库';
    sel.appendChild(all);
    COURSES.forEach(c => {
      const o = document.createElement('option');
      o.value = c.id;
      o.textContent = c.name;
      sel.appendChild(o);
    });
    // 默认「全部题库」，与当前刷的是哪一科无关
    sel.value = '';
  }

  function openSearch(){
    $('search').dataset.open = 'true';
    renderCourseOptions();
    $('searchInput').value = '';
    renderSearch('');
    setTimeout(() => $('searchInput').focus(), 80);
  }
  function closeSearch(){ $('search').dataset.open = 'false'; }

  // 去掉选项前的 A. B. C. 标签，只留选项文字；选择题的答案就是字母，不参与搜索
  function searchBody(q){
    const stem = (q.q || '').replace(/(^|\n)\s*[A-E][.、．]\s*/g, '$1');
    const opts = (q.o || []).map((o, i) => optText(o, i).replace(/^\s*[A-E][.、．]\s*/, '')).join('\n');
    return opts ? stem + '\n' + opts : stem;
  }
  function matchText(q){
    const choice = q.atid === '0' || q.atid === '1';
    return { text: searchBody(q), answer: choice ? '' : (q.a || '') };
  }

  function renderSearch(kw){
    const body = $('searchBody');
    const s = (kw || '').trim();
    const scopeId = $('searchCourse') ? $('searchCourse').value : '';
    const multi = COURSES.length > 1;
    body.innerHTML = '';
    const list = document.createElement('div');
    list.className = 'sresults';
    if(!s){
      const p = document.createElement('p');
      p.className = 'sempty';
      p.textContent = '输入关键词开始搜，题干和标准答案都会匹配。当前范围：' + (scopeId ? (COURSES.find(c=>c.id===scopeId)||{}).name : '全部题库');
      list.appendChild(p);
      body.appendChild(list);
      return;
    }
    const low = s.toLowerCase();
    let hits = 0;
    for(const c of COURSES){
      if(scopeId && c.id !== scopeId) continue;
      if(hits >= 80) break;
      let perCourse = 0;
      for(const q of c.questions){
        const m = matchText(q);
        const inQ = m.text.toLowerCase().includes(low);
        const inA = m.answer.toLowerCase().includes(low);
        if(!inQ && !inA) continue;
        if(++hits > 80 || ++perCourse > 40) break;
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'sresult';
        b.innerHTML = '<span class="meta"><span class="src"></span><span class="no"></span><span class="ch"></span><span class="ty"></span></span><span class="txt"></span>';
        if(multi || !scopeId) b.querySelector('.src').textContent = c.name;
        b.querySelector('.no').textContent = '#' + (c.questions.indexOf(q) + 1);
        b.querySelector('.ch').textContent = q.ch;
        b.querySelector('.ty').textContent = q.t;
        const txt = b.querySelector('.txt');
        const src = (inQ ? m.text : m.answer).replace(/\n+/g, ' ');
        const at = src.toLowerCase().indexOf(low);
        const from = Math.max(0, at - 24);
        txt.appendChild(document.createTextNode((from ? '…' : '') + src.slice(from, at)));
        const mark = document.createElement('mark');
        mark.textContent = src.slice(at, at + s.length);
        txt.appendChild(mark);
        txt.appendChild(document.createTextNode(src.slice(at + s.length, at + s.length + 64) + (src.length > at + s.length + 64 ? '…' : '')));
        b.addEventListener('click', () => {
          if(c.id !== state.courseId) switchCourse(c.id);
          gotoQuestion(q);
          closeSearch();
        });
        list.appendChild(b);
      }
    }
    if(!hits){
      const p = document.createElement('p');
      p.className = 'sempty';
      p.textContent = '没有找到「' + s + '」。换个词试试，比如「队列」「偏倚」。';
      list.appendChild(p);
    }
    body.appendChild(list);
  }

  /* ---------- 事件绑定 ---------- */
  $('btnReveal').addEventListener('click', () => {
    if($('answer').dataset.open === 'true') conceal(); else reveal();
  });
  $('btnSubmit').addEventListener('click', submitCurrent);
  $('btnPrev').addEventListener('click', () => go(-1));
  $('btnNext').addEventListener('click', () => go(1));
  $('btnSheet').addEventListener('click', openSheet);
  $('btnRand').addEventListener('click', () => { state.random = !state.random; state.seed = {}; state.idx = 0; refresh(true); });
  $('btnOnlyTodo').addEventListener('click', () => { state.onlyTodo = !state.onlyTodo; state.idx = 0; refresh(true); });
  $('btnOnlyStar').addEventListener('click', () => { state.starsOnly = !state.starsOnly; state.idx = 0; refresh(true); });

  // 题号范围：输入框失焦或回车就生效
  function applyRangeInputs(){
    let from = parseInt($('rangeFrom') && $('rangeFrom').value, 10) || 0;
    let to = parseInt($('rangeTo') && $('rangeTo').value, 10) || 0;
    if(from < 0) from = 0;
    if(to < 0) to = 0;
    if(from > 0 && to > 0 && to < from){ const t = from; from = to; to = t; }
    state.rangeFrom = from;
    state.rangeTo = to;
    save();
    renderSetup();
  }
  ['rangeFrom', 'rangeTo'].forEach(id => {
    const el = $(id);
    if(!el) return;
    el.addEventListener('change', applyRangeInputs);
    el.addEventListener('keydown', (e) => { if(e.key === 'Enter'){ e.preventDefault(); applyRangeInputs(); el.blur(); } });
  });
  const rangeClearBtn = $('rangeClear');
  if(rangeClearBtn) rangeClearBtn.addEventListener('click', () => {
    state.rangeFrom = 0; state.rangeTo = 0;
    if($('rangeFrom')) $('rangeFrom').value = '';
    if($('rangeTo')) $('rangeTo').value = '';
    save(); renderSetup();
  });

  // 侧栏搜索：输入即过滤题库 / 章节
  $('railSearch').addEventListener('input', (e) => {
    railSearchKw = e.target.value;
    renderChrome();
  });

  function applyRail(){
    document.body.dataset.rail = state.railCollapsed ? 'collapsed' : 'expanded';
    const b = $('btnRail');
    b.setAttribute('aria-expanded', state.railCollapsed ? 'false' : 'true');
    b.setAttribute('aria-label', state.railCollapsed ? '展开侧栏' : '折叠侧栏');
    b.style.background = state.railCollapsed ? 'var(--accent)' : '';
    b.style.color = state.railCollapsed ? 'var(--accent-ink)' : '';
  }
  // ---------- 学习统计面板 ----------
  let statsRange = 'day';

  function renderStats(){
    if(!window.__hbDaily) return;
    const v = window.__hbDaily(statsRange);
    const $d = id => document.getElementById(id);
    if($d('snDone')) $d('snDone').textContent = v.n;
    if($d('snOk')) $d('snOk').textContent = v.ok;
    if($d('snBad')) $d('snBad').textContent = v.bad;
    if($d('snRate')) $d('snRate').textContent = v.rate + '%';
    if($d('snTime')){
      const m = Math.round(v.sec / 60);
      $d('snTime').textContent = m >= 60 ? (Math.floor(m/60) + ' 时 ' + (m%60) + ' 分') : (m + ' 分钟');
    }
    // 近 14 天柱状图
    const chart = $d('statsChart');
    if(chart && window.__hbDailySeries){
      const arr = window.__hbDailySeries(14);
      const max = Math.max(1, ...arr.map(x => x.n));
      chart.innerHTML = arr.map(x =>
        '<i class="' + (x.n >= max * 0.7 ? 'hi' : '') + '" style="height:' + Math.max(2, Math.round(x.n / max * 56)) + 'px"></i>'
      ).join('');
    }
  }

  function renderAccStats(){
    if(!window.__hbDaily) return;
    const $d = id => document.getElementById(id);
    const fmt = (v) => v.n + ' 题 · ' + (v.sec >= 3600 ? (Math.floor(v.sec/3600) + ' 时 ' + Math.round(v.sec%3600/60) + ' 分') : Math.round(v.sec/60) + ' 分钟');
    const d = window.__hbDaily('day');
    const w = window.__hbDaily('week');
    const m = window.__hbDaily('month');
    if($d('accToday')) $d('accToday').textContent = fmt(d);
    if($d('accWeek')) $d('accWeek').textContent = fmt(w);
    if($d('accMonth')) $d('accMonth').textContent = fmt(m);
    if($d('accRate')) $d('accRate').textContent = m.rate + '%';
  }

  function openStats(){
    const m = document.getElementById('statsModal');
    if(!m) return;
    m.dataset.open = 'true';
    renderStats();
  }
  function closeStats(){
    const m = document.getElementById('statsModal');
    if(m) m.dataset.open = 'false';
  }

  document.addEventListener('click', (e) => {
    const t = e.target;
    if(t && t.closest && t.closest('#btnStats')){ openStats(); return; }
    if(t && t.closest && t.closest('#statsClose')){ closeStats(); return; }
    if(t && t.closest && t.closest('#accStatsMore')){
      const acc = document.getElementById('account'); if(acc) acc.dataset.open = 'false';
      openStats(); return;
    }
    const tab = t && t.closest && t.closest('#statsTabs button');
    if(tab){
      statsRange = tab.dataset.r;
      [...document.querySelectorAll('#statsTabs button')].forEach(b =>
        b.setAttribute('aria-pressed', b === tab ? 'true' : 'false'));
      renderStats();
      return;
    }
    const modal = document.getElementById('statsModal');
    if(modal && modal.dataset.open === 'true' && t === modal) closeStats();
  });

  $('jumpStar').addEventListener('click', () => showList('star'));
  $('jumpWrong').addEventListener('click', () => showList('wrong'));
  const drawer = (on) => { document.body.dataset.drawer = on ? 'open' : ''; };
  $('btnRailOpen').addEventListener('click', () => drawer(true));
  $('railScrim').addEventListener('click', () => drawer(false));
  document.addEventListener('keydown', (e) => { if(e.key === 'Escape') drawer(false); });
  $('btnRail').addEventListener('click', () => {
    state.railCollapsed = !state.railCollapsed;
    applyRail();
    save();
  });

  $('btnStar').addEventListener('click', () => {
    const q = LIST[state.idx];
    if(!q) return;
    if(state.stars[q.id]) delete state.stars[q.id]; else state.stars[q.id] = 1;
    save(); renderCard(false); renderSheet();
  });
  $('btnMode').addEventListener('click', () => {
    state.mode = state.mode === 'recite' ? 'practice' : 'recite';
    refresh();
  });
  $('btnTheme').addEventListener('click', () => {
    const i = THEMES.findIndex(t=>t[0]===state.theme);
    setTheme(THEMES[(i+1)%THEMES.length][0]);
  });
  $('btnClearFilter').addEventListener('click', () => {
    state.chapters=[]; state.types=[]; state.onlyTodo=false; state.idx=0; refresh(true);
  });

  // ---------- 题库缓存管理 ----------
  async function renderCacheList(){
    const box = document.getElementById('cacheList');
    if(!box) return;
    box.innerHTML = '';

    // 1) 学校题库缓存（IndexedDB）
    let list = [];
    try{ list = await window.HBMUCache.list(); }catch(e){}
    list.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));

    // 2) 自建题库（localStorage）
    const customs = loadCustomBanks();

    if(!list.length && !customs.length){
      const e = document.createElement('div');
      e.className = 'cache-empty';
      e.textContent = '暂无缓存';
      box.appendChild(e);
      return;
    }

    const loadedIds = new Set(COURSES.map(c => c.id));

    const mkRow = (opts) => {
      const row = document.createElement('div');
      row.className = 'cache-row';
      row.innerHTML = '<span class="nm"></span><span class="meta"></span>' +
        '<button class="load">加载</button><button class="del">删除</button>';
      row.querySelector('.nm').textContent = opts.name;
      row.querySelector('.meta').textContent = opts.meta;
      const loadBtn = row.querySelector('.load');
      const delBtn = row.querySelector('.del');

      if(opts.loaded){
        loadBtn.textContent = '已加载';
        loadBtn.disabled = true;
        loadBtn.classList.add('is-loaded');
      }else{
        loadBtn.addEventListener('click', async () => {
          try{
            if(opts.custom){
              window.Drills.addCourse(opts.data);
            }else{
              const full = await window.HBMUCache.get(opts.id);
              if(!full || !full.questions || !full.questions.length){
                loadBtn.textContent = '缓存为空';
                return;
              }
              window.Drills.addCourse(full);
            }
            loadBtn.textContent = '已加载';
            loadBtn.disabled = true;
            loadBtn.classList.add('is-loaded');
          }catch(err){
            loadBtn.textContent = '加载失败';
          }
        });
      }

      delBtn.addEventListener('click', async () => {
        // 二次确认
        if(delBtn.dataset.armed !== '1'){
          delBtn.dataset.armed = '1';
          delBtn.textContent = '确认删除?';
          setTimeout(() => {
            if(delBtn.dataset.armed === '1'){ delBtn.dataset.armed = ''; delBtn.textContent = '删除'; }
          }, 3500);
          return;
        }
        delBtn.dataset.armed = '';
        delBtn.textContent = '删除';

        try{
          if(opts.custom){
            const left = loadCustomBanks().filter(c => c.id !== opts.data.id);
            saveCustomBanks(left);
            window.Drills.removeCourse(opts.data.id);
          }else{
            await window.HBMUCache.remove(opts.id);
            try{ window.Drills.removeCourse(opts.id); }catch(e){}
          }
        }catch(err){
          delBtn.textContent = '删不掉';
          return;
        }
        await renderCacheList();
      });

      box.appendChild(row);
    };

    // 学校题库
    for(const item of list){
      let nm = String(item.name || item.id || '');
      if(/^\d+$/.test(nm)) nm = '题库 ' + nm;
      const n = (item.questions || []).length;
      const ch = (item.chapters || []).length;
      const when = item.savedAt ? new Date(item.savedAt).toLocaleDateString() : '';
      mkRow({
        name: nm,
        meta: n + ' 题 · ' + ch + ' 章' + (when ? ' · ' + when : ''),
        loaded: loadedIds.has(item.id),
        id: item.id,
        custom: false,
      });
    }

    // 自建题库
    for(const c of customs){
      if(!c || !c.id) continue;
      const qs = c.questions || [];
      const withEx = qs.filter(q => q && q.ex && String(q.ex).trim()).length;
      const dupN = duplicateGroups(c).length;
      mkRow({
        name: c.name || '自建题库',
        meta: (qs.length + addsOf(c.id).length) + ' 题 · ' + (c.chapters || []).length + ' 章' +
              ' · 带解析 ' + withEx + (dupN ? ' · 重复 ' + dupN + ' 组' : '') + ' · 自建',
        loaded: loadedIds.has(c.id),
        data: c,
        custom: true,
      });
    }

    // 服务器题库（审核通过的，本地没缓存的显示「下载」）
    if(window.__SERVER__){
      try{
        const r = await api('/api/banks');
        const srv = (r && r.banks) || [];
        const cachedIds = new Set(list.map(x => String(x.id)));
        const pending = srv.filter(b => !cachedIds.has('srv-' + b.id));
        if(pending.length){
          const sep = document.createElement('div');
          sep.className = 'cache-sep';
          sep.textContent = '服务器题库（点下载才缓存到本机）';
          box.appendChild(sep);
          for(const b of pending){
            const row = document.createElement('div');
            row.className = 'cache-row';
            row.innerHTML = '<span class="nm"></span><span class="meta"></span>' +
              '<button class="load">下载</button>';
            row.querySelector('.nm').textContent = b.name;
            row.querySelector('.meta').textContent =
              (b.qcount || 0) + ' 题 · 服务器 · ' + (b.nickname || '匿名');
            row.querySelector('.load').addEventListener('click', async (ev) => {
              const btn = ev.currentTarget;
              btn.disabled = true;
              btn.textContent = '下载中…';
              try{
                const course = await fetchServerBank(b.id);
                try{ await window.HBMUCache.put(course); }catch(e){}
                window.Drills.addCourse(course);
                await renderCacheList();
              }catch(err){
                btn.textContent = '失败';
                btn.disabled = false;
              }
            });
            box.appendChild(row);
          }
        }
      }catch(e){}
    }
  }

  async function openCacheModal(){
    const m = document.getElementById('cacheModal');
    if(!m) return;
    m.dataset.open = 'true';
    await renderCacheList();
    renderCacheSubs();
  }
  function closeCacheModal(){
    const m = document.getElementById('cacheModal');
    if(m) m.dataset.open = 'false';
  }

  document.addEventListener('click', async (e) => {
    const t = e.target;
    if(!t || !t.closest) return;
    if(t.closest('#btnCache')){ openCacheModal(); return; }
    if(t.closest('#cacheClose') || t.closest('#cacheCloseBtn')){ closeCacheModal(); return; }
    if(t.closest('#cacheClearAll')){
      const btn = t.closest('#cacheClearAll');
      if(btn.dataset.armed === '1'){
        try{ await window.HBMUCache.clear(); }catch(err){}
        btn.dataset.armed = '';
        btn.textContent = '全部清除';
        await renderCacheList();
      }else{
        btn.dataset.armed = '1';
        btn.textContent = '再点一次确认';
        setTimeout(() => { btn.dataset.armed = ''; btn.textContent = '全部清除'; }, 3000);
      }
      return;
    }
    const m = document.getElementById('cacheModal');
    if(m && m.dataset.open === 'true' && t === m) closeCacheModal();
  });

  $('btnReset').addEventListener('click', () => {
    const b = $('btnReset');
    if(b.dataset.armed === '1'){
      state.ratings = {}; state.answers = {}; state.attempts = {}; state.idx = 0; state.seed = {};
      try{ localStorage.removeItem(KEY); }catch(e){}
      b.dataset.armed = ''; b.textContent = '重置全部进度';
      refresh(true);
      if(document.body.dataset.view === 'setup') renderSetup();
    } else {
      b.dataset.armed = '1'; b.textContent = '再点一次确认重置';
      setTimeout(()=>{ b.dataset.armed=''; b.textContent='重置全部进度'; }, 3200);
    }
  });
  document.querySelectorAll('[data-act="close"]').forEach(el => el.addEventListener('click', closeSheet));
  $('btnSearch').addEventListener('click', openSearch);
  $('searchInput').addEventListener('input', (e) => renderSearch(e.target.value));
  $('searchCourse').addEventListener('change', () => renderSearch($('searchInput').value));
  document.querySelectorAll('[data-act="close-search"]').forEach(el => el.addEventListener('click', closeSearch));
  $('rate').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-r]'); if(!b) return;
    rate(Number(b.dataset.r));
  });

  document.addEventListener('keydown', (e) => {
    if(e.metaKey || e.ctrlKey || e.altKey) return;
    if(e.key === 'Escape'){ closeSheet(); closeSearch(); return; }
    if(document.body.dataset.view !== 'practice') return;
    const tag = (e.target.tagName || '').toLowerCase();
    if(tag === 'input' || tag === 'textarea') return;
    if(e.key === 'ArrowRight'){ e.preventDefault(); go(1); return; }
    if(e.key === 'ArrowLeft'){ e.preventDefault(); go(-1); return; }
    if(e.key === ' ' || e.key === 'Enter'){
      if(document.activeElement && document.activeElement.tagName === 'BUTTON' && e.key === ' ') return;
      e.preventDefault();
      const q = LIST[state.idx];
      // 多选题：提交作答；单选/主观：揭示或收起答案
      if(q && q.o && q.o.length && !$('btnSubmit').hidden) $('btnSubmit').click();
      else { if($('answer').dataset.open === 'true') conceal(); else reveal(); }
      return;
    }

  });

  /* ---------- 选题页 ---------- */
  const TYPE_SHORT = {};   // 同上：题型名即标签
  

  function toggleIn(arr, v){
    const i = arr.indexOf(v);
    if(i >= 0) arr.splice(i, 1); else arr.push(v);
  }

  // 两个维度的交叉计数：章节数按已选题型算，题型数按已选章节算
  function chapterCount(name){
    let arr = QS.filter(q => q.ch === name);
    if(state.types.length) arr = arr.filter(q => state.types.includes(q.t));
    return arr.length;
  }
  function typeCount(name){
    let arr = QS.filter(q => q.t === name);
    if(state.chapters.length) arr = arr.filter(q => state.chapters.includes(q.ch));
    return arr.length;
  }

  function pickedList(){
    let arr = QS;
    if(state.chapters.length) arr = arr.filter(q => state.chapters.includes(q.ch));
    if(state.types.length) arr = arr.filter(q => state.types.includes(q.t));
    return applyRange(arr);
  }

  function renderSetup(){
    // 题库选择已移到左侧栏，这里不再渲染题库行
    const chBox = $('chipsCh');
    chBox.innerHTML = '';
    const all = document.createElement('button');
    all.type = 'button';
    all.className = 'chip chip-all';
    all.textContent = '全部章节';
    all.setAttribute('aria-pressed', state.chapters.length === 0 ? 'true' : 'false');
    all.addEventListener('click', () => { state.chapters = []; save(); renderSetup(); });
    chBox.appendChild(all);

    CHAPS.forEach(c => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.innerHTML = '<span class="t"></span><span class="c"></span>';
      b.querySelector('.t').textContent = c.name;
      const n = chapterCount(c.name);
      b.querySelector('.c').textContent = n;
      if(!n) b.classList.add('is-empty');
      b.setAttribute('aria-pressed', state.chapters.includes(c.name) ? 'true' : 'false');
      b.addEventListener('click', () => { toggleIn(state.chapters, c.name); save(); renderSetup(); });
      chBox.appendChild(b);
    });

    const tyBox = $('chipsType');
    tyBox.innerHTML = '';
    const allT = document.createElement('button');
    allT.type = 'button';
    allT.className = 'chip chip-all';
    allT.textContent = '全部题型';
    allT.setAttribute('aria-pressed', state.types.length === 0 ? 'true' : 'false');
    allT.addEventListener('click', () => { state.types = []; save(); renderSetup(); });
    tyBox.appendChild(allT);

    typesList().forEach(([name]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.innerHTML = '<span class="t"></span><span class="c"></span>';
      b.querySelector('.t').textContent = name;
      const n = typeCount(name);
      b.querySelector('.c').textContent = n;
      if(!n) b.classList.add('is-empty');
      b.setAttribute('aria-pressed', state.types.includes(name) ? 'true' : 'false');
      b.addEventListener('click', () => { toggleIn(state.types, name); save(); renderSetup(); });
      tyBox.appendChild(b);
    });

    $('chHint').textContent = state.chapters.length ? '已选 ' + state.chapters.length + ' 章' : '已选全部';
    $('typeHint').textContent = state.types.length ? '已选 ' + state.types.length + ' 种' : '已选全部';

    const n = pickedList().length;
    $('pickCount').textContent = n;
    const rangeOn = state.rangeFrom > 1 || state.rangeTo > 0;
    $('pickNote').textContent = n ? (rangeOn ? ' · 已按题号范围截取' : '') : ' · 至少选一项';
    $('btnStart').disabled = n === 0;
    // 题号范围输入框回填
    const rf = $('rangeFrom'), rt = $('rangeTo');
    if(rf && document.activeElement !== rf) rf.value = state.rangeFrom > 1 ? state.rangeFrom : '';
    if(rt && document.activeElement !== rt) rt.value = state.rangeTo > 0 ? state.rangeTo : '';

    const resume = $('btnResume');
    const rated = Object.keys(state.ratings).length;
    if(rated > 0 && n > 0){
      resume.hidden = false;
      resume.textContent = '继续上次 · 已做 ' + rated + ' 题';
    } else {
      resume.hidden = true;
    }
  }

  function showSetup(){
    state.listKind = '';
    document.body.dataset.view = 'setup';
    if (window.__syncBg) window.__syncBg();
    LIST = pickedList();
    renderChrome();
    renderSheet();
    renderSetup();
  }

  function startPractice(resume){
    document.body.dataset.view = 'practice';
    if (window.__syncBg) window.__syncBg();
    if(!resume){ state.idx = 0; state.round = { n: 0, ok: 0 }; }
    refresh(true);
  }

  $('btnStart').addEventListener('click', () => startPractice(false));
  $('btnResume').addEventListener('click', () => startPractice(true));
  $('btnSetup').addEventListener('click', showSetup);

  /* ---------- 07 api · 预留扩展点 ---------- */
  const HOOKS = { rate: [], course: [], theme: [], view: [], list: [] };
  function emit(name, payload){
    const fns = HOOKS[name];
    if(!fns || !fns.length) return;
    for(const fn of fns){
      try{ fn(payload); }catch(e){ console.warn('[drills] hook "' + name + '" failed', e); }
    }
  }

  const BANK_PROMPT = '\n你是题库整理助手。请把用户给出的题目内容，整理成下面这种严格的 JSON 格式。\n\n**只输出 JSON，不要有任何解释文字，不要用 markdown 代码块包裹。**\n\n## 输出格式\n\n{\n  "format": "hebmu-bank-v1",\n  "name": "题库名称",\n  "questions": [\n    {\n      "chapter": "章节名称",\n      "type": "A1型题",\n      "stem": "题干正文",\n      "options": ["A. 选项一", "B. 选项二", "C. 选项三", "D. 选项四"],\n      "answer": "A"\n    }\n  ]\n}\n\n## 字段规则\n\n1. `format` 固定写 `"hebmu-bank-v1"`\n2. `name` 是题库名称，例如 `"药理学自建题库1"`\n3. `questions` 是题目数组，每题一个对象\n\n4. `chapter`：章节名称\n   - 原文有章节标题就照抄（如"第一章 绪论"）\n   - 没有章节就写 `"未分类"`\n\n5. `type`：题型，只能从下面选一个：\n   `A1型题` `A2型题` `A3型题` `A4型题` `B1型题` `C型题` `K型题` `X型题`\n   `判断题` `填空题` `名词解释题` `简答题` `论述题` `病例分析题` `综合题`\n\n6. `stem`：题干正文\n   - 不要包含选项\n   - 不要包含题号\n   - 原文里的换行保留，用 `\\n`\n\n7. `options`：选择题必填，字符串数组\n   - 每项格式：`"A. 选项内容"`（大写字母 + 英文句点 + 空格 + 内容）\n   - 非选择题（简答/论述/名词解释/判断/填空）不要写这个字段，或写 `[]`\n\n8. `answer`：标准答案\n   - 单选题：一个字母，如 `"A"`\n   - 多选题：多个字母用英文逗号分隔，如 `"A,C,D"`\n   - 判断题：`"对"` 或 `"错"`\n   - 主观题：参考答案全文（多行用 `\\n`）\n\n## 质量要求\n\n- 不要编造原文没有的题目\n- 不要合并或拆分题目\n- 数字、单位、符号照原文抄\n- 输出必须是合法 JSON（能被 `JSON.parse` 直接解析）\n';

  // 解析字段的补充说明（追加在提示词后面，避免改动原长字符串）
  const BANK_EX_PART = '\n## 解析字段（explanation）\n\n- 每道题可以带一个 `explanation` 字段，填这道题的解析。\n- **原文有解析就照抄；没有就写空字符串 `""`，不要自己编。**\n- 解析写清楚：这题考什么、为什么选这个、其它选项错在哪。\n';

  function bankPrompt(){ return BANK_PROMPT + BANK_EX_PART; }

  const CUSTOM_KEY = 'hbmu_custom_banks';

  function loadCustomBanks(){
    try{
      const raw = localStorage.getItem(CUSTOM_KEY);
      if(!raw) return [];
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    }catch(e){ return []; }
  }
  function saveCustomBanks(list){
    try{ localStorage.setItem(CUSTOM_KEY, JSON.stringify(list)); }catch(e){}
  }

  // 把外部格式转成内部题库结构
  function bankToCourse(raw){
    if(!raw || !Array.isArray(raw.questions) || !raw.questions.length)
      throw new Error('缺少 questions 数组，或者题目为空');

    const name = String(raw.name || '自建题库').slice(0, 40);
    const cid = 'custom-' + Date.now().toString(36);
    const qs = [];
    let n = 0;

    for(const item of raw.questions){
      if(!item || !item.stem) continue;
      n += 1;
      const ch = String(item.chapter || '未分类').trim() || '未分类';
      const given = String(item.type || '').trim();
      // 没写题型、或者写的和答案对不上，就按答案形状推断
      const guess = inferQuestion(item);
      const t = given || guess.t;
      const isChoiceType = /A1型题|A2型题|A3型题|A4型题|B1型题|C型题|K型题|X型题|判断题/.test(t);
      let atid = isChoiceType ? atidByType(t) : (given ? '6' : guess.atid);
      const answerStr = Array.isArray(item.answer) ? item.answer.join(' / ') : String(item.answer == null ? '' : item.answer);
      // 答案是多字母（如 "A,C"）时按多选处理，即使题型写的是单选
      if(String(answerStr).replace(/[^A-Za-z]/g, '').length > 1) atid = '1';
      const opts = Array.isArray(item.options)
        ? item.options.map((o, i) => {
            const str = String(o);
            const m = str.match(/^\s*([A-Za-z])[\.、\)]\s*(.*)$/);
            return m ? (m[1].toUpperCase() + '. ' + m[2].trim())
                     : (String.fromCharCode(65 + i) + '. ' + str.trim());
          }).filter(Boolean)
        : [];
      // 判断题没写选项时补「对 / 错」
      if(t === '判断题' && !opts.length){ opts.push('A. 对', 'B. 错'); }
      const blank = Array.isArray(item.answer) && (guess.blank || /填空题/.test(t))
        ? item.answer.map(String)
        : (guess.blank || null);
      qs.push({
        id: cid + '-q' + n,
        ch,
        t,
        atid,
        q: String(item.stem),
        a: String(answerStr),
        o: opts,
        ex: String(item.explanation || ''),
        ...(blank && blank.length ? { blank } : {}),
      });
    }

    if(!qs.length) throw new Error('没有解析到有效题目');

    const order = [];
    for(const q of qs) if(!order.includes(q.ch)) order.push(q.ch);
    const chapters = order.map(ch => ({ name: ch, n: qs.filter(q => q.ch === ch).length }));
    const groups = {};
    for(const q of qs) groups[q.t] = (groups[q.t] || 0) + 1;

    return { id: cid, name, chapters, groups, questions: qs };
  }

  function openBankModal(){
    const m = document.getElementById('bankModal');
    if(!m) return;
    const ta = document.getElementById('bankPrompt');
    if(ta && !ta.value) ta.value = bankPrompt();
    m.dataset.open = 'true';
  }
  function closeBankModal(){
    const m = document.getElementById('bankModal');
    if(m) m.dataset.open = 'false';
  }

  function bankMsg(text, kind){
    const el = document.getElementById('bankMsg');
    if(!el) return;
    el.textContent = text || '';
    el.className = 'bank-msg' + (kind ? ' ' + kind : '');
  }

  function doImportBank(){
    const ta = document.getElementById('bankJson');
    if(!ta || !ta.value.trim()){ bankMsg('先把 JSON 粘进来', 'err'); return; }
    let raw;
    try{ raw = JSON.parse(ta.value.trim()); }
    catch(e){ bankMsg('JSON 解析失败：' + e.message, 'err'); return; }

    let course;
    try{ course = bankToCourse(raw); }
    catch(e){ bankMsg(e.message, 'err'); return; }

    // 已存在同名题库则覆盖
    const list = loadCustomBanks();
    const idx = list.findIndex(c => c.name === course.name);
    if(idx >= 0) list[idx] = course; else list.push(course);
    saveCustomBanks(list);

    try{ window.Drills.addCourse(course); }
    catch(e){
      // 如果运行时已有同 id（罕见），直接刷新列表
      renderChrome();
    }

    // 重复题检测：同一道题在文件里出现多次
    const dup = duplicateGroups(course);
    const dupN = dup.reduce((s, g) => s + g.length - 1, 0);
    bankMsg('导入成功：' + course.name + ' · ' + course.questions.length + ' 题' +
            (dup.length ? ' · 检测到 ' + dup.length + ' 组重复（多出 ' + dupN + ' 题）' : ''), 'ok');
    ta.value = '';
    setTimeout(() => { closeBankModal(); renderChrome(); }, 700);
  }

  // 提交到讨论服务器，等管理员审核
  async function submitBankToServer(){
    const ta = document.getElementById('bankJson');
    if(!ta || !ta.value.trim()){ bankMsg('先把 JSON 粘进来', 'err'); return; }

    if(!window.__SERVER__){ bankMsg('还没配服务器地址', 'err'); return; }
    if(!ME){ bankMsg('请先在右上角登录后再提交', 'err'); return; }

    let raw;
    try{ raw = JSON.parse(ta.value.trim()); }
    catch(e){ bankMsg('JSON 解析失败：' + e.message, 'err'); return; }
    if(!raw || !Array.isArray(raw.questions) || !raw.questions.length){
      bankMsg('题库格式不对：缺少 questions', 'err'); return;
    }

    const btn = document.getElementById('bankSubmit');
    if(btn) btn.disabled = true;
    bankMsg('提交中…');

    try{
      const r = await api('/api/banks', { method: 'POST', body: JSON.stringify({ bank: raw }) });
      bankMsg('已提交，等管理员审核（编号 ' + (r.id || '?') + '）', 'ok');
      ta.value = '';
    }catch(e){
      bankMsg('提交失败：' + ((e && e.message) || e), 'err');
    }finally{
      if(btn) btn.disabled = false;
    }
  }

  document.addEventListener('click', (e) => {
    const t = e.target;
    if(!t || !t.closest) return;
    if(t.closest('#bankClose')){ closeBankModal(); return; }
    const tab = t.closest('#bankTabs button');
    if(tab){
      const which = tab.dataset.t;
      [...document.querySelectorAll('#bankTabs button')].forEach(b =>
        b.setAttribute('aria-pressed', b === tab ? 'true' : 'false'));
      const p1 = document.getElementById('panePrompt');
      const p2 = document.getElementById('paneImport');
      if(p1) p1.hidden = which !== 'prompt';
      if(p2) p2.hidden = which !== 'import';
      return;
    }
    if(t.closest('#copyPrompt')){
      const ta = document.getElementById('bankPrompt');
      if(!ta) return;
      ta.select();
      try{ document.execCommand('copy'); bankMsg('已复制'); }
      catch(err){ bankMsg('复制失败，请手动选中复制', 'err'); }
      return;
    }
    if(t.closest('#bankImport')){ doImportBank(); return; }
    if(t.closest('#bankSubmit')){ submitBankToServer(); return; }
    const m = document.getElementById('bankModal');
    if(m && m.dataset.open === 'true' && t === m) closeBankModal();
  });

  document.addEventListener('change', (e) => {
    const inp = e.target;
    if(!inp || inp.id !== 'bankFile') return;
    const f = inp.files && inp.files[0];
    if(!f) return;
    const nameEl = document.getElementById('bankFileName');
    if(nameEl) nameEl.textContent = f.name;
    const reader = new FileReader();
    reader.onload = () => {
      const ta = document.getElementById('bankJson');
      if(ta) ta.value = String(reader.result || '');
      bankMsg('文件已读入，点「导入」');
    };
    reader.readAsText(f, 'utf-8');
  });

  // 启动时把本机保存的自建题库加回来
  function restoreCustomBanks(){
    const list = loadCustomBanks();
    for(const c of list){
      if(!c || !c.id || !Array.isArray(c.questions)) continue;
      if(COURSES.some(x => x.id === c.id)) continue;
      COURSES.push(c);
    }
  }

  // 立即恢复：让自建题库在第一次渲染时就出现在侧栏
  restoreCustomBanks();

  // 从服务器拉某个题库的完整内容（不自动加载，等用户点）
  async function fetchServerBank(serverId){
    const r = await api('/api/banks/' + serverId);
    if(!r || !r.bank) throw new Error('服务器上没有这个题库');
    const course = bankToCourse(r.bank);
    course.id = 'srv-' + serverId;
    course.name = r.name || course.name;
    course.__server = serverId;
    return course;
  }

  // 点开服务器题库时按需拉内容
  async function ensureServerCourse(courseId){
    const c = COURSES.find(x => x.id === courseId);
    if(!c || !c.__server) return true;
    if(c.questions && c.questions.length) return true;
    try{
      const r = await api('/api/banks/' + c.__server);
      if(!r || !r.bank) return false;
      const full = bankToCourse(r.bank);
      // 沿用服务器 id，避免重复
      full.id = courseId;
      full.name = r.name || full.name;
      c.chapters = full.chapters;
      c.groups = full.groups;
      c.questions = full.questions;
      return true;
    }catch(e){ return false; }
  }

  // 服务器题库不自动加载，统一在「题库缓存」里按需下载

  window.Drills = {
    version: 3,

    /* 数据 */
    get course(){ return currentCourse(); },
    get courses(){ return COURSES.slice(); },
    chapters(){ return CHAPS.slice(); },
    types(){ return typesList(); },
    questions(){ return QS.slice(); },

    /* 运行时追加题库：{ id, name, chapters, groups, questions } */
    addCourse(course){
      if(!course || !course.id || !Array.isArray(course.questions))
        throw new Error('Drills.addCourse: 需要 course.id 与 course.questions');
      if(COURSES.some(c => c.id === course.id))
        throw new Error('Drills.addCourse: 题库 id 重复 "' + course.id + '"');
      COURSES.push(course);
      setCourse(state.courseId);
      renderChrome();
      if(document.body.dataset.view === 'setup') renderSetup();
      emit('course', { action: 'add', id: course.id });
      return course.id;
    },

    selectCourse(id){
      if(!COURSES.some(c => c.id === id)) throw new Error('Drills.selectCourse: 无此题库 "' + id + '"');
      switchCourse(id);
    },

    /* 从左侧列表移除一个题库（只影响内存，缓存由调用方处理） */
    removeCourse(id){
      const idx = COURSES.findIndex(c => c.id === id);
      if(idx < 0) return false;
      if(COURSES.length <= 1) throw new Error('不能删掉最后一个题库');
      COURSES.splice(idx, 1);
      if(state.courseId === id){
        state.courseId = COURSES[0].id;
        setCourse(state.courseId);
      }else{
        renderChrome();
      }
      emit('course', { action: 'remove', id });
      return true;
    },

    /* 查询 */
    stats(){
      const c = counts();
      return {
        course: state.courseId, total: c.total,
        done: c.done, fuzzy: c.fuzzy, bad: c.bad, todo: c.todo,
        stars: Object.keys(state.stars).length,
      };
    },

    /* 记录 */
    export(){ return localStorage.getItem(KEY) || '{}'; },
    import(json){
      const raw = typeof json === 'string' ? json : JSON.stringify(json);
      const data = JSON.parse(raw);
      if(!data || typeof data !== 'object') throw new Error('Drills.import: 数据格式不对');
      localStorage.setItem(KEY, JSON.stringify(data));
      location.reload();
    },
    reset(){ localStorage.removeItem(KEY); location.reload(); },

    /* 事件订阅：rate / course / theme / view / list，返回取消函数 */
    on(event, fn){
      if(!HOOKS[event]) throw new Error('Drills.on: 未知事件 "' + event + '"（rate|course|theme|view|list）');
      HOOKS[event].push(fn);
      return () => {
        const i = HOOKS[event].indexOf(fn);
        if(i >= 0) HOOKS[event].splice(i, 1);
      };
    },
  };

  /* ---------- 解析（wiki，做完这题才出现） ---------- */
  const EX_CACHE = {};
  let EX = null;                 // { q, data }
  const exKey = (courseId, k) => courseId + '|' + k;

  // 本机解析缓存：断网 / 服务器没更新时也能看上次拉到的解析
  const EX_STORE = 'hbmu_ex_cache';
  const EX_STORE_MAX = 800;

  function loadExStore(){
    try{
      const raw = localStorage.getItem(EX_STORE);
      const o = raw ? JSON.parse(raw) : {};
      return (o && typeof o === 'object') ? o : {};
    }catch(e){ return {}; }
  }

  function saveExStore(m){
    try{
      localStorage.setItem(EX_STORE, JSON.stringify(m));
    }catch(e){
      // 存不下就丢掉一半老记录再试一次
      try{
        const keys = Object.keys(m).sort((a, b) => (m[a].savedAt || 0) - (m[b].savedAt || 0));
        keys.slice(0, Math.ceil(keys.length / 2)).forEach(k => { delete m[k]; });
        localStorage.setItem(EX_STORE, JSON.stringify(m));
      }catch(e2){}
    }
  }

  function exCacheGet(courseId, k){
    const m = loadExStore();
    return m[courseId + '|' + k] || null;
  }

  function exCachePut(courseId, k, data){
    if(!data || !data.body) return;
    const m = loadExStore();
    m[courseId + '|' + k] = {
      body: data.body,
      version: data.version || 1,
      editorNick: data.editorNick || '',
      updatedAt: data.updatedAt || Date.now(),
      savedAt: Date.now(),
    };
    const keys = Object.keys(m);
    if(keys.length > EX_STORE_MAX){
      keys.sort((a, b) => (m[a].savedAt || 0) - (m[b].savedAt || 0))
        .slice(0, keys.length - EX_STORE_MAX)
        .forEach(x => { delete m[x]; });
    }
    saveExStore(m);
  }

  function isDoneLocal(q){
    return !!(q && (state.answers[q.id] || state.ratings[q.id] !== undefined));
  }

  function exMsg(text, kind){
    const el = $('exMsg');
    if(!el) return;
    el.textContent = text || '';
    el.className = 'explain-msg' + (kind ? ' ' + kind : '');
  }

  function hideExplain(){
    const box = $('explain');
    if(box) box.hidden = true;
    EX = null;
  }

  function renderExplain(data, q){
    const box = $('explain');
    if(!box || !data) return;
    EX = { q, data };

    const localEx = (q && q.ex) ? String(q.ex) : '';
    const body = data.body || localEx;

    box.hidden = false;
    renderRichText($('exBody'), body, q);   // 解析里可以写 {{OPT:n}} 引用选项
    const emptyEl = $('exEmpty');
    emptyEl.hidden = !!body;
    if(!body) emptyEl.textContent = data.offline ? '连不上解析服务（服务器可能还没更新）' : '还没有解析，来做第一个写的人。';
    $('exVer').textContent = data.version ? ('第 ' + data.version + ' 版') : '';

    const bits = [];
    if(data.cached) bits.push('本机缓存');
    if(data.body && data.editorNick) bits.push('最后由 ' + data.editorNick + ' 修改');
    if(data.body && data.updatedAt) bits.push(fmtTime(data.updatedAt));
    if(!data.body && localEx) bits.push('题库自带解析');
    if(!data.body && !localEx && !data.offline) bits.push('还没有人写');
    if(data.offline) bits.push('解析服务连不上');
    if(!data.canEdit && !data.offline) bits.push('登录后才可编辑');
    $('exMeta').textContent = bits.join(' · ');

    $('exEdit').hidden = !data.canEdit;
    $('exEdit').textContent = data.body ? '编辑' : (localEx ? '改写为共享解析' : '写解析');
    $('exHistory').hidden = !data.version;
    $('exDelete').hidden = !data.canDelete;
    $('exForm').hidden = true;
    exMsg('');
  }

  // 离线：优先本机缓存，其次题库自带解析
  function renderOffline(q){
    const hit = exCacheGet(state.courseId, q.k);
    renderExplain({
      body: (hit && hit.body) || '',
      version: (hit && hit.version) || 0,
      attempted: true, mine: false, canEdit: false, canDelete: false,
      editorNick: (hit && hit.editorNick) || '',
      updatedAt: (hit && hit.updatedAt) || 0,
      offline: true, cached: !!hit,
    }, q);
  }

  async function refreshExplain(q){
    if(!q){ hideExplain(); return; }
    if(!ONLINE){ renderOffline(q); return; }
    const k = exKey(state.courseId, q.k);
    if(EX_CACHE[k]) renderExplain(EX_CACHE[k], q);

    try{
      const r = await api('/api/explanation?course=' + encodeURIComponent(state.courseId) +
                          '&qkey=' + encodeURIComponent(q.k));
      if(LIST[state.idx] !== q) return;                 // 已经切题
      // 做完这题才出现；背题模式直接给看
      if(state.mode !== 'recite' && !r.attempted && !isDoneLocal(q)){ hideExplain(); return; }
      EX_CACHE[k] = r;
      if(r.body) exCachePut(state.courseId, q.k, r);
      renderExplain(r, q);
    }catch(e){
      // 服务器没更新 / 断网：本机缓存 > 题库自带解析（背题模式直接给看）
      if(isDoneLocal(q) || state.mode === 'recite' || exCacheGet(state.courseId, q.k)){
        renderOffline(q);
      }else{
        hideExplain();
      }
    }
  }

  // 做完这题才出现：未登录按本机作答记录判断，登录还可以靠服务器记录（换设备也一致）
  function syncExplain(q){
    if(!q){ hideExplain(); return; }
    // 学校题库的解析本期不做
    if(isSchoolCourse(currentCourse())){ hideExplain(); return; }
    const done = isDoneLocal(q);
    const recite = state.mode === 'recite';   // 背题模式不拦
    if(!done && !ME && !recite){ hideExplain(); return; }
    if(!ONLINE){
      // 没有服务器（或没配）：只显示本机缓存 / 题库自带的
      if(done || recite || exCacheGet(state.courseId, q.k)) renderOffline(q);
      else hideExplain();
      return;
    }
    refreshExplain(q);
  }

  function openExEditor(){
    if(!EX || !EX.data) return;
    if(!EX.data.canEdit){ exMsg('登录后才能编辑', 'err'); return; }
    $('exInput').value = EX.data.body || (EX.q && EX.q.ex) || '';
    $('exForm').hidden = false;
    exMsg('');
    setTimeout(() => $('exInput').focus(), 50);
  }

  async function saveEx(){
    if(!EX || !EX.q) return;
    const body = $('exInput').value.trim();
    if(!body){ exMsg('解析不能为空', 'err'); return; }
    const btn = $('exSave');
    btn.disabled = true;
    exMsg('保存中…');
    try{
      await api('/api/explanation', {
        method: 'POST',
        body: JSON.stringify({ course: state.courseId, qkey: EX.q.k, body }),
      });
      delete EX_CACHE[exKey(state.courseId, EX.q.k)];
      const q = EX.q;
      await refreshExplain(q);
      exMsg('已保存', 'ok');
    }catch(e){
      exMsg(e.message || '保存失败', 'err');
    }finally{
      btn.disabled = false;
    }
  }

  async function deleteEx(){
    if(!EX || !EX.q) return;
    const btn = $('exDelete');
    if(btn.dataset.armed !== '1'){
      btn.dataset.armed = '1';
      btn.textContent = '确认删除?';
      setTimeout(() => {
        if(btn.dataset.armed === '1'){ btn.dataset.armed = ''; btn.textContent = '删除'; }
      }, 3000);
      return;
    }
    btn.dataset.armed = '';
    btn.textContent = '删除';
    try{
      await api('/api/explanation/delete', {
        method: 'POST',
        body: JSON.stringify({ course: state.courseId, qkey: EX.q.k }),
      });
      delete EX_CACHE[exKey(state.courseId, EX.q.k)];
      await refreshExplain(EX.q);
    }catch(e){
      exMsg(e.message || '删除失败', 'err');
    }
  }

  async function openHist(){
    if(!EX || !EX.q) return;
    const box = $('histList');
    box.innerHTML = '';
    const loading = document.createElement('div');
    loading.className = 'addq-local-empty';
    loading.textContent = '加载中…';
    box.appendChild(loading);
    $('histModal').dataset.open = 'true';
    try{
      const r = await api('/api/explanation/history?course=' + encodeURIComponent(state.courseId) +
                          '&qkey=' + encodeURIComponent(EX.q.k));
      const vs = (r && r.versions) || [];
      box.innerHTML = '';
      if(!vs.length){
        const e = document.createElement('div');
        e.className = 'addq-local-empty';
        e.textContent = '还没有历史版本';
        box.appendChild(e);
        return;
      }
      for(const v of vs){
        const it = document.createElement('div');
        it.className = 'hist-item';
        it.innerHTML = '<div class="h-top"><span class="h-v"></span><b></b><span class="h-t"></span></div>' +
                       '<div class="h-txt"></div>';
        it.querySelector('.h-v').textContent = 'v' + v.version;
        it.querySelector('b').textContent = v.editor_nick || '匿名';
        it.querySelector('.h-t').textContent = (v.editor_verified ? '已认证 · ' : '') + fmtTime(v.created_at);
        it.querySelector('.h-txt').textContent = v.body || '';
        box.appendChild(it);
      }
    }catch(e){
      box.innerHTML = '';
      const err = document.createElement('div');
      err.className = 'addq-local-empty';
      err.textContent = '历史加载失败';
      box.appendChild(err);
    }
  }

  // 上报「做过了」，给登录用户跨设备判断用
  function markDone(q){
    if(!ONLINE || !ME || !q || !q.k) return;
    api('/api/done', { method: 'POST', body: JSON.stringify({ course: state.courseId, qkey: q.k }) })
      .catch(() => {});
  }

  /* ---------- 新增题目 ---------- */
  const UPLOAD_ON = false;        // 上传开关：先关着
  const ADD_TYPES = ['A1型题','A2型题','A3型题','A4型题','B1型题','C型题','K型题','X型题',
    '判断题','填空题','名词解释题','简答题','论述题','病例分析题','综合题','中英互译','填图题','读图题','视频题'];
  const SUB_STATUS = { pending: '待审核', approved: '已通过', rejected: '已拒绝', withdrawn: '已撤回' };

  const atidOfType = (t) => atidByType(String(t || ''));

  const ADDQ = { mode: 'text', items: [] };

  function addqMsg(text, kind){
    const el = $('addqMsg');
    if(!el) return;
    el.textContent = text || '';
    el.className = 'addq-msg' + (kind ? ' ' + kind : '');
  }

  const isSchoolCourse = (c) => /^\d+$/.test(String(c && c.id));

  function addqCourseList(){
    return COURSES.filter(c => !isSchoolCourse(c));
  }

  function addqChapterNames(){
    const cid = $('addqCourse').value;
    const course = COURSES.find(c => c.id === cid);
    const names = [];
    const base = course && course.id === state.courseId ? CHAPS : ((course && course.chapters) || []);
    base.forEach(ch => { if(!names.includes(ch.name)) names.push(ch.name); });
    addsOf(cid).forEach(a => { if(!names.includes(a.ch)) names.push(a.ch); });
    if(!names.length) names.push('未分类');
    return names;
  }

  function fillAddqCourses(){
    const sel = $('addqCourse');
    const list = addqCourseList();
    sel.innerHTML = '';
    if(!list.length){
      const o = document.createElement('option');
      o.value = '';
      o.textContent = '没有可加题的题库（学校题库不支持加题）';
      sel.appendChild(o);
      return;
    }
    for(const c of list){
      const o = document.createElement('option');
      o.value = c.id;
      o.textContent = c.name + (c.__server ? '（服务器）' : '（自建）');
      sel.appendChild(o);
    }
    if(state.courseId && list.some(c => c.id === state.courseId)) sel.value = state.courseId;
    fillAddqChapters();
  }

  function fillAddqChapters(){
    const sel = $('addqChapter');
    const names = addqChapterNames();
    const prev = sel.value;
    sel.innerHTML = '';
    names.forEach(n => {
      const o = document.createElement('option');
      o.value = n;
      o.textContent = n;
      sel.appendChild(o);
    });
    if(names.includes(prev)) sel.value = prev;
  }

  function fillAddqTypes(){
    const sel = $('addqType');
    if(sel.options.length) return;
    ADD_TYPES.forEach(t => {
      const o = document.createElement('option');
      o.value = t;
      o.textContent = t;
      sel.appendChild(o);
    });
  }

  function setAddqMode(mode){
    ADDQ.mode = mode;
    $('addqTabs').querySelectorAll('button').forEach(b =>
      b.setAttribute('aria-pressed', b.dataset.m === mode ? 'true' : 'false'));
    $('addqPaneText').hidden = mode !== 'text';
    $('addqPaneForm').hidden = mode !== 'form';
    $('addqPaneJson').hidden = mode !== 'json';
  }

  function normAnswer(s){
    return String(s || '').toUpperCase()
      .replace(/[^A-Z,，\s、]/g, '')
      .split(/[,，\s、]+/).filter(Boolean)
      .filter((v, i, a) => a.indexOf(v) === i)
      .sort().join(',');
  }

  function splitBlocks(text){
    const t = String(text || '').replace(/\r\n?/g, '\n');
    let blocks = t.split(/\n\s*\n+/).map(x => x.trim()).filter(Boolean);
    if(blocks.length <= 1){
      const byNum = t.split(/(?=^\s*\d+\s*[.、．)）]\s+)/m).map(x => x.trim()).filter(Boolean);
      if(byNum.length > 1) blocks = byNum;
    }
    return blocks;
  }

  function parseOneBlock(block, defaultType){
    let text = String(block || '').replace(/\r\n?/g, '\n').trim();
    if(!text) return null;

    let answer = '';
    const am = text.match(/^\s*(?:答案|参考答案|正确答案|答)\s*[:：]\s*(.+)$/m);
    if(am){ answer = am[1].trim(); text = text.replace(am[0], ''); }

    let explanation = '';
    const em = text.match(/^\s*(?:解析|答案解析|分析)\s*[:：]\s*([\s\S]*)$/m);
    if(em){ explanation = em[1].trim(); text = text.replace(em[0], ''); }

    const optText = text.replace(/[ \t]+([A-Ea-e])[.、．)）]\s*/g, '\n$1. ');
    const lines = optText.split('\n');
    const opts = [];
    for(const line of lines){
      const m = line.match(/^\s*([A-Ea-e])[.、．)）]\s*(.+)$/);
      if(m) opts.push(m[1].toUpperCase() + '. ' + m[2].trim());
    }
    const stemLines = lines.filter(l => !/^\s*[A-Ea-e][.、．)）]\s+.+$/.test(l));
    let stem = stemLines.join('\n').trim().replace(/^\s*\d+\s*[.、．)）]\s*/, '').trim();
    if(!stem && !opts.length) return null;

    const type = defaultType || 'A1型题';
    return {
      stem,
      options: opts,
      answer: opts.length ? normAnswer(answer) : answer,
      explanation,
      type,
      atid: atidOfType(type),
      checked: true,
    };
  }

  function itemsFromText(text){
    const type = $('addqType').value || 'A1型题';
    const out = [];
    for(const b of splitBlocks(text)){
      const it = parseOneBlock(b, type);
      if(it) out.push(it);
    }
    return out;
  }

  function itemsFromForm(){
    const stem = $('addqStem').value.trim();
    if(!stem){ addqMsg('题干不能为空', 'err'); return []; }
    const type = $('addqType').value || 'A1型题';
    const opts = [...$('addqOpts').querySelectorAll('input')]
      .map((inp, i) => inp.value.trim() ? (String.fromCharCode(65 + i) + '. ' + inp.value.trim()) : '')
      .filter(Boolean);
    return [{
      stem,
      options: opts,
      answer: opts.length ? normAnswer($('addqAnswer').value) : $('addqAnswer').value.trim(),
      explanation: $('addqEx').value.trim(),
      type,
      atid: atidOfType(type),
      checked: true,
    }];
  }

  function itemsFromJson(raw){
    const arr = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.questions) ? raw.questions : null);
    if(!arr || !arr.length) throw new Error('没有 questions 数组，或者题目为空');
    const out = [];
    for(const q of arr){
      if(!q || !q.stem) continue;
      const guess = inferQuestion(q);
      const type = String(q.type || guess.t);
      const opts = (Array.isArray(q.options) ? q.options : []).map((o, i) => {
        const s = String(o);
        const m = s.match(/^\s*([A-Za-z])[.、)）]\s*(.*)$/);
        return m ? (m[1].toUpperCase() + '. ' + m[2].trim())
                 : (String.fromCharCode(65 + i) + '. ' + s.trim());
      }).filter(Boolean);
      const answerRaw = q.answer;
      const answerStr = Array.isArray(answerRaw) ? answerRaw.join(' / ') : String(answerRaw == null ? '' : answerRaw);
      const blank = (guess.blank && guess.blank.length)
        ? guess.blank
        : (Array.isArray(answerRaw) && /填空题/.test(type) ? answerRaw.map(String) : null);
      out.push({
        stem: String(q.stem),
        options: opts,
        answer: answerStr,
        explanation: String(q.explanation || ''),
        type,
        atid: atidByType(type),
        chapter: q.chapter ? String(q.chapter) : '',
        checked: true,
        ...(blank ? { blank } : {}),
      });
    }
    if(!out.length) throw new Error('没有解析到有效题目');
    return out;
  }

  function addqFiltered(){
    const t = $('addqTypeFilter').value;
    return t ? ADDQ.items.filter(i => i.type === t) : ADDQ.items;
  }

  function updateAddqCount(){
    const picked = ADDQ.items.filter(i => i.checked).length;
    $('addqCount').textContent = '合计 ' + ADDQ.items.length + ' 题，已选 ' + picked + ' 题';
  }

  function renderAddqPreview(){
    const box = $('addqPreview');
    if(!ADDQ.items.length){
      box.hidden = true;
      $('addqPvList').innerHTML = '';
      return;
    }
    box.hidden = false;

    const sel = $('addqTypeFilter');
    const prev = sel.value;
    const types = [];
    ADDQ.items.forEach(i => { if(!types.includes(i.type)) types.push(i.type); });
    sel.innerHTML = '';
    const all = document.createElement('option');
    all.value = '';
    all.textContent = '全部题型';
    sel.appendChild(all);
    types.forEach(t => {
      const o = document.createElement('option');
      o.value = t;
      o.textContent = t + '（' + ADDQ.items.filter(i => i.type === t).length + '）';
      sel.appendChild(o);
    });
    if(types.includes(prev)) sel.value = prev;

    const listBox = $('addqPvList');
    listBox.innerHTML = '';
    const names = addqChapterNames();
    const defCh = $('addqChapter').value || names[0];

    ADDQ.items.forEach((it, i) => {
      if(sel.value && it.type !== sel.value) return;

      const row = document.createElement('div');
      row.className = 'addq-pv-item';
      row.dataset.off = it.checked ? '0' : '1';
      row.innerHTML =
        '<input type="checkbox">' +
        '<div class="addq-pv-main"><div class="addq-pv-stem"></div>' +
          '<div class="addq-pv-sub"><span class="addq-pv-type"></span>' +
          '<select class="addq-pv-ch"></select><span class="addq-pv-n"></span></div></div>' +
        '<button type="button" class="addq-pv-del" title="删掉">×</button>';

      row.querySelector('.addq-pv-stem').textContent = it.stem.slice(0, 160);
      row.querySelector('.addq-pv-type').textContent = it.type;
      row.querySelector('.addq-pv-n').textContent = it.answer ? ('答案 ' + it.answer) : '无答案';

      const cb = row.querySelector('input[type="checkbox"]');
      cb.checked = !!it.checked;
      cb.addEventListener('change', () => {
        it.checked = cb.checked;
        row.dataset.off = it.checked ? '0' : '1';
        updateAddqCount();
      });

      const chSel = row.querySelector('.addq-pv-ch');
      names.forEach(n => {
        const o = document.createElement('option');
        o.value = n;
        o.textContent = n;
        chSel.appendChild(o);
      });
      chSel.value = it.chapter && names.includes(it.chapter) ? it.chapter : defCh;
      it.chapter = chSel.value;
      chSel.addEventListener('change', () => { it.chapter = chSel.value; });

      row.querySelector('.addq-pv-del').addEventListener('click', () => {
        ADDQ.items.splice(i, 1);
        renderAddqPreview();
      });

      listBox.appendChild(row);
    });

    updateAddqCount();
  }

  function renderAddqLocal(){
    const box = $('addqLocalList');
    if(!box) return;
    const cid = $('addqCourse').value;
    const list = addsOf(cid);
    $('addqLocalN').textContent = list.length;
    box.innerHTML = '';
    if(!list.length){
      box.innerHTML = '<div class="addq-local-empty">这个题库还没有本机新增的题</div>';
      return;
    }
    list.slice().reverse().forEach(a => {
      const row = document.createElement('div');
      row.className = 'addq-local-row';
      row.innerHTML = '<span class="t"></span><span class="s"></span><span class="c"></span><button class="d">删除</button>';
      row.querySelector('.t').textContent = a.t || '题';
      row.querySelector('.s').textContent = String(a.q || '').slice(0, 60);
      row.querySelector('.c').textContent = a.ch || '';
      row.querySelector('.d').addEventListener('click', () => {
        saveAdds(loadAdds().filter(x => x.id !== a.id));
        renderAddqLocal();
        if(state.courseId === a.courseId) refreshCourse();
        addqMsg('已删除', 'ok');
      });
      box.appendChild(row);
    });
  }

  function openAddq(){
    $('addqModal').dataset.open = 'true';
    $('addqText').value = '';
    $('addqStem').value = '';
    $('addqAnswer').value = '';
    $('addqEx').value = '';
    $('addqJson').value = '';
    $('addqFileName').textContent = '未选择';
    $('addqNewChapter').value = '';
    $('addqNewChapter').hidden = true;
    ADDQ.items = [];
    setAddqMode('text');
    fillAddqTypes();
    fillAddqCourses();
    fillAddqOpts(4);
    renderAddqPreview();
    renderAddqLocal();
    addqMsg('');
  }

  function closeAddq(){ $('addqModal').dataset.open = 'false'; }

  function fillAddqOpts(n){
    const box = $('addqOpts');
    if(!box) return;
    box.innerHTML = '';
    for(let i = 0; i < (n || 4); i++) addOptRow();
  }

  function addOptRow(){
    const box = $('addqOpts');
    const idx = box.children.length;
    if(idx >= 8) return;
    const row = document.createElement('div');
    row.className = 'addq-opt';
    row.innerHTML = '<span class="k"></span><input>';
    row.querySelector('.k').textContent = String.fromCharCode(65 + idx);
    row.querySelector('input').placeholder = '选项 ' + (idx + 1);
    box.appendChild(row);
  }

  function doAddqParse(){
    let items = [];
    try{
      if(ADDQ.mode === 'text'){
        if(!$('addqText').value.trim()){ addqMsg('先把题目贴进来', 'err'); return; }
        items = itemsFromText($('addqText').value);
        if(!items.length) throw new Error('没识别出题目，检查一下格式');
      }else if(ADDQ.mode === 'form'){
        items = itemsFromForm();
        if(!items.length) return;
      }else{
        const raw = $('addqJson').value.trim();
        if(!raw){ addqMsg('先粘贴 JSON 或选文件', 'err'); return; }
        let data;
        try{ data = JSON.parse(raw); }
        catch(e){ throw new Error('不是合法 JSON：' + e.message); }
        items = itemsFromJson(data);
      }
    }catch(e){
      addqMsg(e.message || '解析失败', 'err');
      return;
    }

    const defCh = $('addqChapter').value || '未分类';
    items.forEach(it => { if(!it.chapter) it.chapter = defCh; });
    ADDQ.items = ADDQ.items.concat(items);
    renderAddqPreview();
    addqMsg('识别到 ' + items.length + ' 题，确认后点「加入题库」', 'ok');
  }

  function commitAddq(){
    const picked = ADDQ.items.filter(i => i.checked && i.stem);
    if(!picked.length){ addqMsg('先勾选要加的题', 'err'); return; }
    const courseId = $('addqCourse').value;
    if(!courseId){ addqMsg('没有可加的题库', 'err'); return; }

    const list = loadAdds();
    const now = Date.now();
    picked.forEach((it, idx) => {
      const rec = {
        id: 'add-' + now + '-' + idx + '-' + Math.random().toString(36).slice(2, 6),
        courseId,
        ch: it.chapter || $('addqChapter').value || '未分类',
        t: it.type,
        atid: atidByType(it.type),
        q: it.stem,
        a: it.answer || '',
        o: it.options || [],
        ex: it.explanation || '',
        createdAt: now,
        ...(Array.isArray(it.blank) && it.blank.length ? { blank: it.blank.slice() } : {}),
      };
      rec.k = qkeyOf(rec);
      list.push(rec);
    });
    saveAdds(list);

    const n = picked.length;
    ADDQ.items = [];
    renderAddqPreview();
    fillAddqChapters();
    renderAddqLocal();
    addqMsg('已加入本机题库：' + n + ' 题', 'ok');
    if(state.courseId === courseId) refreshCourse();
    else renderChrome();
  }

  /* ---------- 提交状态（题库缓存里，开关打开后才显示） ---------- */
  async function renderCacheSubs(){
    const box = $('cacheSubs');
    if(!box) return;
    if(!UPLOAD_ON || !ONLINE || !ME){ box.hidden = true; return; }
    box.hidden = false;
    const list = $('cacheSubsList');
    list.innerHTML = '';
    const loading = document.createElement('div');
    loading.className = 'addq-local-empty';
    loading.textContent = '加载中…';
    list.appendChild(loading);
    try{
      const r = await api('/api/submissions/mine');
      const rows = (r && r.submissions) || [];
      list.innerHTML = '';
      if(!rows.length){
        list.innerHTML = '<div class="addq-local-empty">还没有提交过题目</div>';
        return;
      }
      for(const s of rows){
        const row = document.createElement('div');
        row.className = 'cache-sub-row';
        row.innerHTML = '<span class="s"></span><span class="st"></span>';
        row.querySelector('.s').textContent = s.qkey;
        const st = row.querySelector('.st');
        st.dataset.s = s.status;
        st.textContent = SUB_STATUS[s.status] || s.status;
        if(s.status === 'pending'){
          const wd = document.createElement('button');
          wd.className = 'wd';
          wd.type = 'button';
          wd.textContent = '撤回';
          wd.addEventListener('click', async () => {
            try{
              await api('/api/submissions/' + s.id + '/withdraw', { method: 'POST', body: '{}' });
              renderCacheSubs();
            }catch(e){}
          });
          row.appendChild(wd);
        }
        list.appendChild(row);
      }
    }catch(e){
      list.innerHTML = '';
      const err = document.createElement('div');
      err.className = 'addq-local-empty';
      err.textContent = '加载失败';
      list.appendChild(err);
    }
  }

  /* ---------- 解析 / 新增题的事件 ---------- */
  document.addEventListener('submit', (e) => {
    if(e.target && e.target.id === 'exForm'){ e.preventDefault(); saveEx(); }
  });

  document.addEventListener('click', (e) => {
    const t = e.target;
    if(!t || !t.closest) return;

    if(t.closest('#exEdit')){ openExEditor(); return; }
    if(t.closest('#exCancel')){ $('exForm').hidden = true; exMsg(''); return; }
    if(t.closest('#exDelete')){ deleteEx(); return; }
    if(t.closest('#exHistory')){ openHist(); return; }
    if(t.closest('#histClose')){ $('histModal').dataset.open = 'false'; return; }
    if(t.id === 'histModal'){ $('histModal').dataset.open = 'false'; return; }

    if(t.closest('#btnAddQ')){ openAddq(); return; }
    if(t.closest('#addqClose')){ closeAddq(); return; }
    if(t.id === 'addqModal'){ closeAddq(); return; }
    const tab = t.closest('#addqTabs button');
    if(tab){ setAddqMode(tab.dataset.m); return; }
    if(t.closest('#addqParse')){ doAddqParse(); return; }
    if(t.closest('#addqCommit')){ commitAddq(); return; }
    if(t.closest('#addqDiscard')){
      ADDQ.items = [];
      renderAddqPreview();
      addqMsg('');
      return;
    }
    if(t.closest('#addqAddOpt')){ addOptRow(); return; }
    if(t.closest('#addqNewChapterBtn')){
      const inp = $('addqNewChapter');
      inp.hidden = !inp.hidden;
      if(!inp.hidden) inp.focus();
      return;
    }
    if(t.closest('#addqTypeFilter')) return;
  });

  document.addEventListener('change', (e) => {
    const t = e.target;
    if(!t) return;
    if(t.id === 'addqCourse'){
      fillAddqChapters();
      renderAddqLocal();
      renderAddqPreview();
      return;
    }
    if(t.id === 'addqNewChapter'){
      const name = t.value.trim();
      if(name){
        const sel = $('addqChapter');
        const o = document.createElement('option');
        o.value = name;
        o.textContent = name;
        sel.appendChild(o);
        sel.value = name;
      }
      return;
    }
    if(t.id === 'addqTypeFilter'){ renderAddqPreview(); return; }
    if(t.id === 'addqAll'){
      ADDQ.items.forEach(i => { i.checked = t.checked; });
      renderAddqPreview();
      return;
    }
    if(t.id === 'addqFile'){
      const f = t.files && t.files[0];
      if(!f) return;
      $('addqFileName').textContent = f.name;
      const reader = new FileReader();
      reader.onload = () => {
        $('addqJson').value = String(reader.result || '');
        addqMsg('文件已读入，点「解析」');
      };
      reader.readAsText(f, 'utf-8');
      return;
    }
  });

  /* ---------- 讨论区（要连服务器） ---------- */
  // 有服务器地址，或者网页版挂了 Supabase 适配层，都算「在线」
  const onlineOn = () => !!(window.__ONLINE__ || window.__SERVER__ || window.__API_ADAPTER__);
  const ONLINE = !!(window.__SERVER__ || window.__API_ADAPTER__);
  let ME = null;

  const TOKEN_KEY = 'hbmu_token';
  const getToken = () => { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; } };
  const setToken = (t) => { try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch (e) {} };

  // 默认实现：直接打自己的服务器（扩展 / App 用）
  const defaultApi = async (path, opts = {}) => {
    const token = getToken();
    const r = await fetch((window.__SERVER__ || '') + path, {
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: 'Bearer ' + token } : {}),
        ...(opts.headers || {}),
      },
      ...opts,
    });
    let body = null;
    try { body = await r.json(); } catch (e) { body = null; }
    if (!r.ok) throw Object.assign(new Error((body && body.error) || '请求失败'), { status: r.status });
    return body;
  };

  // 网页版可以用 window.__API_ADAPTER__ 接管所有 /api/* 请求（比如走 Supabase）
  const api = (path, opts = {}) =>
    (typeof window.__API_ADAPTER__ === 'function' ? window.__API_ADAPTER__(path, opts) : defaultApi(path, opts));

  function fmtTime(ts){
    const d = new Date(ts);
    const now = Date.now();
    const diff = (now - ts) / 1000;
    if(diff < 60) return '刚刚';
    if(diff < 3600) return Math.floor(diff / 60) + ' 分钟前';
    if(diff < 86400) return Math.floor(diff / 3600) + ' 小时前';
    return (d.getMonth() + 1) + '月' + d.getDate() + '日';
  }

  async function loadMe(){
    if(!ONLINE) return null;
    try { const r = await api('/api/me'); ME = r.user || null; } catch(e){ ME = null; }
    return ME;
  }

  // 上报一次答题结果（登录后才报，用于同校正确率）
  let __lastReported = '';
  async function __reportStat(qid, ok){
    if(!ONLINE || !ME) return;
    const key = qid + '|' + (ok ? 1 : 0);
    if(__lastReported === key) return;
    __lastReported = key;
    try{
      await api('/api/stats', { method: 'POST', body: JSON.stringify({ course: state.courseId, qid, ok }) });
    }catch(e){}
  }

  function isQuestionDone(q){
    if(!q) return false;
    return !!(state.answers[q.id] || state.ratings[q.id] !== undefined || q.__revealed);
  }

  let discussSort = (() => {
    try { return localStorage.getItem('hbmu_discuss_sort') || 'likes'; } catch(e){ return 'likes'; }
  })();
  const chosenTags = new Set();
  const folded = new Set();

  async function loadDiscuss(showAll){
    const box = $('discuss');
    if(!ONLINE || !box) return;
    const q = LIST[state.idx];
    if(!q){ box.hidden = true; return; }
    if(!isQuestionDone(q)){ box.hidden = true; return; }
    box.hidden = false;
    $('discussLogin').hidden = !!ME;
    $('discussMe').hidden = !ME;
    $('discussForm').hidden = !ME;
    if(ME){
      $('discussMe').textContent = ME.nickname;
      $('discussMe').onclick = openAccount;
    }
    if(ME && $('discussInput')) syncDiscussHint();

    // 排序按钮状态
    const sortBox = $('discussSort');
    if(sortBox){
      sortBox.querySelectorAll('button').forEach(b => {
        b.dataset.on = b.dataset.sort === discussSort ? '1' : '0';
      });
    }

    $('discussList').innerHTML = '<li class="discuss-empty">加载中…</li>';

    try{
      const lim = showAll ? '0' : '5';
      const r = await api('/api/comments?course=' + encodeURIComponent(state.courseId) +
                          '&qid=' + encodeURIComponent(q.id) +
                          '&limit=' + lim + '&sort=' + discussSort);
      const rows = r.comments || [];
      const total = (typeof r.total === 'number') ? r.total : rows.length;

      $('discussN').textContent = total;
      if($('discussTotal')) $('discussTotal').textContent = total;

      // 同校正确率
      try{
        const st = await api('/api/stats?course=' + encodeURIComponent(state.courseId) + '&qid=' + encodeURIComponent(q.id));
        const el = $('discussStat');
        if(el && st && st.attempts > 0){
          el.hidden = false;
          el.innerHTML =
            '<span>全校正确率</span>' +
            '<span class="bar"><i style="width:' + st.rate + '%;background:' +
              (st.rate >= 70 ? 'var(--accent)' : st.rate >= 40 ? '#B8912F' : 'var(--bad)') + '"></i></span>' +
            '<b>' + st.rate + '%</b>' +
            '<span>' + st.attempts + ' 人做过</span>';
        }else if(el){ el.hidden = true; }
      }catch(e){ if($('discussStat')) $('discussStat').hidden = true; }

      // 我也错了
      const mBtn = $('discussMistake');
      if(mBtn){
        // 网页版没有「我也错了」的存储，直接隐藏，避免点了不能用的按钮
        mBtn.hidden = !ME || typeof window.__API_ADAPTER__ === 'function';
        mBtn.dataset.on = r.myMistake ? '1' : '0';
        mBtn.querySelector('b').textContent = r.mistakeCount || 0;
      }

      if(!rows.length){
        $('discussList').innerHTML = '<li class="discuss-empty">还没有人发言，来说第一句。</li>';
        if($('discussMore')) $('discussMore').hidden = true;
        return;
      }

      // 组树：按 parentId 挂（任意深度）
      const byId = {};
      const roots = [];
      rows.forEach(c => { byId[c.id] = { ...c, children: [] }; });
      rows.forEach(c => {
        const node = byId[c.id];
        if(c.parent_id && byId[c.parent_id]) byId[c.parent_id].children.push(node);
        else if(!c.parent_id) roots.push(node);
      });
      roots.sort((a, b) => discussSort === 'new'
        ? b.created_at - a.created_at
        : (b.likes - a.likes) || (b.created_at - a.created_at));
      // 子回复按时间正序
      const sortKids = (n) => {
        if(!n.children || !n.children.length) return;
        n.children.sort((a, b) => a.created_at - b.created_at);
        n.children.forEach(sortKids);
      };
      roots.forEach(sortKids);

      // 把一条评论的整棵回复树拍平成数组（先序）
      function flattenReplies(node, out){
        const list = out || [];
        for(const k of (node.children || [])){
          list.push(k);
          flattenReplies(k, list);
        }
        return list;
      }

      // 渲染一条评论（不递归子树，子树由外层统一拍平渲染）
      function renderOne(c, isChild){
        const mine = !!c.isMine;
        const tagList = String(c.tags || '').split(',').filter(Boolean)
          .map(t => '<span class="dc-tag' + (t === '争议' ? ' warn' : '') + '">' + t + '</span>').join('');

        // 引用块：回复谁 + 原文片段
        const quote = c.reply_to_nick || c.quote_body
          ? '<blockquote class="dc-quote">' +
              '<span class="qk">' + (c.reply_to_nick ? ('回复 ' + c.reply_to_nick) : '引用') + '</span>' +
              '<span class="qv"></span>' +
            '</blockquote>'
          : '';

        const replyTotal = flattenReplies(c).length;

        return '' +
        '<li class="discuss-item' + (isChild ? ' is-child' : '') + '" data-id="' + c.id + '" data-depth="' + (isChild ? 1 : 0) + '">' +
          '<div class="who"><span class="nick"></span><span class="v"></span>' +
            '<span class="when"></span></div>' +
          quote +
          '<div class="txt"></div>' +
          '<button type="button" class="dc-fold-btn" hidden>展开</button>' +
          (tagList ? '<div class="dc-tags">' + tagList + '</div>' : '') +
          '<div class="dc-acts">' +
            '<button class="dc-btn dc-like" data-act="like"><span class="ico">▲</span><span class="n">' + (c.likes || 0) + '</span></button>' +
            '<button class="dc-btn dc-dislike" data-act="dislike"><span class="ico">▼</span><span class="n">' + (c.dislikes || 0) + '</span></button>' +
            '<button class="dc-btn dc-reply" data-act="reply">回复' + (replyTotal ? '（' + replyTotal + '）' : '') + '</button>' +
            (mine ? '<button class="dc-btn dc-del" data-act="del">删除</button>' : '<button class="dc-btn dc-report" data-act="report">举报</button>') +
          '</div>' +
        '</li>';
      }

      // 嵌套树：一条评论底下递归挂它自己的直接子回复
      function renderTree(c, depth){
        const direct = c.children || [];
        const kids = direct.length
          ? '<ul class="dc-replies">' + direct.map(k => renderTree(k, depth + 1)).join('') + '</ul>'
          : '';
        return renderOne(c, depth > 0).replace('</li>', kids + '</li>');
      }

      // 平铺列表：主评论下所有回复按「回复 某某：内容」排成一段
      function renderFlatList(c){
        const all = flattenReplies(c);
        if(!all.length) return '';
        const items = all.map(k =>
          '<div class="dc-flat-item" data-id="' + k.id + '">' +
            '<span class="fl-to"></span>' +
            '<span class="fl-nick"></span>' +
            '<span class="fl-txt"></span>' +
          '</div>'
        ).join('');
        return '<div class="dc-flat">' +
          '<div class="dc-flat-hd">平铺视图</div>' + items +
        '</div>';
      }

      // 主评论 = 嵌套树
      function renderNode(c){
        return renderTree(c, 0);
      }

      $('discussList').innerHTML = roots.map(c => {
        const html = renderNode(c);
        const flat = renderFlatList(c);
        return flat ? html.replace('</li>', flat + '</li>') : html;
      }).join('');

      // 填充
      $('discussList').querySelectorAll('.discuss-item').forEach(el => {
        const c = byId[Number(el.dataset.id)];
        if(!c) return;
        el.querySelector('.nick').textContent = c.nickname || '匿名';
        if(c.verified) el.querySelector('.v').textContent = ' ✓ 已认证';
        el.querySelector('.when').textContent = fmtTime(c.created_at);

        const qv = el.querySelector('.dc-quote .qv');
        if(qv && c.quote_body) qv.textContent = '「' + c.quote_body + (c.quote_body.length >= 80 ? '…' : '') + '」';

        const txtEl = el.querySelector('.txt');
        const full = c.body || '';
        const foldBtn = el.querySelector('.dc-fold-btn');
        if(full.length > 100){
          const isOpen = folded.has(c.id);
          txtEl.textContent = isOpen ? full : (full.slice(0, 100) + '…');
          foldBtn.hidden = false;
          foldBtn.textContent = isOpen ? '收起' : '展开全文（共 ' + full.length + ' 字）';
          foldBtn.onclick = () => {
            if(folded.has(c.id)) folded.delete(c.id); else folded.add(c.id);
            loadDiscuss(showAll);
          };
        } else {
          txtEl.textContent = full;
        }

        if(c.mine === 1) el.querySelector('.dc-like').dataset.on = '1';
        if(c.mine === -1) el.querySelector('.dc-dislike').dataset.on = '1';

        // 平铺列表里的每一行
        const flatBox = el.querySelector('.dc-flat');
        if(flatBox){
          flatBox.querySelectorAll('.dc-flat-item').forEach(fi => {
            const fc = byId[Number(fi.dataset.id)];
            if(!fc) return;
            const to = fc.reply_to_nick || '';
            fi.querySelector('.fl-to').textContent = to ? ('回复 ' + to + '：') : '回复：';
            fi.querySelector('.fl-nick').textContent = fc.nickname || '匿名';
            fi.querySelector('.fl-txt').textContent = fc.body || '';
          });
        }
      });

      if($('discussMore')){
        $('discussMore').hidden = !r.hasMore;
        $('discussMore').textContent = '展开全部 ' + total + ' 条';
        $('discussMore').onclick = () => loadDiscuss(true);
      }
    }catch(e){
      $('discussList').innerHTML = '<li class="discuss-empty">讨论暂时加载不了：' + (e.message || '网络问题') + '</li>';
    }
  }

  async function voteComment(id, value){
    if(!ME) return openAuth();
    try{
      const r = await api('/api/comments/' + id + '/vote', { method: 'POST', body: JSON.stringify({ value }) });
      const item = $('discussList').querySelector('.discuss-item[data-id="' + id + '"]');
      if(item){
        item.querySelector('.dc-like .n').textContent = r.likes;
        item.querySelector('.dc-dislike .n').textContent = r.dislikes;
        item.querySelector('.dc-like').dataset.on = r.mine === 1 ? '1' : '0';
        item.querySelector('.dc-dislike').dataset.on = r.mine === -1 ? '1' : '0';
      }
    }catch(e){ alert(e.message || '操作失败'); }
  }

  function openReply(id, replyToId, replyToNick){
    if(!ME) return openAuth();
    const item = $('discussList').querySelector('.discuss-item[data-id="' + id + '"]');
    if(!item || item.querySelector('.dc-reply-form')) return;

    const form = document.createElement('div');
    form.className = 'dc-reply-form';
    form.innerHTML =
      '<textarea maxlength="300" rows="1" placeholder="' +
        (replyToNick ? ('回复 ' + replyToNick + '：') : '回复这条评论…') + '"></textarea>' +
      '<div class="dc-rf-acts"><button type="button" class="dc-send">发送</button>' +
      '<button type="button" class="dc-cancel">取消</button></div>';

    const repliesEl = item.querySelector('.dc-replies');
    if(repliesEl) repliesEl.after(form);
    else {
      const acts = item.querySelector('.dc-acts');
      if(acts) acts.after(form); else item.appendChild(form);
    }
    const ta = form.querySelector('textarea');
    ta.focus();
    form.querySelector('.dc-cancel').onclick = () => form.remove();
    form.querySelector('.dc-send').onclick = async () => {
      const text = ta.value.trim();
      if(text.length < 2){ alert('回复至少 2 个字'); return; }
      try{
        await api('/api/comments', {
          method: 'POST',
          body: JSON.stringify({
            course: state.courseId,
            qid: LIST[state.idx].id,
            body: text,
            parentId: id,
            replyToId: replyToId || null,
            replyToNick: replyToNick || '',
          }),
        });
        form.remove();
        await loadDiscuss();
      }catch(e){ alert(e.message || '发送失败'); }
    };
  }

  async function deleteComment(id){
    if(!confirm('删除这条评论？回复也会一起删掉。')) return;
    try{
      await api('/api/comments/' + id, { method: 'DELETE' });
      await loadDiscuss();
    }catch(e){ alert(e.message || '删除失败'); }
  }

  async function reportComment(id){
    const reason = prompt('举报原因（可留空）：', '');
    if(reason === null) return;
    try{
      await api('/api/reports', { method: 'POST', body: JSON.stringify({ commentId: id, reason }) });
      alert('已提交举报，管理员会处理');
    }catch(e){ alert(e.message || '举报失败'); }
  }

  async function toggleMistake(){
    if(!ME) return openAuth();
    const q = LIST[state.idx];
    if(!q) return;
    try{
      const r = await api('/api/mistake', { method: 'POST', body: JSON.stringify({ course: state.courseId, qid: q.id }) });
      if(r && r.unsupported){ toast('网页版暂时不支持「我也错了」'); return; }
      const btn = $('discussMistake');
      if(btn){
        btn.dataset.on = r.mine ? '1' : '0';
        btn.querySelector('b').textContent = r.count;
      }
    }catch(e){ alert(e.message || '操作失败'); }
  }

  // 事件委托
  document.addEventListener('click', (e) => {
    const sortBtn = e.target.closest && e.target.closest('#discussSort button');
    if(sortBtn){
      discussSort = sortBtn.dataset.sort;
      try { localStorage.setItem('hbmu_discuss_sort', discussSort); } catch(e){}
      loadDiscuss();
      return;
    }
    const tagBtn = e.target.closest && e.target.closest('#discussTags .dtag');
    if(tagBtn){
      const t = tagBtn.dataset.tag;
      if(chosenTags.has(t)){ chosenTags.delete(t); tagBtn.dataset.on = '0'; }
      else { chosenTags.add(t); tagBtn.dataset.on = '1'; }
      return;
    }
    const mBtn = e.target.closest && e.target.closest('#discussMistake');
    if(mBtn){ toggleMistake(); return; }

    const rBtn = e.target.closest && e.target.closest('.dc-rreply');
    if(rBtn){
      const li = rBtn.closest('.dc-reply');
      const top = rBtn.closest('.discuss-item');
      if(li && top){
        const nick = li.querySelector('.dc-rn').textContent;
        openReply(Number(top.dataset.id), Number(rBtn.dataset.rid), nick);
      }
      return;
    }

    const btn = e.target.closest && e.target.closest('.dc-btn');
    if(!btn) return;
    const item = btn.closest('.discuss-item');
    if(!item) return;
    const id = Number(item.dataset.id);
    const act = btn.dataset.act;
    if(act === 'like') voteComment(id, btn.dataset.on === '1' ? 0 : 1);
    else if(act === 'dislike') voteComment(id, btn.dataset.on === '1' ? 0 : -1);
    else if(act === 'reply') openReply(id, id, item.querySelector('.nick').textContent);
    else if(act === 'del') deleteComment(id);
    else if(act === 'report') reportComment(id);
  });

  function discussLen(text){
    return Array.from(String(text || '').trim()).length;
  }

  function syncDiscussHint(){
    const input = document.getElementById('discussInput');
    const send = document.getElementById('discussSend');
    const hint = document.getElementById('discussHint');
    const count = document.getElementById('discussCount');
    if(!input || !send) return;
    const n = Array.from(String(input.value || '').trim()).length;
    const ok = n >= 6;
    send.disabled = !ok;
    if(count){
      count.hidden = ok || n === 0;
      count.dataset.ok = ok ? 'true' : 'false';
      count.textContent = '还差 ' + (6 - n) + ' 个字';
    }
    if(hint) hint.textContent = '';
    input.oninput = syncDiscussHint;
  }

  async function sendDiscuss(text){
    const q = LIST[state.idx];
    if(!q) return;
    if(discussLen(text) < 6){ $('discussHint').textContent = '至少写 6 个字再发'; return; }
    $('discussHint').textContent = '发送中…';
    try{
      await api('/api/comments', {
        method: 'POST',
        body: JSON.stringify({
          course: state.courseId,
          qid: q.id,
          body: text.trim(),
          tags: [...chosenTags],
        }),
      });
      $('discussInput').value = '';
      $('discussHint').textContent = '';
      chosenTags.clear();
      if($('discussTags')) $('discussTags').querySelectorAll('.dtag').forEach(b => { b.dataset.on = '0'; });
      await loadDiscuss();
    }catch(e){
      $('discussHint').textContent = e.message || '发送失败';
      if(e.status === 401){ ME = null; $('discussForm').hidden = true; $('discussLogin').hidden = false; }
    }
  }

  // 登录验证码：服务端生成图片，服务端校验（扩展环境没有这个接口时自动跳过）
  // 用 config.js 里的 captcha 开关控制，测试阶段默认关
  function captchaOn(){
    return !!(window.__SUPABASE__ && window.__SUPABASE__.captcha === true);
  }
  let capId = '';
  async function loadCaptcha(){
    const img = $('authCapImg');
    if(!img) return;
    if(!captchaOn()){ img.hidden = true; capId = ''; if($('authCapField')) $('authCapField').hidden = true; return; }
    if($('authCapField')) $('authCapField').hidden = false;
    try{
      const r = await api('/api/captcha');
      if(!r || !r.svg){ img.hidden = true; capId = ''; return; }
      capId = r.id;
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(r.svg);
      img.hidden = false;
      if($('authCap')) $('authCap').value = '';
    }catch(e){
      img.hidden = true;
      capId = '';
    }
  }
  async function checkCaptcha(){
    if(!captchaOn()) return true;
    if(!capId) return true;   // 没有验证码服务就直接放行（老环境）
    const code = ($('authCap').value || '').trim();
    if(!code){ $('authMsg').textContent = '先输入验证码'; return false; }
    try{
      const r = await api('/api/captcha/check', { method: 'POST', body: JSON.stringify({ id: capId, code }) });
      if(r && r.ok) return true;
      $('authMsg').textContent = '验证码不对，换一张再试';
      await loadCaptcha();
      return false;
    }catch(e){
      $('authMsg').textContent = '验证码校验失败：' + (e.message || '网络问题');
      await loadCaptcha();
      return false;
    }
  }

  function openAuth(){
    $('auth').dataset.open = 'true';
    $('authMsg').textContent = '';
    $('authReset').hidden = true;
    loadCaptcha();
    setTimeout(() => $('authSid').focus(), 60);
  }
  function closeAuth(){ $('auth').dataset.open = 'false'; }

  // 忘记密码：学号 + 验证码（验证码由管理员在 Supabase 表里看）
  const resetMsg = (text, kind) => {
    const el = $('resetMsg');
    if(!el) return;
    el.textContent = text || '';
    el.dataset.kind = kind || '';
  };

  async function requestResetCode(){
    const sid = ($('resetSid').value || '').trim();
    if(!sid){ resetMsg('先填学号', 'err'); return; }
    const btn = $('resetRequest');
    if(btn){ btn.disabled = true; }
    resetMsg('提交中…');
    try{
      await api('/api/forgot', { method: 'POST', body: JSON.stringify({ studentId: sid }) });
      resetMsg('验证码已生成，找管理员要（QQ 群 1047914312）', 'ok');
    }catch(e){
      resetMsg(authErrText(e), 'err');
    }finally{
      if(btn){ btn.disabled = false; }
    }
  }

  async function applyResetPassword(){
    const sid = ($('resetSid').value || '').trim();
    const code = ($('resetCode').value || '').trim();
    const pass = $('resetPass').value || '';
    if(!sid || !code){ resetMsg('学号和验证码都要填', 'err'); return; }
    if(!/^\d{6}$/.test(code)){ resetMsg('验证码是 6 位数字', 'err'); return; }
    if(pass.length < 8){ resetMsg('新密码至少 8 位', 'err'); return; }
    const btn = $('resetApply');
    if(btn){ btn.disabled = true; }
    resetMsg('提交中…');
    try{
      await api('/api/reset', { method: 'POST', body: JSON.stringify({ studentId: sid, code, password: pass }) });
      resetMsg('密码已重置，回去登录吧', 'ok');
      $('resetPass').value = '';
      setTimeout(() => {
        $('authReset').hidden = true;
        $('authSid').value = sid;
        $('authPass').value = '';
        $('authMsg').textContent = '密码已重置，用新密码登录';
        setTimeout(() => $('authPass').focus(), 60);
      }, 1200);
    }catch(e){
      resetMsg(authErrText(e), 'err');
    }finally{
      if(btn){ btn.disabled = false; }
    }
  }

  // 轻量提示条（注册成功、保存成功之类的）
  let toastTimer = 0;
  function toast(text){
    let el = document.getElementById('appToast');
    if(!el){
      el = document.createElement('div');
      el.id = 'appToast';
      el.className = 'app-toast';
      document.body.appendChild(el);
    }
    el.textContent = text;
    el.dataset.on = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.dataset.on = '0'; }, 2800);
  }

  // 把 Supabase / 服务器的英文报错翻成中文
  function authErrText(e){
    const msg = String((e && e.message) || '');
    if(/already registered|already exists|user already/i.test(msg)) return '这个学号已经注册过了，直接点「登录」就行';
    if(/invalid login credentials|invalid_grant|invalid password/i.test(msg)) return '学号或密码不对';
    if(/password should be at least|password.*too short/i.test(msg)) return '密码至少 8 位';
    if(/rate limit|too many requests|over_email_send/i.test(msg)) return '试得太频繁了，等一分钟再试';
    if(/email not confirmed/i.test(msg)) return '邮箱还没验证，稍等一会儿再试';
    if(/signups not allowed|signup.*disabled/i.test(msg)) return '这个站点的注册被管理员关掉了';
    if(/network|failed to fetch|load failed/i.test(msg)) return '网络不通，检查一下网络再试';
    return msg || '操作失败';
  }

  async function doAuth(kind){
    const sid = $('authSid').value.trim();
    const pass = $('authPass').value;
    const btn = kind === 'register' ? $('authRegister') : $('authLogin');
    $('authMsg').textContent = '';

    if(!sid){ $('authMsg').textContent = '先填学号'; return; }
    if(!/^[0-9A-Za-z@._-]{4,40}$/.test(sid)){ $('authMsg').textContent = '学号格式不对（4–40 位数字或字母）'; return; }
    if(!pass || pass.length < 8){ $('authMsg').textContent = '密码至少 8 位'; return; }
    // 图形验证码（服务端校验，一次性；config.js 里 captcha:true 才启用）
    if(captchaOn() && !(await checkCaptcha())) return;

    const oldText = btn ? btn.textContent : '';
    if(btn){ btn.disabled = true; btn.textContent = kind === 'register' ? '注册中…' : '登录中…'; }
    $('authMsg').textContent = '';

    try{
      const r = await api('/api/' + kind, { method: 'POST', body: JSON.stringify({ studentId: sid, password: pass }) });
      if(r && r.token) setToken(r.token);
      ME = { nickname: (r && r.nickname) || '冀医用户', id: r && r.userId };
      $('authPass').value = '';
      closeAuth();
      await loadDiscuss();
      if(kind === 'register'){
        toast('注册成功，你的昵称是 ' + ME.nickname + '（可在「我的账户」里改）');
      }else{
        toast('欢迎回来，' + ME.nickname);
      }
    }catch(e){
      $('authMsg').textContent = authErrText(e);
    }finally{
      if(btn){ btn.disabled = false; btn.textContent = oldText; }
    }
  }

  function openAccount(){
    if(!ME) return openAuth();
    $('accNick').value = ME.nickname || '';
    renderVerifyState();
    $('accMsg').textContent = '';
    $('accSub').textContent = '当前昵称：' + (ME.nickname || '—');
    $('account').dataset.open = 'true'; renderAccStats();
    setTimeout(() => $('accNick').focus(), 60);
  }
  function closeAccount(){ $('account').dataset.open = 'false'; }

  // ---------- 修改密码 ----------
  function accPwdMsg(text, kind){
    const el = document.getElementById('accPwdMsg');
    if(!el) return;
    el.textContent = text || '';
    el.className = 'bank-msg' + (kind ? ' ' + kind : '');
  }

  document.addEventListener('click', async (e) => {
    const t = e.target;
    if(!t || !t.closest) return;

    if(t.closest('#accPwdToggle')){
      const f = document.getElementById('accPwdForm');
      if(!f) return;
      f.hidden = !f.hidden;
      if(!f.hidden){
        accPwdMsg('');
        const oldEl = document.getElementById('accPwdOld');
        if(oldEl) setTimeout(() => oldEl.focus(), 60);
      }
      return;
    }

    if(t.closest('#accPwdSave')){
      const oldEl = document.getElementById('accPwdOld');
      const n1 = document.getElementById('accPwdNew');
      const n2 = document.getElementById('accPwdNew2');
      const btn = document.getElementById('accPwdSave');
      if(!oldEl || !n1 || !n2) return;

      const cur = oldEl.value;
      const pw1 = n1.value;
      const pw2 = n2.value;

      if(!cur){ accPwdMsg('请输入当前密码', 'err'); return; }
      if(pw1.length < 8){ accPwdMsg('新密码至少 8 位', 'err'); return; }
      if(pw1 !== pw2){ accPwdMsg('两次输入的新密码不一致', 'err'); return; }
      if(pw1 === cur){ accPwdMsg('新密码不能和旧密码一样', 'err'); return; }

      btn.disabled = true;
      accPwdMsg('提交中…');
      try{
        await api('/api/password', {
          method: 'POST',
          body: JSON.stringify({ currentPassword: cur, newPassword: pw1 }),
        });
        accPwdMsg('密码已修改，其他设备需要重新登录', 'ok');
        oldEl.value = ''; n1.value = ''; n2.value = '';
        setTimeout(() => {
          const f = document.getElementById('accPwdForm');
          if(f) f.hidden = true;
          accPwdMsg('');
        }, 1800);
      }catch(err){
        accPwdMsg((err && err.message) || '修改失败', 'err');
      }finally{
        btn.disabled = false;
      }
      return;
    }
  });

  // 进度导出 / 导入（换设备用；网页版和扩展都能用）
  document.addEventListener('click', (e) => {
    const t = e.target;
    if(!t || !t.closest) return;
    if(t.closest('#accProgToggle')){
      const f = $('accProgForm');
      if(f) f.hidden = !f.hidden;
      return;
    }
    if(t.closest('#accProgExport')){
      const ta = $('accProgJson');
      const msg = $('accProgMsg');
      if(!ta) return;
      try{
        ta.value = (typeof window.__exportProgress === 'function')
          ? window.__exportProgress()
          : (localStorage.getItem(KEY) || '{}');
        if(msg) msg.textContent = '已导出，复制这段文字就行';
      }catch(err){ if(msg) msg.textContent = '导出失败'; }
      return;
    }
    if(t.closest('#accProgImport')){
      const ta = $('accProgJson');
      const msg = $('accProgMsg');
      if(!ta || !ta.value.trim()){ if(msg) msg.textContent = '先把进度 JSON 粘进来'; return; }
      try{
        const data = JSON.parse(ta.value);
        if(!data || typeof data !== 'object') throw new Error('不是有效的进度 JSON');
        if(typeof window.__importProgress === 'function') window.__importProgress(ta.value);
        else localStorage.setItem(KEY, JSON.stringify(data));
        if(msg) msg.textContent = '导入成功，正在刷新…';
        setTimeout(() => location.reload(), 600);
      }catch(err){ if(msg) msg.textContent = err.message || '导入失败'; }
      return;
    }
  });

  const VERIFY_TEXT = { none: '未认证', pending: '待审核', approved: '已认证', rejected: '未通过' };

  function renderVerifyState(){
    const st = (ME && ME.verify) || 'none';
    const badge = $('accBadge');
    const btn = $('accApply');
    if(!badge) return;
    badge.textContent = VERIFY_TEXT[st] || '未认证';
    badge.dataset.s = st;
    btn.hidden = st === 'approved' || st === 'pending';
    btn.textContent = st === 'rejected' ? '重新申请' : '申请认证';
  }

  async function applyVerify(){
    $('accMsg').textContent = '提交中…';
    try{
      await api('/api/verify/apply', { method: 'POST', body: '{}' });
      ME.verify = 'pending';
      renderVerifyState();
      $('accMsg').textContent = '申请已提交，等待审核';
    }catch(e){
      $('accMsg').textContent = e.message || '提交失败';
    }
  }

  async function saveNickname(){
    const name = $('accNick').value.trim();
    if(name.length < 2 || name.length > 16){ $('accMsg').textContent = '昵称 2–16 个字'; return; }
    $('accMsg').textContent = '保存中…';
    try{
      const r = await api('/api/profile', { method: 'POST', body: JSON.stringify({ nickname: name }) });
      ME = { nickname: r.nickname };
      $('accSub').textContent = '当前昵称：' + r.nickname;
      $('accMsg').textContent = '已保存';
      $('discussMe').textContent = r.nickname;
      await loadDiscuss();
      setTimeout(closeAccount, 700);
    }catch(e){
      $('accMsg').textContent = e.message || '保存失败';
    }
  }

  async function logout(){
    try{ await api('/api/logout', { method: 'POST', body: '{}' }); }catch(e){}
    setToken('');
    ME = null;
    closeAccount();
    await loadDiscuss();
  }

  if(ONLINE){
    $('btnAccount').hidden = false;
    $('btnAccount').addEventListener('click', openAccount);
    $('accClose').addEventListener('click', closeAccount);
    $('account').addEventListener('click', (e) => { if(e.target.id === 'account') closeAccount(); });
    $('accSave').addEventListener('click', saveNickname);
    $('accApply').addEventListener('click', applyVerify);
    $('accLogout').addEventListener('click', logout);
    $('discussLogin').addEventListener('click', openAuth);
    $('authClose').addEventListener('click', closeAuth);
    $('auth').addEventListener('click', (e) => { if(e.target.id === 'auth') closeAuth(); });
    $('authLogin').addEventListener('click', () => doAuth('login'));
    $('authRegister').addEventListener('click', () => doAuth('register'));
    // 回车：学号框跳到密码框，密码框直接登录
    $('authSid').addEventListener('keydown', (e) => {
      if(e.key === 'Enter'){ e.preventDefault(); $('authPass').focus(); }
    });
    $('authPass').addEventListener('keydown', (e) => {
      if(e.key === 'Enter'){ e.preventDefault(); doAuth('login'); }
    });
    $('authPass').addEventListener('input', () => { $('authMsg').textContent = ''; });
    // 点验证码图片换一张
    if($('authCapImg')) $('authCapImg').addEventListener('click', loadCaptcha);

    // 忘记密码：在同一个弹窗里切换
    $('authForgot').addEventListener('click', () => {
      $('authReset').hidden = false;
      if($('authSid').closest('label')) $('authSid').closest('label').hidden = true;
      if($('authPass').closest('label')) $('authPass').closest('label').hidden = true;
      if($('authCapField')) $('authCapField').hidden = true;
      $('authLogin').hidden = true;
      $('authRegister').hidden = true;
      $('authForgot').hidden = true;
      $('authMsg').textContent = '';
      $('resetSid').value = $('authSid').value.trim();
      setTimeout(() => $('resetSid').focus(), 60);
    });
    $('resetBack').addEventListener('click', () => {
      $('authReset').hidden = true;
      if($('authSid').closest('label')) $('authSid').closest('label').hidden = false;
      if($('authPass').closest('label')) $('authPass').closest('label').hidden = false;
      if($('authCapField')) $('authCapField').hidden = false;
      $('authLogin').hidden = false;
      $('authRegister').hidden = false;
      $('authForgot').hidden = false;
      resetMsg('');
    });
    if($('resetRequest')) $('resetRequest').addEventListener('click', requestResetCode);
    if($('resetApply')) $('resetApply').addEventListener('click', applyResetPassword);
    if($('resetPass')) $('resetPass').addEventListener('keydown', (e) => { if(e.key === 'Enter'){ e.preventDefault(); applyResetPassword(); } });
    $('discussForm').addEventListener('submit', (e) => { e.preventDefault(); sendDiscuss($('discussInput').value); });
    $('discussInput').addEventListener('input', syncDiscussHint);
    window.__discussSync = syncDiscussHint;
    syncDiscussHint();
    loadMe().then(() => loadDiscuss());
  }

  /* ---------- 启动 ---------- */
  dropStaleKeys();
  load();
  applyRail();
  setCourse(state.courseId);
  setTheme(state.theme);
  document.documentElement.dataset.mode = state.mode;
  showSetup();
})();

};

// ---------- 启动器：缓存优先，没有再拉 ----------
(async function () {
  // 网页版（GitHub Pages）自己加载静态题库，不走扩展这套启动流程
  if (window.__WEB_MODE__) return;
  const card = document.getElementById('drillBoot');
  const bar = document.getElementById('drillBar');
  const txt = document.getElementById('drillBootText');
  const sub = document.getElementById('drillBootSub');

  const fail = (msg, hint) => {
    if (!card) return;
    card.innerHTML = '<div class="boot-title err">启动失败</div>' +
      '<div class="boot-sub">' + msg + '</div>' +
      '<div class="boot-hint">' + (hint || '') + '</div>';
  };

  const showProgress = (p) => {
    const total = p.total || 1;
    const index = Math.min(p.index || 0, total);
    const inChapter = p.inChapter || 0;
    const frac = (index - 1 + (inChapter ? 0.5 : 1)) / total;
    const pct = Math.max(2, Math.min(100, Math.round(frac * 100)));
    if (bar) bar.style.width = pct + '%';
    if (sub) {
      sub.textContent = p.stage === 'rest'
        ? '补齐没有主题词的题… · 合计 ' + (p.collected || 0) + ' 题'
        : '第 ' + index + ' / ' + total + ' 章' +
          (p.chapter ? ' · ' + p.chapter : '') +
          ' · 合计 ' + (p.collected || 0) + ' 题';
    }
  };

  try {
    const stored = await chrome.storage.local.get(['hbmu_last', 'hbmu_server', 'hbmu_base']);
    // 学校接口地址（含 WebVPN 的动态 token），由 content.js 实时写入
    if (stored && stored.hbmu_base) window.__ANDROID_BASE__ = stored.hbmu_base;
    const last = stored && stored.hbmu_last;

    const builtin = 'http://192.144.174.191:3000';
    const server = (stored && stored.hbmu_server) || builtin || '';
    window.__SERVER__ = String(server).replace(/\/+$/, '');

    if (!last || !last.cid) {
      fail('还没有选过题库', '请从学校题库页打开，或在学生端首页左侧选一个题库。');
      return;
    }

    const name = last.name || last.cid;
    document.title = name + ' · 刷题';

    // 1) 先看本地缓存
    let course = null;
    try {
      const hit = await window.HBMUCache.get(last.cid);
      if (hit && hit.questions && hit.questions.length) course = hit;
    } catch (e) {}

    if (course) {
      if (txt) txt.textContent = name;
      if (bar) bar.style.width = '100%';
      if (sub) sub.textContent = course.questions.length + ' 题 · ' + course.chapters.length + ' 章 · 来自本地缓存';
      window.__startDrill({ version: 2, courses: [course] });
      if (card) card.remove();
      document.body.dataset.booted = '1';
      document.body.dataset.cached = '1';
      return;
    }

    // 2) 没有缓存，去学校拉
    if (txt) txt.textContent = name;
    if (sub) sub.textContent = '正在拉取题目…';

    // 章节：hbmu_last 里没带就现取，否则题目会全部归到「未分类」
    var themesForLoad = last.themes || [];
    if ((!themesForLoad || !themesForLoad.length) && window.HBMU.fetchThemes) {
      try {
        if (sub) sub.textContent = '正在读取章节…';
        var themeInfo = await window.HBMU.fetchThemes(last.cid);
        if (themeInfo && themeInfo.themes && themeInfo.themes.length) {
          themesForLoad = themeInfo.themes;
        }
        if (sub) sub.textContent = '正在拉取题目…（' + themesForLoad.length + ' 个章节）';
      } catch (e) {}
    }

    course = await window.HBMU.loadCourse(last.cid, themesForLoad, showProgress);
    if (bar) bar.style.width = '100%';
    if (sub) sub.textContent = course.questions.length + ' 题 · ' + course.chapters.length + ' 章';

    // 3) 存进缓存，下次直接开
    try { await window.HBMUCache.put(course); } catch (e) {}

    window.__startDrill({ version: 2, courses: [course] });
    if (card) card.remove();
    document.body.dataset.booted = '1';
  } catch (e) {
    fail(String((e && e.message) || e), '如果是 CORS 或 401，说明扩展页连不上讨论服务器。');
  }
})();
