// 把 _site_web 整理成可发布的仓库结构（docs/ 作为 GitHub Pages 根目录）
import fs from 'node:fs';
import path from 'node:path';

const SRC = '_site_web';
const DEST = 'docs';

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    const s = path.join(src, name);
    const d = path.join(dest, name);
    if (fs.statSync(s).isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

if (fs.existsSync(DEST)) fs.rmSync(DEST, { recursive: true, force: true });
copyDir(SRC, DEST);

// GitHub Pages 默认会跑 Jekyll，关掉，避免下划线开头的文件被忽略
fs.writeFileSync(path.join(DEST, '.nojekyll'), '', 'utf8');

// 根目录的 LICENSE（MIT）
fs.writeFileSync('LICENSE', `MIT License

Copyright (c) 2026 河北医科大学题库刷题

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`, 'utf8');

// .gitignore：不把构建产物和抓取缓存推上去
fs.writeFileSync('.gitignore', [
  '_android_sdk/',
  '_tools/gradle-8.2/',
  '_testdeps/',
  '_banks/',
  '_build/',
  '_login/',
  '_ext_backup_*/',
  '_ziptest_ext/',
  '*.log',
  'node_modules/',
].join('\n') + '\n', 'utf8');

const count = (p) => {
  let n = 0, size = 0;
  const walk = (d) => {
    for (const f of fs.readdirSync(d)) {
      const fp = path.join(d, f);
      const st = fs.statSync(fp);
      if (st.isDirectory()) walk(fp); else { n++; size += st.size; }
    }
  };
  walk(p);
  return { n, size };
};
const { n, size } = count(DEST);
console.log('docs/ 文件数:', n, '大小:', (size / 1024 / 1024).toFixed(2), 'MB');
