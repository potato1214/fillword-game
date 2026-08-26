const state = {
  scripts: [],
  script: null,
  blankCount: 8,
  round: null,
  result: null,
  showOriginal: false,
};

const $ = (selector) => document.querySelector(selector);

const librarySection = $("#library");
const setupSection = $("#setup");
const playSection = $("#play");
const resultSection = $("#result");
const toast = $("#toast");

function show(section) {
  [librarySection, setupSection, playSection, resultSection].forEach((el) =>
    el.classList.add("hidden"),
  );
  section.classList.remove("hidden");
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.remove("hidden");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.add("hidden"), 2600);
}

function isWebUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

async function api(url, options = {}) {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || "请求失败");
  }
  return data;
}

function renderScripts() {
  scriptGrid.replaceChildren();
  $("#script-count").textContent = `${state.scripts.length} 个剧本`;
  for (const script of state.scripts) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "script-card";
    const title = document.createElement("h3");
    title.textContent = script.title;
    const tag = document.createElement("span");
    tag.className = "tag";
    tag.textContent = script.source;
    const desc = document.createElement("p");
    desc.textContent = script.description;
    card.append(title, tag, desc);
    card.addEventListener("click", () => selectScript(script));
    scriptGrid.append(card);
  }
}

function selectScript(script) {
  state.script = script;
  state.showOriginal = false;
  $("#setup-title").textContent = script.title;
  $("#setup-desc").textContent = `${script.source} · 全剧本 ${script.slotCount} 个可挖空词`;
  show(setupSection);
}

function bindBlankCount() {
  $("#blank-count").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-count]");
    if (!button) return;
    state.blankCount = Number(button.dataset.count);
    document.querySelectorAll("#blank-count button").forEach((el) => {
      el.classList.toggle("active", el === button);
    });
  });
}

async function startRound() {
  try {
    const data = await api("/api/round", {
      method: "POST",
      body: JSON.stringify({
        scriptId: state.script.id,
        blankCount: state.blankCount,
      }),
    });
    state.round = data;
    renderPrompts(data.prompts);
    $("#play-title").textContent = data.scriptTitle;
    show(playSection);
    $("#prompt-list").firstElementChild?.querySelector("input")?.focus();
  } catch (err) {
    showToast(err.message);
  }
}

async function handleSearch() {
  const value = $("#meme-search").value.trim();
  if (!value) return;
  const match = state.scripts.find(
    (script) =>
      value.includes(script.title) ||
      script.title.includes(value) ||
      script.id.includes(value) ||
      script.source.includes(value),
  );
  if (match) {
    selectScript(match);
    return;
  }
  if (isWebUrl(value)) {
    await searchNetwork(value);
    return;
  }
  if (value.includes("\n") || value.length >= 20) {
    try {
      const data = await api("/api/custom/round", {
        method: "POST",
        body: JSON.stringify({
          text: value,
          blankCount: state.blankCount,
        }),
      });
      state.script = {
        id: data.scriptId,
        title: data.scriptTitle,
        source: "用户粘贴",
        slotCount: data.prompts.length,
      };
      state.round = data;
      renderPrompts(data.prompts);
      $("#play-title").textContent = data.scriptTitle;
      show(playSection);
    } catch (err) {
      showToast(err.message);
    }
    return;
  }
  await searchNetwork(value);
}

async function searchNetwork(keyword) {
  const button = $("#search-btn");
  const results = $("#network-results");
  button.disabled = true;
  button.textContent = "搜索中";
  results.classList.remove("hidden");
  results.replaceChildren();
  const loading = document.createElement("p");
  loading.className = "muted";
  loading.textContent = "正在全网搜索台词…";
  results.append(loading);
  try {
    const data = isWebUrl(keyword)
      ? await api("/api/fetch/script", {
          method: "POST",
          body: JSON.stringify({ url: keyword }),
        })
      : await api(`/api/search?q=${encodeURIComponent(keyword)}`);
    renderNetworkResults(data.results);
  } catch (err) {
    results.replaceChildren();
    const message = document.createElement("p");
    message.className = "muted";
    message.textContent = err.message;
    results.append(message);
  } finally {
    button.disabled = false;
    button.textContent = "生成";
  }
}

function renderNetworkResults(items) {
  const results = $("#network-results");
  results.replaceChildren();
  const head = document.createElement("div");
  head.className = "network-head";
  head.textContent = `找到 ${items.length} 个相关剧本`;
  results.append(head);
  for (const item of items) {
    const card = document.createElement("div");
    card.className = "network-card";
    const title = document.createElement("h3");
    title.textContent = item.title;
    const link = document.createElement("a");
    link.href = item.url;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.textContent = item.url;
    const meta = document.createElement("span");
    meta.className = "tag";
    meta.textContent = item.fallback ? "搜索摘要" : "已抓取全文";
    const snippet = document.createElement("p");
    snippet.textContent = item.snippet;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "primary-button";
    button.textContent = "使用这个剧本";
    button.addEventListener("click", () => startNetworkRound(item));
    card.append(title, link, meta, snippet, button);
    results.append(card);
  }
}

