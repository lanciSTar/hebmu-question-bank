// 网页版启动器：读 data/index.json + 本机自建题库；题库搜索并进「搜索题库」输入框
(function () {
  var box = document.getElementById('drillBoot');
  var txt = document.getElementById('drillBootText');
  var sub = document.getElementById('drillBootSub');
  var params = new URLSearchParams(location.search);
  var cid = params.get('c');

  var IDX = [];
  var CUSTOM = [];
  var CUR = '';

  function fail(msg) {
    if (!box) return;
    box.innerHTML = '<div class="boot-title err">加载失败</div>' +
      '<div class="boot-sub">' + msg + '</div>' +
      '<div class="boot-hint">确认 data/ 目录存在，并且是用 http(s) 打开的（file:// 会被浏览器拦 fetch）。</div>';
  }

  function customBanks() {
    try {
      var raw = localStorage.getItem('hbmu_custom_banks');
      var arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }

  // 在「搜索题库 / 章节」输入框下面挂：当前题库 + 候选列表
  function mountPicker(course) {
    var search = document.getElementById('railSearch');
    if (!search || !search.parentNode) return;
    var holder = document.createElement('div');
    holder.id = 'webCourseBox';
    holder.innerHTML =
      '<div class="rail-course-cur" id="webCourseCur"></div>' +
      '<div class="rail-course-list" id="webCourseList" hidden></div>';
    search.parentNode.insertAdjacentElement('afterend', holder);

    var curEl = holder.querySelector('#webCourseCur');
    var listEl = holder.querySelector('#webCourseList');

    function setCur(name, n) {
      CUR = name;
      curEl.textContent = '当前：' + name + '（' + n + ' 题）';
    }
    // 用 app.js 实际选中的题库（它可能按上次进度换了库），不要用 URL 里的
    var active = (window.Drills && window.Drills.course) ? window.Drills.course : course;
    setCur(active.name, (active.questions || []).length);

    function items(kw) {
      var k = String(kw || '').trim().toLowerCase();
      var all = [];
      IDX.forEach(function (c) { all.push({ id: c.id, name: c.name, n: c.count, custom: false }); });
      CUSTOM.forEach(function (c) {
        all.push({ id: c.id, name: c.name, n: (c.questions || []).length, custom: true });
      });
      if (!k) return all;   // 点开就列出全部，可以直接选
      return all.filter(function (c) {
        return String(c.name).toLowerCase().indexOf(k) >= 0 || String(c.id).indexOf(k) >= 0;
      });
    }

    function render(kw, force) {
      var k = String(kw || '').trim();
      if (!k && !force) {
        listEl.hidden = true;
        curEl.hidden = false;
        return;
      }
      curEl.hidden = true;
      listEl.hidden = false;
      var list = items(k);
      listEl.innerHTML = '';
      if (!list.length) {
        listEl.innerHTML = '<div class="rail-course-empty">没有匹配的题库</div>';
        return;
      }
      // 顶部一行：可选、也可搜
      var head = document.createElement('div');
      head.className = 'rail-course-hd';
      head.textContent = k
        ? '搜到 ' + list.length + ' 个'
        : '共 ' + list.length + ' 个 · 输入可搜';
      listEl.appendChild(head);
      list.forEach(function (c) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'rail-course-item';
        b.innerHTML = '<span class="nm"></span><span class="nn"></span>';
        b.querySelector('.nm').textContent = c.name + (c.custom ? '（自建）' : '');
        b.querySelector('.nn').textContent = c.n + ' 题';
        if (String(c.id) === String(CUR_ID)) b.setAttribute('aria-current', 'true');
        b.addEventListener('mousedown', function (e) { e.preventDefault(); }); // 别让输入框先失焦
        b.addEventListener('click', function () {
          search.value = '';
          listEl.hidden = true;
          curEl.hidden = false;
          if (c.custom && window.Drills && window.Drills.selectCourse) {
            window.Drills.selectCourse(c.id);
            setCur(c.name, c.n);
            history.replaceState(null, '', '?c=' + encodeURIComponent(c.id));
          } else {
            location.href = '?c=' + encodeURIComponent(c.id);
          }
        });
        listEl.appendChild(b);
      });
    }

    // 点一下输入框就把题库列出来
    search.addEventListener('focus', function () { render(search.value, true); });
    search.addEventListener('click', function () { render(search.value, true); });
    search.addEventListener('input', function () { render(search.value, true); });
    search.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { search.value = ''; render('', false); }
    });
    search.addEventListener('blur', function () {
      // 等点击事件处理完再收
      setTimeout(function () {
        if (!listEl.matches(':hover')) { listEl.hidden = true; curEl.hidden = false; }
      }, 180);
    });

    // 记下当前题库 id 供高亮
    window.__CUR_COURSE_ID__ = String(active.id);
    CUR_ID = String(active.id);
  }

  var CUR_ID = '';

  (async function () {
    try {
      var res = await fetch('data/index.json', { cache: 'no-store' });
      if (!res.ok) throw new Error('找不到 data/index.json（HTTP ' + res.status + '）');
      IDX = await res.json();
      CUSTOM = customBanks();

      if (!cid) cid = (IDX[0] || {}).id;
      if (!cid && !CUSTOM.length) throw new Error('题库清单是空的');

      var custom = CUSTOM.find(function (c) { return String(c.id) === String(cid); });
      var meta = IDX.find(function (c) { return String(c.id) === String(cid); });

      if (txt) txt.textContent = '正在加载 ' + (custom ? custom.name : (meta ? meta.name : cid));
      if (sub && meta) sub.textContent = '题库约 ' + Math.max(1, Math.round(meta.size / 1024)) + ' KB';

      var course = null;
      if (custom) {
        course = custom;
      } else {
        var cres = await fetch('data/' + encodeURIComponent(cid) + '.json', { cache: 'no-store' });
        if (!cres.ok) throw new Error('找不到题库文件（HTTP ' + cres.status + '）');
        course = await cres.json();
      }

      window.__SERVER__ = '';

      if (typeof window.__pullCloudProgress === 'function') {
        try {
          var cloud = await window.__pullCloudProgress();
          var KEY = 'epi-trainer-v2:dev';
          var localRaw = localStorage.getItem(KEY);
          var localEmpty = !localRaw || localRaw === '{}' || !Object.keys(JSON.parse(localRaw)).length;
          if (cloud && Object.keys(cloud).length && localEmpty) {
            localStorage.setItem(KEY, JSON.stringify(cloud));
          }
        } catch (e) {}
      }

      var others = CUSTOM.filter(function (c) { return String(c.id) !== String(course.id); });
      window.__startDrill({ version: 2, courses: [course].concat(others) });

      mountPicker(course);
      if (box) box.remove();
      document.body.dataset.booted = '1';
      document.title = course.name + ' · 河北医科大学题库刷题';
    } catch (e) {
      fail((e && e.message) || String(e));
    }
  })();
})();
