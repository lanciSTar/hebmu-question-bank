// 生成网页版 index.html（从 drill.html 注入，去掉扩展专用的 inject.js）
import fs from 'node:fs';

let html = fs.readFileSync('_ext/drill.html', 'utf8');

// 1) head 里加 chrome.storage 垫片 + 网页模式标记 + Supabase 配置/适配层
html = html.replace('</head>', [
  '<link rel="stylesheet" href="web.css">',
  '<script src="mock-chrome.js"></script>',
  '<script src="config.js"></script>',
  '<script src="web-supabase.js"></script>',
  '<script>window.__WEB_MODE__ = true;</script>',
  '</head>',
].join('\n'));

// 2) 去掉 inject.js / inject.css（那是扩展里的「全部题库」「查看原题」，网页版用不上）
html = html.replace('<link rel="stylesheet" href="inject.css">', '');
html = html.replace('<script src="inject.js"></script>', '');

// 3) body 开头加课程切换条
html = html.replace('<body data-view="setup">', `<body data-view="setup">
<div class="web-bar">
  <a class="web-brand" href="./">河北医科大学题库刷题</a>
  <select id="webCourse" title="切换题库"></select>
  <a class="web-link" href="download.html">题库下载</a>
</div>`);

// 4) app.js 之后加载网页启动器
html = html.replace('<script src="app.js"></script>', '<script src="app.js"></script>\n<script src="web-boot.js"></script>');

fs.writeFileSync('_site_web/index.html', html, 'utf8');
console.log('index.html 生成，长度', html.length);
