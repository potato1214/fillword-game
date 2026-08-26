import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const workDir = resolve(scriptDir, "..", "..", "work");

function readToken(envName, fileName) {
  for (const name of [fileName, `${fileName}.txt`]) {
    const filePath = join(workDir, name);
    if (existsSync(filePath)) {
      return readFileSync(filePath, "utf8").trim();
    }
  }
  const envValue = process.env[envName] || "";
  if (envValue && /^[\x00-\x7F]*$/.test(envValue) && !envValue.includes("你的")) {
    return envValue.trim();
  }
  return "";
}

const githubToken = readToken("GITHUB_TOKEN", "github_token.txt");
if (!githubToken) {
  console.error("缺少 GITHUB_TOKEN：请设置环境变量，或在 work/github_token.txt 中写入真实令牌");
  process.exit(1);
}

console.log("step: 读取 GitHub 用户信息");
const github = async (path, options = {}) => {
  const res = await fetch(`https://api.github.com${path}`, {
    method: options.method || "GET",
    headers: {
      Authorization: `Bearer ${githubToken}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "fillword-game-deploy",
      "Content-Type": "application/json",
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json();
  return { status: res.status, data };
};

const user = await github("/user");
if (user.status !== 200) {
  console.error("GitHub 令牌无效或权限不足", user.status, JSON.stringify(user.data));
  process.exit(1);
}
const login = user.data.login;
const repoName = "fillword-game";
const repoPath = `repos/${login}/${repoName}`;

console.log("step: 检查 GitHub 仓库");
let repo = await github(`/${repoPath}`);
if (repo.status === 404) {
  console.log("step: 创建 GitHub 仓库");
  const created = await github("/user/repos", {
    method: "POST",
    body: { name: repoName, private: false, description: "填字游戏网站" },
  });
  if (created.status !== 201) {
    console.error("创建 GitHub 仓库失败", created.status, JSON.stringify(created.data));
    process.exit(1);
  }
  repo = created;
  console.log("已创建 GitHub 仓库");
} else {
  console.log("GitHub 仓库已存在");
  if (repo.data?.private) {
    console.log("step: 将 GitHub 仓库设为公开，供 Render 拉取");
    const patched = await github(`/${repoPath}`, {
      method: "PATCH",
      body: { private: false },
    });
    if (patched.status !== 200) {
      console.error("设置仓库为公开失败", patched.status, JSON.stringify(patched.data));
      process.exit(1);
    }
    repo = patched;
    console.log("GitHub 仓库已设为公开");
  }
}

const cleanRepoUrl = `https://github.com/${login}/${repoName}.git`;
const tokenRepoUrl = `https://x-access-token:${githubToken}@github.com/${login}/${repoName}.git`;

function collectFiles(dir = scriptDir, prefix = "") {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFiles(full, rel));
    } else {
      files.push(rel);
    }
  }
  return files;
}

async function pushViaApi() {
  for (const rel of collectFiles()) {
    const content = readFileSync(join(scriptDir, rel));
    const encodedPath = rel.split("/").map(encodeURIComponent).join("/");
    const body = {
      message: `Add ${rel}`,
      content: content.toString("base64"),
    };
    const existing = await github(`/repos/${login}/${repoName}/contents/${encodedPath}`);
    if (existing.status === 200) {
      const remoteContent = Buffer.from(existing.data.content, "base64");
      if (remoteContent.equals(content)) {
        console.log("无变化，跳过", rel);
        continue;
      }
      body.sha = existing.data.sha;
    }
    const res = await fetch(
      `https://api.github.com/repos/${login}/${repoName}/contents/${encodedPath}`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${githubToken}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "fillword-game-deploy",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
    );
    if (!res.ok) {
      const data = await res.json();
      throw new Error(`上传 ${rel} 失败: ${res.status} ${JSON.stringify(data)}`);
    }
    console.log("已上传", rel);
  }
}

console.log("step: 配置 git remote 并推送");
try {
  execFileSync("git", ["config", "--global", "--add", "safe.directory", scriptDir], {
    stdio: "ignore",
  });
} catch {
  // 已存在该配置时忽略
}
try {
  execFileSync("git", ["remote", "remove", "origin"], { cwd: scriptDir, stdio: "ignore" });
} catch {
  // 没有 origin 也正常
}
execFileSync("git", ["remote", "add", "origin", tokenRepoUrl], { cwd: scriptDir });
console.log("使用 GitHub API 上传代码");
await pushViaApi();
execFileSync("git", ["remote", "set-url", "origin", cleanRepoUrl], { cwd: scriptDir });
console.log("代码已推送到", cleanRepoUrl);

const renderKey = readToken("RENDER_API_KEY", "render_key.txt");
if (!renderKey) {
  console.log("未设置 RENDER_API_KEY，跳过 Render 部署");
  process.exit(0);
}

const renderServiceName = "fillword-game-v2";
console.log("step: 检查 Render 服务");
console.log("step: 获取 Render 工作区");
const ownersRes = await fetch("https://api.render.com/v1/owners", {
  headers: {
    Authorization: `Bearer ${renderKey}`,
  },
});
const ownersData = await ownersRes.json();
if (!ownersRes.ok) {
  console.error("获取 Render 工作区失败", ownersRes.status, JSON.stringify(ownersData));
  process.exit(1);
}
const ownerCandidates = Array.isArray(ownersData)
  ? ownersData.map((item) => item.owner || item).filter(Boolean)
  : [];
const owner = ownerCandidates.find((item) => String(item.id).startsWith("tea-")) || ownerCandidates[0] || null;
if (!owner?.id) {
  console.error("未找到可用的 Render 工作区", JSON.stringify(ownersData));
  process.exit(1);
}
console.log("使用 Render 工作区：", owner.name || owner.email || owner.id, "（", owner.id, "）");

const renderHeaders = {
  Authorization: `Bearer ${renderKey}`,
  "Content-Type": "application/json",
};
const existingServicesRes = await fetch(
  `https://api.render.com/v1/services?ownerId=${encodeURIComponent(owner.id)}`,
  { headers: renderHeaders },
);
const existingServicesData = await existingServicesRes.json();
const existingService =
  (Array.isArray(existingServicesData) &&
    existingServicesData
      .map((item) => item.service || item)
      .find((item) => item.name === renderServiceName)) ||
  null;
if (existingService) {
  console.log("Render 服务已存在，无需重复创建");
  console.log("Render 服务 ID：", existingService.id);
  console.log("Render 服务地址：", `https://${existingService.slug || renderServiceName}.onrender.com`);
  process.exit(0);
}

console.log("step: 创建 Render 服务");
const renderRes = await fetch("https://api.render.com/v1/services", {
  method: "POST",
  headers: renderHeaders,
  body: JSON.stringify({
    type: "web_service",
    name: renderServiceName,
    ownerId: owner.id,
    repo: `https://github.com/${login}/${repoName}`,
    branch: "main",
    autoDeploy: "yes",
    serviceDetails: {
      runtime: "docker",
      plan: "free",
      region: "singapore",
      numInstances: 1,
      envSpecificDetails: {
        dockerfilePath: "./Dockerfile",
        dockerContext: ".",
      },
    },
  }),
});
const renderData = await renderRes.json();
if (!renderRes.ok) {
  console.error("Render 创建服务失败", renderRes.status, JSON.stringify(renderData));
  process.exit(1);
}
const service = renderData.service || renderData;
console.log("Render 服务已创建，服务 ID：", service.id);
console.log("Render 服务地址：", `https://${service.slug || renderServiceName}.onrender.com`);
