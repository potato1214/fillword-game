# 部署指南

本项目已经准备好 `Dockerfile` 和 `render.yaml`，推荐部署到 Render，部署成功后可以得到一个长期固定的公网地址。

## 自动部署

项目里提供了 `deploy.mjs`，可以自动完成“推送 GitHub + 创建 Render 服务”。使用前需要先准备两个令牌：

1. GitHub Personal Access Token（权限勾选 `repo`）。
2. Render API Key（Dashboard → Account Settings → API Keys）。

然后在终端设置环境变量：

```powershell
setx GITHUB_TOKEN "你的 GitHub Token"
setx RENDER_API_KEY "你的 Render API Key"
```

设置完成后重新打开终端，再执行：

```powershell
node deploy.mjs
```

脚本会自动创建名为 `fillword-game` 的 GitHub 仓库、推送代码，并在 Render 上创建 Docker Web Service。

## 方式一：部署到 Render（推荐）

1. 注册并登录 [Render](https://render.com)。
2. 把本项目推送到 GitHub：

   ```powershell
   git remote add origin https://github.com/<你的用户名>/fillword-game.git
   git branch -M main
   git push -u origin main
   ```

3. 在 Render 控制台点击 `New +`，选择 `Web Service`。
4. 连接你的 GitHub 仓库，选择 `fillword-game`。
5. 运行时选择 `Docker`，Render 会自动读取仓库里的 `Dockerfile`。
6. 点击 `Create Web Service`，等待构建完成。
7. 构建完成后，Render 会提供一个 `https://xxx.onrender.com` 的永久地址，直接发给朋友即可。

## 方式二：部署到 Railway

1. 注册并登录 [Railway](https://railway.app)。
2. 新建项目，选择 `Deploy from GitHub repo`，导入 `fillword-game` 仓库。
3. Railway 会自动识别 `Dockerfile` 并构建。
4. 构建完成后打开 `Generate Domain`，得到公网地址。

## 方式三：部署到 Fly.io

1. 安装 Fly CLI 并登录。
2. 在项目目录执行：

   ```powershell
   fly launch
   ```

3. 按提示选择地区和名称，Fly 会自动部署。

## 部署前确认

- 电脑上的本地服务和临时隧道不需要关闭，也不影响云端部署。
- 云端部署后，所有功能（内置剧本、粘贴挖空、网络热梗搜索、视频提示词）都会继续工作，因为服务端代码是完整打包进容器的。
