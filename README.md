# 填字游戏网站

一个把观众回答填进剧本的网页游戏，支持内置剧本、粘贴台词自动挖空、网络热梗搜索和视频提示词导出。

## 项目结构

```text
fillword-game/
├── server.js          # Node 服务端：出题、挖空、回填、网络搜索、视频提示词
├── scripts.json       # 内置剧本库，可手动新增或修改剧本
├── package.json       # Node 项目配置
├── Dockerfile         # 云端部署用
├── render.yaml        # Render 云平台部署配置
└── public/            # 前端页面
    ├── index.html
    ├── styles.css
    ├── app.js
    └── favicon.svg
```

## 本地运行

```powershell
node server.js
```

然后打开 `http://localhost:3000`。

## 常用修改入口

- 加剧本、改台词、改挖空提示：编辑 `scripts.json`。空格格式为 `{{提示词|原文}}`，同一个词重复出现时只问一次。
- 改挖空规则、搜索逻辑、视频提示词生成：编辑 `server.js`。
- 改页面布局和样式：编辑 `public/styles.css`。
- 改前端交互：编辑 `public/app.js`。
- 改页面结构：编辑 `public/index.html`。

## 继续用 Codex 改进

直接告诉 Codex 你想改什么即可，例如：

- 增加一个新热梗剧本。
- 让某个剧本的提示词更贴合上下文。
- 调整网络热梗搜索来源。
- 把界面改成另一种风格。

Codex 会直接修改对应文件并重新启动服务。

## 部署到云端

项目已包含 `Dockerfile` 和 `render.yaml`。推荐流程：

1. 把 `fillword-game` 文件夹推送到 GitHub。
2. 在 [Render](https://render.com) 新建 Web Service。
3. 选择仓库和 Docker 部署方式。
4. 部署完成后会得到一个长期有效的公网地址。

## 临时公网链接

使用 localhost.run 之类的隧道可以让手机暂时访问，但链接会在电脑关机、网络变化或隧道断开后失效。需要长期固定地址时，请使用云端部署。
