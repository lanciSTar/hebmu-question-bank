# 河北医科大学题库刷题

在线刷题 + 题库下载。纯静态，零后端，进度存在浏览器本地。

## 在线用

- 刷题：仓库 Pages 首页，右下角可以切换题库
- 下载题库：`download.html`，按课程拆分，可单独下载 JSON

## 本地预览

```bash
node _tools/serve_site.mjs
# 打开 http://127.0.0.1:8123
```

（也可以随便用 `python -m http.server`，但必须用 http 打开，`file://` 下 fetch 会被浏览器拦。）

## 后端（可选）

默认是纯静态，不连任何服务器。想要讨论区、全校正确率、跨设备进度，就接 Supabase：

1. 按 [SUPABASE-接入说明.md](../SUPABASE-接入说明.md) 建项目、跑 SQL
2. 把 Project URL 和 anon key 填进 `config.js`
3. 重新生成 `index.html`（`node _tools/build_site_entry.mjs`）后推上去

没填 `config.js` 时：不登录也能刷题，进度存浏览器本地，可以用「我的账户 → 进度导出/导入」换设备。

填了之后：不登录仍可刷题；登录后才能发评论、看全校正确率、进度自动同步到云端。

## 目录

```
index.html          刷题页（由扩展的 drill.html 生成）
web-boot.js         网页启动器：读 data/index.json、加载题库、调起刷题界面
web.css             网页版专用的题库切换条样式
download.html       题库下载页
data/index.json     课程清单（id / 名字 / 题数 / 大小）
data/<id>.json      每门课一个文件，结构是 { id, name, chapters, groups, questions }
```

题目字段：

```json
{
  "id": "160-5902",
  "ch": "外科总论",
  "t": "论述题",
  "atid": "6",
  "q": "题干",
  "a": "标准答案",
  "o": ["A. 选项一", "B. 选项二"],
  "ex": "解析（可为空）",
  "blank": ["填空1", "填空2"]
}
```

- `atid`：`0` 单选 / `1` 多选 / `6` 主观或填空
- `blank`：填空题专用，题干里用 `{{ANS}}` 占位
- 解析里可以用 `{{OPT:2}}` 引用第 2 个选项

## 说明

- 纯静态：不连任何 API，所以没有讨论区、没有在线解析编辑、没有全校正确率。
- 进度、收藏、错题存在浏览器 localStorage，换设备或清缓存会丢。
- 题库来自学校题库系统的整理，仅供学习使用。
