// 网页版启动器：读 data/index.json + 本机自建题库，交给 app.js 渲染
(function () {
  var box = document.getElementById('drillBoot');
  var txt = document.getElementById('drillBootText');
  var sub = document.getElementById('drillBootSub');
  var sel = document.getElementById('webCourse');
  var params = new URLSearchParams(location.search);
  var cid = params.get('c');

  function fail(msg) {
    if (!box) return;
    box.innerHTML = '<div class="boot-title err">加载失败</div>' +
      '<div class="boot-sub">' + msg + '</div>' +
      '<div class="boot-hint">确认 data/ 目录存在，并且是用 http(s) 打开的（file:// 会被浏览器拦 fetch）。</div>';
  }

  // 本机自建题库（在题库缓存里导入的）
  function customBanks() {
    try {
      var raw = localStorage.getItem('hbmu_custom_banks');
      var arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }

  function fillSelect(indexList, customList, currentId) {
    if (!sel) return;
    sel.innerHTML = '';
    indexList.forEach(function (c) {
      var o = document.createElement('option');
      o.value = c.id;
      o.textContent = c.name + '（' + c.count + ' 题）';
      sel.appendChild(o);
    });
    customList.forEach(function (c) {
      var o = document.createElement('option');
      o.value = c.id;
      o.textContent = c.name + '（自建 · ' + (c.questions || []).length + ' 题）';
      sel.appendChild(o);
    });
    var want = currentId || (indexList[0] || {}).id;
    if (want) sel.value = want;
  }

  (async function () {
    try {
      var res = await fetch('data/index.json', { cache: 'no-store' });
      if (!res.ok) throw new Error('找不到 data/index.json（HTTP ' + res.status + '）');
      var idx = await res.json();
      var customs = customBanks();

      if (!cid) cid = (idx[0] || {}).id;
      if (!cid && !customs.length) throw new Error('题库清单是空的');

      var custom = customs.find(function (c) { return String(c.id) === String(cid); });
      var meta = idx.find(function (c) { return String(c.id) === String(cid); });

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

      // 登录状态下，如果本地没进度，把云端进度拉下来
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

      // 当前题库 + 其他自建题库一起交给 app.js（这样「新增题目」能加到自建库里）
      var others = customs.filter(function (c) { return String(c.id) !== String(course.id); });
      window.__startDrill({ version: 2, courses: [course].concat(others) });

      fillSelect(idx, customs, course.id);
      if (box) box.remove();
      document.body.dataset.booted = '1';
      document.title = course.name + ' · 河北医科大学题库刷题';
    } catch (e) {
      fail((e && e.message) || String(e));
    }
  })();

  if (sel) {
    sel.addEventListener('change', function () {
      var v = sel.value;
      if (/^custom-/.test(v) && window.Drills && window.Drills.selectCourse) {
        // 自建题库存本机，直接切换，不用重新加载页面
        window.Drills.selectCourse(v);
        history.replaceState(null, '', '?c=' + encodeURIComponent(v));
      } else {
        location.href = '?c=' + encodeURIComponent(v);
      }
    });
  }
})();
