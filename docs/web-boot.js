// 网页版启动器：纯静态，不连任何后端；题库来自 data/*.json
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

  (async function () {
    try {
      var res = await fetch('data/index.json', { cache: 'no-store' });
      if (!res.ok) throw new Error('找不到 data/index.json（HTTP ' + res.status + '）');
      var idx = await res.json();

      if (sel) {
        sel.innerHTML = '';
        idx.forEach(function (c) {
          var o = document.createElement('option');
          o.value = c.id;
          o.textContent = c.name + '（' + c.count + ' 题）';
          sel.appendChild(o);
        });
      }
      if (!cid) cid = (idx[0] || {}).id;
      if (!cid) throw new Error('题库清单是空的');
      if (sel) sel.value = cid;

      var meta = idx.find(function (c) { return String(c.id) === String(cid); });
      if (txt) txt.textContent = '正在加载 ' + (meta ? meta.name : cid);
      if (sub) sub.textContent = '题库约 ' + Math.max(1, Math.round(((meta && meta.size) || 0) / 1024)) + ' KB';

      var cres = await fetch('data/' + encodeURIComponent(cid) + '.json', { cache: 'no-store' });
      if (!cres.ok) throw new Error('找不到题库文件（HTTP ' + cres.status + '）');
      var course = await cres.json();

      // 网页版是纯静态：不连自建服务器；配了 Supabase 才走适配层
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

      window.__startDrill({ version: 2, courses: [course] });
      if (box) box.remove();
      document.body.dataset.booted = '1';
      document.title = course.name + ' · 河北医科大学题库刷题';
    } catch (e) {
      fail((e && e.message) || String(e));
    }
  })();

  if (sel) {
    sel.addEventListener('change', function () {
      location.href = '?c=' + encodeURIComponent(sel.value);
    });
  }
})();