async function startNetworkRound(item) {
  try {
    const data = await api("/api/network/round", {
      method: "POST",
      body: JSON.stringify({
        title: item.title,
        url: item.url,
        text: item.text,
        blankCount: state.blankCount,
      }),
    });
    state.script = {
      id: data.scriptId,
      title: data.scriptTitle,
      source: "网络热梗",
      slotCount: data.prompts.length,
    };
    state.round = data;
    renderPrompts(data.prompts);
    $("#play-title").textContent = data.scriptTitle;
    show(playSection);
  } catch (err) {
    showToast(err.message);
  }
}

function renderPrompts(prompts) {
  const list = $("#prompt-list");
  list.replaceChildren();
  for (const prompt of prompts) {
    const item = document.createElement("div");
    item.className = "prompt-item";
    const number = document.createElement("span");
    number.className = "prompt-number";
    number.textContent = prompt.order;
    const body = document.createElement("div");
    const label = document.createElement("p");
    label.className = "prompt-label";
    label.textContent = prompt.hint;
    const input = document.createElement("input");
    input.className = "prompt-input";
    input.type = "text";
    input.maxLength = 40;
    input.name = `blank-${prompt.index}`;
    input.autocomplete = "off";
    input.placeholder = "填在这里";
    body.append(label, input);
    item.append(number, body);
    list.append(item);
  }
}

async function submitAnswers(event) {
  event.preventDefault();
  const answers = {};
  for (const prompt of state.round.prompts) {
    const input = document.querySelector(`input[name="blank-${prompt.index}"]`);
    answers[prompt.index] = input ? input.value.trim() : "";
  }
  try {
    const data = await api("/api/fill", {
      method: "POST",
      body: JSON.stringify({ roundId: state.round.roundId, answers }),
    });
    renderResult(data);
  } catch (err) {
    showToast(err.message);
  }
}

function renderResult(data) {
  state.result = data;
  state.showOriginal = false;
  $("#result-title").textContent = data.scriptTitle;
  $("#toggle-original").textContent = "查看原剧本";
  renderScriptView(data.filledSegments);
  loadVideoPrompt();
  show(resultSection);
}

function renderScriptView(segments) {
  const view = $("#script-view");
  view.replaceChildren();
  for (const segment of segments) {
    const node = document.createElement("span");
    node.className =
      segment.type === "answer" ? "answer" : segment.type === "blank" ? "blank" : "";
    node.textContent = segment.value;
    view.append(node);
  }
}

function toggleOriginal() {
  if (!state.result) return;
  state.showOriginal = !state.showOriginal;
  $("#toggle-original").textContent = state.showOriginal ? "返回我的版本" : "查看原剧本";
  renderScriptView(
    state.showOriginal ? state.result.originalSegments : state.result.filledSegments,
  );
}

async function loadVideoPrompt() {
  const referenceUrl = $("#video-reference").value.trim();
  try {
    const data = await api("/api/video/prompt", {
      method: "POST",
      body: JSON.stringify({
        roundId: state.round.roundId,
        referenceUrl,
      }),
    });
    $("#video-prompt").value = data.prompt;
  } catch (err) {
    showToast(err.message);
  }
}

async function copyPrompt() {
  const value = $("#video-prompt").value;
  if (!value) return;
  try {
    await navigator.clipboard.writeText(value);
    showToast("提示词已复制");
  } catch {
    showToast("复制失败，请手动选择复制");
  }
}

function backToLibrary() {
  state.script = null;
  state.round = null;
  state.result = null;
  $("#network-results").classList.add("hidden");
  show(librarySection);
}

async function init() {
  bindBlankCount();
  $("#start-game").addEventListener("click", startRound);
  $("#search-btn").addEventListener("click", handleSearch);
  $("#meme-search").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      handleSearch();
    }
  });
  $("#prompt-form").addEventListener("submit", submitAnswers);
  $("#back-library").addEventListener("click", backToLibrary);
  $("#play-back").addEventListener("click", backToLibrary);
  $("#result-back").addEventListener("click", backToLibrary);
  $("#again").addEventListener("click", startRound);
  $("#toggle-original").addEventListener("click", toggleOriginal);
  $("#refresh-prompt").addEventListener("click", loadVideoPrompt);
  $("#copy-prompt").addEventListener("click", copyPrompt);
  $("#video-reference").addEventListener("change", loadVideoPrompt);
  try {
    const data = await api("/api/scripts");
    state.scripts = data.scripts;
    renderScripts();
  } catch (err) {
    showToast(err.message);
  }
}

const scriptGrid = $("#script-grid");
init();
