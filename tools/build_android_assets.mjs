// 生成安卓离线资源：ui.html（独立页面，也能被注入模式复用）+ banks/*.js + app.js/app.css
import fs from 'node:fs';
import path from 'node:path';

const ASSETS = '_android/app/src/main/assets';
const DATA = 'docs/data';
fs.mkdirSync(path.join(ASSETS, 'banks'), { recursive: true });

// ---------- 1) ui.html ----------
let html = fs.readFileSync('_ext/drill.html', 'utf8');
html = html.replace('<link rel="stylesheet" href="inject.css">', '');
html = html.replace('<script src="inject.js"></script>', '');
html = html.replace('</head>', [
  '<script>window.__WEB_MODE__ = true;</script>',
  '</head>',
].join('\n'));
html = html.replace('<script src="app.js"></script>', [
  '<script src="app.js"></script>',
  '<script src="offline-boot.js"></script>',
].join('\n'));
// 安卓 WebView 没有 chrome.storage，独立页面里要自己垫
html = html.replace('<script src="course-index.js"></script>',
  '<script src="mock-chrome.js"></script>\n<script src="course-index.js"></script>');
fs.writeFileSync(path.join(ASSETS, 'ui.html'), html, 'utf8');
console.log('ui.html', html.length);

// ---------- 2) 同步 3.7.0 的前端 ----------
fs.copyFileSync('_ext/app.js', path.join(ASSETS, 'app.js'));
fs.copyFileSync('_ext/app.css', path.join(ASSETS, 'app.css'));
fs.copyFileSync('_ext/cache.js', path.join(ASSETS, 'cache.js'));
console.log('app.js / app.css / cache.js 已同步');

// ---------- 3) banks/*.js ----------
const idx = JSON.parse(fs.readFileSync(path.join(DATA, 'index.json'), 'utf8'));
for (const c of idx) {
  const course = fs.readFileSync(path.join(DATA, c.id + '.json'), 'utf8');
  const js = 'window.__BANKS__=window.__BANKS__||{};window.__BANKS__[' + JSON.stringify(String(c.id)) + ']=' + course + ';';
  fs.writeFileSync(path.join(ASSETS, 'banks', c.id + '.js'), js, 'utf8');
}
fs.writeFileSync(
  path.join(ASSETS, 'banks', 'index.js'),
  'window.__BANK_INDEX__=' + JSON.stringify(idx.map(c => ({ id: String(c.id), name: c.name, count: c.count }))) + ';',
  'utf8'
);
const total = idx.reduce((s, c) => s + fs.statSync(path.join(ASSETS, 'banks', c.id + '.js')).size, 0);
console.log('banks:', idx.length, '门，', (total / 1024 / 1024).toFixed(2), 'MB');
