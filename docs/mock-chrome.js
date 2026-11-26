// WebView 里没有 chrome.storage，用 localStorage 模拟
(function () {
  window.chrome = window.chrome || {};
  if (!window.chrome.storage) {
    window.chrome.storage = {
      local: {
        get: function (keys) {
          var out = {};
          var list = Array.isArray(keys) ? keys : (typeof keys === 'string' ? [keys] : Object.keys(keys || {}));
          for (var i = 0; i < list.length; i++) {
            var k = list[i];
            var v = localStorage.getItem('__mock_' + k);
            if (v !== null) { try { out[k] = JSON.parse(v); } catch (e) { out[k] = v; } }
            else if (keys && typeof keys === 'object' && !Array.isArray(keys) && k in keys) out[k] = keys[k];
          }
          return Promise.resolve(out);
        },
        set: function (obj) {
          for (var k in obj) localStorage.setItem('__mock_' + k, JSON.stringify(obj[k]));
          return Promise.resolve();
        },
        remove: function (keys) {
          var list = Array.isArray(keys) ? keys : [keys];
          for (var i = 0; i < list.length; i++) localStorage.removeItem('__mock_' + list[i]);
          return Promise.resolve();
        },
      },
    };
  }
  if (!window.chrome.runtime) {
    window.chrome.runtime = { getURL: function (p) { return p; }, sendMessage: function () { return Promise.reject(new Error('no runtime')); } };
  }
})();
