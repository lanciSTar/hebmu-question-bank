// 网页版 · Supabase 适配层
// 作用：把 app.js 里的 /api/* 请求转成 Supabase（Auth + PostgREST），
//      没配 url/anonKey 时不启用，网页保持纯本地。
(function () {
  var CFG = window.__SUPABASE__ || {};
  if (!CFG.url || !CFG.anonKey) return;

  var BASE = String(CFG.url).replace(/\/+$/, '');
  var KEY = CFG.anonKey;
  var SKEY = 'hbmu_sb_session';
  var PKEY = 'epi-trainer-v2:dev';

  function session() {
    try { return JSON.parse(localStorage.getItem(SKEY) || 'null'); } catch (e) { return null; }
  }
  function setSession(s) { try { localStorage.setItem(SKEY, JSON.stringify(s)); } catch (e) {} }
  function clearSession() { try { localStorage.removeItem(SKEY); } catch (e) {} }
  function token() { var s = session(); return s && s.access_token; }
  function uid() { var s = session(); return s && s.user && s.user.id; }

  function enc(v) { return encodeURIComponent(String(v == null ? '' : v)); }

  async function call(path, opts) {
    opts = opts || {};
    var headers = { apikey: KEY };
    if (token()) headers.authorization = 'Bearer ' + token();
    if (opts.body) headers['content-type'] = 'application/json';
    if (opts.prefer) headers.prefer = opts.prefer;
    var res = await fetch(BASE + path, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body,
    });
    var text = await res.text();
    var data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
    if (!res.ok) {
      var msg = (data && (data.msg || data.message || data.error_description || data.error || data.hint)) || ('请求失败 ' + res.status);
      throw Object.assign(new Error(msg), { status: res.status, body: data });
    }
    return data;
  }

  var rest = function (path, opts) { return call('/rest/v1/' + path, opts); };

  // 认证走 Edge Function（它再转发旧服务器），业务数据走 Supabase
  var FUNC = (CFG.authProxy || (BASE + '/functions/v1/auth-proxy'));
  async function authProxy(action, payload) {
    var s = session();
    var bearer = (s && s.access_token) || KEY;
    var r = await fetch(FUNC, {
      method: 'POST',
      headers: { apikey: KEY, authorization: 'Bearer ' + bearer, 'content-type': 'application/json' },
      body: JSON.stringify(Object.assign({ action: action }, payload || {})),
    });
    var text = await r.text();
    var j = null;
    try { j = text ? JSON.parse(text) : null; } catch (e) { j = null; }
    if (!r.ok) throw Object.assign(new Error((j && j.error) || '认证失败'), { status: r.status, body: j });
    return j || {};
  }

  // 学号当成邮箱（Supabase 认证要邮箱格式）
  function toEmail(sid) {
    var s = String(sid || '').trim();
    return s.indexOf('@') >= 0 ? s : (s + '@stu.local');
  }

  async function signUp(sid, password) {
    var email = toEmail(sid);
    await call('/auth/v1/signup', {
      method: 'POST',
      body: JSON.stringify({ email: email, password: password }),
    });
    return signIn(sid, password);
  }

  async function signIn(sid, password) {
    var email = toEmail(sid);
    var s = await call('/auth/v1/token?grant_type=password', {
      method: 'POST',
      body: JSON.stringify({ email: email, password: password }),
    });
    setSession(s);
    return s;
  }

  async function signOut() {
    try { await call('/auth/v1/logout', { method: 'POST' }); } catch (e) {}
    clearSession();
  }

  async function currentUser() {
    if (!token()) return null;
    try {
      var u = await call('/auth/v1/user');
      var rows = await rest('profiles?id=eq.' + u.id + '&select=nickname');
      return {
        id: u.id,
        nickname: (rows && rows[0] && rows[0].nickname) || ('冀医' + String(u.id).slice(0, 5)),
        verify: 'none',
      };
    } catch (e) {
      return null;
    }
  }

  // ---------- 评论 ----------
  async function listComments(course, qid, limit, sort) {
    var q = 'comments?course_id=eq.' + enc(course) + '&qid=eq.' + enc(qid) + '&select=*&order=created_at.asc';
    if (limit) q += '&limit=' + limit;
    var rows = (await rest(q)) || [];
    var ids = rows.map(function (r) { return r.id; });
    var votes = ids.length ? ((await rest('comment_votes?comment_id=in.(' + ids.join(',') + ')&select=comment_id,value,user_id')) || []) : [];
    var agg = {};
    votes.forEach(function (v) {
      var a = agg[v.comment_id] || (agg[v.comment_id] = { likes: 0, dislikes: 0, mine: 0 });
      if (v.value > 0) a.likes++; else if (v.value < 0) a.dislikes++;
      if (v.user_id === uid()) a.mine = v.value;
    });
    var me = uid();
    var list = rows.map(function (r) {
      var a = agg[r.id] || { likes: 0, dislikes: 0, mine: 0 };
      return {
        id: r.id,
        parent_id: r.parent_id,
        user_id: r.user_id,
        nickname: r.nickname,
        body: r.body,
        tags: r.tags || '',
        reply_to_nick: r.reply_to_nick || '',
        quote_body: '',
        created_at: new Date(r.created_at).getTime(),
        likes: a.likes,
        dislikes: a.dislikes,
        mine: a.mine,
        isMine: !!me && r.user_id === me,
      };
    });
    list.sort(sort === 'new'
      ? function (a, b) { return b.created_at - a.created_at; }
      : function (a, b) { return (b.likes - a.likes) || (b.created_at - a.created_at); });
    return { comments: list, total: list.length, hasMore: false, myMistake: false, mistakeCount: 0 };
  }

  async function addComment(p) {
    var u = await currentUser();
    if (!u) throw Object.assign(new Error('请先登录'), { status: 401 });
    await rest('comments', {
      method: 'POST',
      body: JSON.stringify({
        course_id: p.course,
        qid: p.qid,
        parent_id: p.parentId || null,
        user_id: u.id,
        nickname: u.nickname,
        body: String(p.body || '').slice(0, 1000),
        tags: (p.tags || []).join(','),
        reply_to_nick: p.replyToNick || '',
      }),
      prefer: 'return=minimal',
    });
    return { ok: true };
  }

  async function voteComment(id, value) {
    var u = await currentUser();
    if (!u) throw Object.assign(new Error('请先登录'), { status: 401 });
    if (value === 0) {
      await rest('comment_votes?comment_id=eq.' + id + '&user_id=eq.' + u.id, { method: 'DELETE' });
    } else {
      await rest('comment_votes?on_conflict=comment_id,user_id', {
        method: 'POST',
        body: JSON.stringify({ comment_id: Number(id), user_id: u.id, value: value }),
        prefer: 'resolution=merge-duplicates,return=minimal',
      });
    }
    var rows = (await rest('comment_votes?comment_id=eq.' + id + '&select=value,user_id')) || [];
    var likes = 0, dislikes = 0, mine = 0;
    rows.forEach(function (r) {
      if (r.value > 0) likes++; else if (r.value < 0) dislikes++;
      if (r.user_id === u.id) mine = r.value;
    });
    return { likes: likes, dislikes: dislikes, mine: mine };
  }

  async function delComment(id) {
    var u = await currentUser();
    if (!u) throw Object.assign(new Error('请先登录'), { status: 401 });
    await rest('comments?id=eq.' + id + '&user_id=eq.' + u.id, { method: 'DELETE' });
    return { ok: true };
  }

  // ---------- 作答记录 / 正确率 ----------
  async function reportStat(course, qid, ok) {
    var u = await currentUser();
    if (!u) return { ok: false };
    await rest('attempts?on_conflict=course_id,qid,user_id', {
      method: 'POST',
      body: JSON.stringify({ course_id: course, qid: qid, user_id: u.id, ok: !!ok, updated_at: new Date().toISOString() }),
      prefer: 'resolution=merge-duplicates,return=minimal',
    });
    return { ok: true };
  }

  async function statOf(course, qid) {
    var r = await call('/rest/v1/rpc/question_stats', {
      method: 'POST',
      body: JSON.stringify({ p_course: course, p_qid: qid }),
    });
    var row = (r && r[0]) || { attempts: 0, correct: 0 };
    var n = Number(row.attempts || 0), c = Number(row.correct || 0);
    return { attempts: n, correct: c, rate: n ? Math.round(c / n * 100) : 0 };
  }

  // ---------- 进度同步 ----------
  var pushTimer = 0;
  async function pullProgress() {
    if (!token()) return null;
    try {
      var rows = await rest('progress?user_id=eq.' + uid() + '&select=data');
      return rows && rows[0] ? rows[0].data : null;
    } catch (e) { return null; }
  }
  async function pushProgress(data) {
    if (!token()) return;
    await rest('progress?on_conflict=user_id', {
      method: 'POST',
      body: JSON.stringify({ user_id: uid(), data: data, updated_at: new Date().toISOString() }),
      prefer: 'resolution=merge-duplicates,return=minimal',
    });
  }
  function schedulePush() {
    if (!token()) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(function () {
      try {
        var raw = localStorage.getItem(PKEY);
        if (!raw) return;
        pushProgress(JSON.parse(raw)).catch(function () {});
      } catch (e) {}
    }, 4000);
  }

  // ---------- 适配器 ----------
  window.__API_ADAPTER__ = async function (path, opts) {
    opts = opts || {};
    var method = (opts.method || 'GET').toUpperCase();
    var qIndex = path.indexOf('?');
    var pathname = qIndex >= 0 ? path.slice(0, qIndex) : path;
    var qs = new URLSearchParams(qIndex >= 0 ? path.slice(qIndex + 1) : '');
    var body = null;
    if (opts.body) { try { body = JSON.parse(opts.body); } catch (e) { body = null; } }
    var m;

    if (pathname === '/api/register' && method === 'POST') {
      var jr = await authProxy('register', { studentId: body.studentId, password: body.password });
      if (jr.session) setSession(jr.session);
      return { ok: true, nickname: jr.nickname || '冀医用户', userId: jr.userId, token: jr.session && jr.session.access_token };
    }
    if (pathname === '/api/login' && method === 'POST') {
      var jl = await authProxy('login', { studentId: body.studentId, password: body.password });
      if (jl.session) setSession(jl.session);
      return { ok: true, nickname: jl.nickname || '冀医用户', userId: jl.userId, token: jl.session && jl.session.access_token };
    }
    if (pathname === '/api/logout' && method === 'POST') {
      clearSession();
      return { ok: true };
    }
    if (pathname === '/api/me' && method === 'GET') {
      if (!token()) return { user: null };
      try {
        var mu = await call('/auth/v1/user');
        var mp = await rest('profiles?id=eq.' + mu.id + '&select=nickname');
        return { user: { id: mu.id, nickname: (mp && mp[0] && mp[0].nickname) || '冀医用户' } };
      } catch (e) {
        clearSession();
        return { user: null };
      }
    }
    if (pathname === '/api/comments' && method === 'GET') {
      return await listComments(qs.get('course'), qs.get('qid'), Number(qs.get('limit') || 0), qs.get('sort'));
    }
    if (pathname === '/api/comments' && method === 'POST') {
      return await addComment(body || {});
    }
    if ((m = pathname.match(/^\/api\/comments\/(\d+)\/vote$/)) && method === 'POST') {
      return await voteComment(m[1], body && body.value);
    }
    if ((m = pathname.match(/^\/api\/comments\/(\d+)$/)) && method === 'DELETE') {
      return await delComment(m[1]);
    }
    if (pathname === '/api/stats' && method === 'POST') {
      return await reportStat(body.course, body.qid, body.ok);
    }
    if (pathname === '/api/stats' && method === 'GET') {
      return await statOf(qs.get('course'), qs.get('qid'));
    }
    if (pathname === '/api/done' && method === 'POST') {
      return await reportStat(body.course, body.qkey, true);
    }
    if (pathname === '/api/mistake' && method === 'POST') {
      return { ok: true, unsupported: true };
    }
    if (pathname === '/api/forgot' && method === 'POST') {
      // 账号现在由旧服务器管，Supabase 这边改密码没用
      throw Object.assign(new Error('忘记密码请联系管理员（QQ 群 1047914312）重置'), { status: 400 });
    }
    if (pathname === '/api/reset' && method === 'POST') {
      throw Object.assign(new Error('忘记密码请联系管理员（QQ 群 1047914312）重置'), { status: 400 });
    }
    if (pathname === '/api/reports' && method === 'POST') {
      return { ok: true };
    }
    if (pathname.indexOf('/api/explanation') === 0) {
      return { body: '', version: 0, attempted: false, creatorNick: '', editorNick: '', mine: false, canEdit: false, canDelete: false };
    }
    if (pathname.indexOf('/api/submissions') === 0) {
      throw Object.assign(new Error('网页版不支持提交题目'), { status: 400 });
    }
    throw Object.assign(new Error('未知接口 ' + path), { status: 404 });
  };

  // 进度变化时自动推送（app.js 的 save() 会调用）
  window.__onSaveProgress = schedulePush;
  window.__pullCloudProgress = pullProgress;

  // 导出 / 导入
  window.__exportProgress = function () {
    try { return localStorage.getItem(PKEY) || '{}'; } catch (e) { return '{}'; }
  };
  window.__importProgress = function (json) {
    var data = JSON.parse(json);
    if (!data || typeof data !== 'object') throw new Error('不是有效的进度 JSON');
    localStorage.setItem(PKEY, JSON.stringify(data));
    return true;
  };

  console.log('[supabase] 适配层已启用:', BASE);
})();
