const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, "public");
const SCRIPTS = JSON.parse(
  fs.readFileSync(path.join(ROOT, "scripts.json"), "utf8"),
);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const rounds = new Map();

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch {
        reject(new Error("invalid json"));
      }
    });
    req.on("error", reject);
  });
}

function parseSlots(text) {
  const slots = [];
  const re = /\{\{([^|]+)\|([^}]+)\}\}/g;
  let match;
  while ((match = re.exec(text)) !== null) {
    slots.push({
      index: match.index,
      hint: match[1].trim(),
      word: match[2].trim(),
      raw: match[0],
    });
  }
  return slots;
}

function isPreferred(hint) {
  return /名词|水果|食物|数字|数词|数量|食材|饮料|蔬菜|汤|调料|配料|家禽|材料|部门|东西|物品|动物|职业|称呼|身份|人物|人名|地点|身体|颜色|节日|公司|节目|技能|结果|愿望|科目|家具|电器|工具|服装|品牌|夏季|当季|带籽|消暑|热汤|滋补|家常菜|禽类|液体|危险|物质|甜品|名字|口头禅|运动项目|口号|乐器|首歌|决定|描述|种植|场所|贵金属|金属|价格|满减|优惠|带花纹|圆的水果|常见水果|交通工具|一本书|一种票|开始时间|结束时间|游乐设施|年份|故事|宠物|面食|时间|薪酬|奖励|收入|建筑|娱乐|读物|文具|餐具|衣物|家电|运动器材|文章|课文|台词|歌词|报告|方案|计划|题目|答案|知识|问题|简历|名片|菜单|肉类|主食|饮品|酒类/.test(
    hint,
  );
}

function shuffle(list) {
  const arr = [...list];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function groupSlots(slots) {
  const byWord = new Map();
  for (const slot of slots) {
    if (!byWord.has(slot.word)) {
      byWord.set(slot.word, { word: slot.word, hint: slot.hint, slots: [] });
    }
    byWord.get(slot.word).slots.push(slot);
  }
  return [...byWord.values()];
}

function selectGroups(groups, count) {
  const preferred = groups.filter((group) => isPreferred(group.hint));
  const normal = groups.filter((group) => !isPreferred(group.hint));
  const preferredTake = Math.min(preferred.length, Math.ceil(count * 0.65));
  const pickedPreferred = shuffle(preferred).slice(0, preferredTake);
  const remaining = count - pickedPreferred.length;
  const restPool = shuffle([...preferred, ...normal]).filter(
    (group) => !pickedPreferred.includes(group),
  );
  return [...pickedPreferred, ...restPool.slice(0, remaining)];
}

function cleanup() {
  const now = Date.now();
  for (const [id, round] of rounds) {
    if (now - round.createdAt > 60 * 60 * 1000) {
      rounds.delete(id);
    }
  }
}

function scriptSummary(script) {
  return {
    id: script.id,
    title: script.title,
    source: script.source,
    description: script.description,
    slotCount: groupSlots(parseSlots(script.text)).length,
  };
}

function buildSegments(round, answers, original) {
  const text = round.script.text;
  const segments = [];
  let cursor = 0;
  const blankedSingle = new Set();
  for (const slot of round.slots) {
    if (slot.index > cursor) {
      segments.push({ type: "text", value: text.slice(cursor, slot.index) });
    }
    let shouldBlank = !original && round.selectedWords.has(slot.word);
    if (shouldBlank && round.singleBlankWords?.has(slot.word)) {
      if (blankedSingle.has(slot.word)) {
        shouldBlank = false;
      } else {
        blankedSingle.add(slot.word);
      }
    }
    if (shouldBlank) {
      const raw = answers[slot.word];
      const answer = raw === undefined || raw === null ? "" : String(raw).trim();
      if (answer) {
        segments.push({ type: "answer", value: answer.slice(0, 40) });
      } else {
        segments.push({ type: "blank", value: `＿＿（${slot.hint}）` });
      }
    } else {
      segments.push({ type: "text", value: slot.word });
    }
    cursor = slot.index + slot.raw.length;
  }
  if (cursor < text.length) {
    segments.push({ type: "text", value: text.slice(cursor) });
  }
  return segments;
}

function extractSpeakers(text) {
  const speakers = new Set();
  const re = /（([^）]+)）/g;
  let match;
  while ((match = re.exec(text)) !== null) {
    speakers.add(match[1].trim());
  }
  return [...speakers].join("、");
}

function buildVideoPrompt(round, referenceUrl) {
  const filled = buildSegments(round, round.answers || {}, false)
    .map((segment) => segment.value)
    .join("");
  const speakers = extractSpeakers(round.script.text);
  const isMeme = round.script.source.includes("网络热梗");
  const style = isMeme
    ? "这是网络热梗改编剧本，请参考原视频的人物神态、环境背景和镜头感，台词严格按新剧本演出。"
    : "这是原创场景剧本，请按新剧本演出，人物神态和动作贴合台词，环境背景符合场景设定。";
  const reference = referenceUrl ? `\n参考素材（用于保留原视频要素）：${referenceUrl}` : "";
  return `用中文生成一段短视频，场景：${round.script.title}。角色：${speakers}。${style}\n台词剧本：\n${filled}${reference}`;
}

const CUSTOM_WORDS = {
  刘华强: "一个人名",
  华强: "一个人名",
  老冯: "一个人名",
  王大队长: "一个称呼",
  炊事员: "一个身份",
  司令: "一个称呼",
  摊主: "一个称呼",
  瓜: "一种水果",
  西瓜: "一种水果",
  鸡汤: "一种汤",
  毒药: "一种东西",
  老师: "一个称呼",
  学生: "一个身份",
  老板: "一个称呼",
  警察: "一个职业",
  朋友: "一个称呼",
  同学: "一个称呼",
  同事: "一个称呼",
  医生: "一个职业",
  护士: "一个职业",
  司机: "一个职业",
  程序员: "一个职业",
  经理: "一个职业",
  服务员: "一个职业",
  学校: "一个地点",
  医院: "一个地点",
  公园: "一个地点",
  超市: "一个地点",
  食堂: "一个地点",
  宿舍: "一个地点",
  办公室: "一个地点",
  会议室: "一个地点",
  图书馆: "一个地点",
  游乐园: "一个地点",
  地铁: "一种交通工具",
  公交: "一种交通工具",
  飞机: "一种交通工具",
  火车: "一种交通工具",
  汽车: "一种交通工具",
  摩托车: "一种交通工具",
  自行车: "一种交通工具",
  手机: "一种物品",
  电脑: "一种物品",
  平板: "一种物品",
  耳机: "一种物品",
  键盘: "一种物品",
  鼠标: "一种物品",
  电视: "一种物品",
  空调: "一种家电",
  冰箱: "一种家电",
  洗衣机: "一种家电",
  沙发: "一种家具",
  床: "一种家具",
  桌子: "一种家具",
  椅子: "一种家具",
  杯子: "一种物品",
  碗: "一种餐具",
  筷子: "一种餐具",
  勺子: "一种餐具",
  雨伞: "一种物品",
  书包: "一种物品",
  钱包: "一种物品",
  钥匙: "一种物品",
  帽子: "一种衣物",
  衣服: "一种衣物",
  裤子: "一种衣物",
  鞋子: "一种衣物",
  袜子: "一种衣物",
  围巾: "一种衣物",
  眼镜: "一种物品",
  手表: "一种物品",
  口红: "一种物品",
  香水: "一种物品",
  吉他: "一种乐器",
  钢琴: "一种乐器",
  小提琴: "一种乐器",
  篮球: "一种运动器材",
  足球: "一种运动器材",
  羽毛球: "一种运动器材",
  乒乓球: "一种运动器材",
  苹果: "一种水果",
  香蕉: "一种水果",
  橘子: "一种水果",
  橙子: "一种水果",
  葡萄: "一种水果",
  草莓: "一种水果",
  梨: "一种水果",
  桃子: "一种水果",
  奶茶: "一种饮料",
  咖啡: "一种饮料",
  可乐: "一种饮料",
  啤酒: "一种饮料",
  白酒: "一种饮料",
  果汁: "一种饮料",
  茶: "一种饮料",
  水: "一种液体",
  米饭: "一种食物",
  面条: "一种食物",
  饺子: "一种食物",
  包子: "一种食物",
  馒头: "一种食物",
  面包: "一种食物",
  蛋糕: "一种甜品",
  火锅: "一种食物",
  烧烤: "一种食物",
  炒面: "一种食物",
  拉面: "一种食物",
  鸡蛋: "一种食材",
  肉: "一种食材",
  鱼: "一种食材",
  虾: "一种食材",
  菜: "一种食物",
  汤: "一种液体",
  鸡: "一种家禽",
  鸭: "一种家禽",
  猪: "一种动物",
  牛: "一种动物",
  羊: "一种动物",
  猫: "一种宠物",
  狗: "一种宠物",
  鸟: "一种宠物",
  兔子: "一种宠物",
  老虎: "一种动物",
  大象: "一种动物",
  蛇: "一种动物",
  熊: "一种动物",
  猴子: "一种动物",
  狼: "一种动物",
  狐狸: "一种动物",
  作业: "一种任务",
  考试: "一种活动",
  试卷: "一种物品",
  奖金: "一种奖励",
  工资: "一种收入",
  房子: "一种建筑",
  车子: "一种交通工具",
  红包: "一种物品",
  礼物: "一种物品",
  电影: "一种娱乐",
  音乐: "一种娱乐",
  游戏: "一种娱乐",
  小说: "一本书",
  杂志: "一本书",
  报纸: "一种读物",
  笔: "一种文具",
  铅笔: "一种文具",
  橡皮: "一种文具",
  尺子: "一种文具",
  本子: "一种文具",
  书: "一本书",
  课文: "一个名词",
  文章: "一个名词",
  台词: "一个名词",
  歌词: "一个名词",
  报告: "一个名词",
  方案: "一个名词",
  计划: "一个名词",
  题目: "一个名词",
  答案: "一个名词",
  知识: "一个名词",
  问题: "一个名词",
  故事: "一个名词",
  新闻: "一个名词",
  简历: "一份文件",
  名片: "一种卡片",
  菜单: "一种卡片",
};

const NUMERAL_STOP_WORDS = new Set([
  "一些",
  "一起",
  "一直",
  "一切",
  "一定",
  "一般",
  "一样",
  "一方面",
  "十分",
  "万一",
  "千万",
  "唯一",
  "一刹那",
  "一溜烟",
  "一清二楚",
  "一心一意",
  "一五一十",
  "十万火急",
  "百无聊赖",
  "千方百计",
  "千真万确",
  "万无一失",
]);

const NUMERAL_STOP_SUFFIX = new Set(
  "些起直切定般样方面旦准共生心味齐致同口气路下边处会儿夜点".split(""),
);

const COMPOUND_HINTS = {
  肉: "一种肉类",
  瓜: "一种水果",
  汤: "一种汤",
  茶: "一种饮品",
  饭: "一种主食",
  面: "一种面食",
  菜: "一种菜",
  果: "一种水果",
  汁: "一种饮料",
  奶: "一种饮品",
  酒: "一种酒类",
  蛋: "一种食材",
  粉: "一种食物",
  饼: "一种食物",
  粥: "一种食物",
  糖: "一种甜品",
  水: "一种液体",
  车: "一种交通工具",
  店: "一个地点",
  馆: "一个地点",
  楼: "一个地点",
  园: "一个地点",
  院: "一个地点",
  公司: "一个单位",
  学校: "一个地点",
  医院: "一个地点",
  超市: "一个地点",
  饭店: "一个地点",
  酒店: "一个地点",
};

function findCompoundCandidates(text) {
  const suffixPattern = Object.keys(COMPOUND_HINTS)
    .sort((a, b) => b.length - a.length)
    .join("|");
  const re = new RegExp(
    `([\\u4e00-\\u9fff]{1,3})(${suffixPattern})`,
    "g",
  );
  const candidates = [];
  let match;
  while ((match = re.exec(text)) !== null) {
    const word = match[0];
    candidates.push({
      word,
      hint: COMPOUND_HINTS[match[2]],
      index: match.index,
    });
  }
  return candidates;
}

function contextHint(text, index, word, baseHint) {
  const before = text.slice(Math.max(0, index - 4), index);
  const after = text.slice(index + word.length, index + word.length + 4);
  const around = before + after;
  if (/数字/.test(baseHint)) {
    if (/岁/.test(after.slice(0, 1))) return "一个年龄数字";
    if (/[块钱元]|价|贵|便宜|买|卖|花/.test(around)) return "一个价格数字";
    if (/第/.test(before)) return "一个序号";
    if (/[点时]|分|秒/.test(after.slice(0, 1))) return "一个时间数字";
    if (/[个只辆条本张件份碗杯串斤克次天年块遍]/.test(after.slice(0, 1))) {
      return "一个数量数字";
    }
  }
  if (
    /背|背诵|朗读/.test(before) &&
    (baseHint === "一个名词" || baseHint === "一个词或短语")
  ) {
    return "一篇可以背诵的内容";
  }
  if (
    /吃|尝|啃|咬/.test(before) &&
    (baseHint === "一个名词" ||
      baseHint === "一个词或短语" ||
      baseHint === "一种食物" ||
      baseHint === "一种水果")
  ) {
    return "一种可以吃的东西";
  }
  if (
    /喝/.test(before) &&
    (baseHint.includes("饮料") ||
      baseHint === "一种液体" ||
      baseHint === "一个词或短语")
  ) {
    return "一种可以喝的饮料";
  }
  if (/坐|开|骑|乘/.test(before) && baseHint.includes("交通工具")) {
    return "一种交通工具";
  }
  if (/去|到|在|位于/.test(before) && baseHint === "一个地点") {
    return "一个地点";
  }
  return baseHint;
}

function isNumericWord(word) {
  return (
    /^\d+(?:\.\d+)?$/.test(word) ||
    /^[零一二三四五六七八九十百千万两]+$/.test(word)
  );
}

function findBlankCandidates(text) {
  const candidates = [];
  candidates.push(...findCompoundCandidates(text));
  const numberRe = /\d+(?:\.\d+)?|[零一二三四五六七八九十百千万两]+/g;
  let match;
  while ((match = numberRe.exec(text)) !== null) {
    const token = match[0];
    const nextChar = text[match.index + token.length] || "";
    if (NUMERAL_STOP_WORDS.has(token)) continue;
    if (token.length === 1 && NUMERAL_STOP_SUFFIX.has(nextChar)) continue;
    candidates.push({
      word: token,
      hint: contextHint(text, match.index, token, "一个数字"),
      index: match.index,
    });
  }
  const quoteRe = /[“"「『]([^”"」』]{1,24})[”"」』]/g;
  while ((match = quoteRe.exec(text)) !== null) {
    const contentStart = match.index + match[0].length - match[1].length;
    candidates.push({
      word: match[1],
      hint: contextHint(text, contentStart, match[1], "一个词或短语"),
      index: contentStart,
    });
  }
  for (const [word, hint] of Object.entries(CUSTOM_WORDS)) {
    let from = 0;
    while ((match = text.indexOf(word, from)) !== -1) {
      candidates.push({
        word,
        hint: contextHint(text, match, word, hint),
        index: match,
      });
      from = match + word.length;
    }
  }
  candidates.sort(
    (a, b) => a.index - b.index || b.word.length - a.word.length,
  );
  const kept = [];
  let lastEnd = -1;
  for (const candidate of candidates) {
    const end = candidate.index + candidate.word.length;
    if (candidate.index > lastEnd) {
      kept.push(candidate);
      lastEnd = end;
    }
  }
  const byWord = new Map();
  for (const candidate of kept) {
    if (!byWord.has(candidate.word)) {
      byWord.set(candidate.word, {
        word: candidate.word,
        hint: candidate.hint,
        occurrences: [],
      });
    }
    byWord.get(candidate.word).occurrences.push(candidate.index);
  }
  return [...byWord.values()];
}

function blankCustomText(text, blankCount) {
  const groups = findBlankCandidates(text);
  if (groups.length < 3) {
    throw new Error("识别到的可挖空词太少，请粘贴更完整的台词语句");
  }
  const preferred = groups.filter((group) => isPreferred(group.hint));
  const normal = groups.filter((group) => !isPreferred(group.hint));
  const take = Math.min(groups.length, blankCount);
  const preferredTake = Math.min(preferred.length, Math.ceil(take * 0.65));
  const pickedPreferred = shuffle(preferred).slice(0, preferredTake);
  const remaining = take - pickedPreferred.length;
  const restPool = shuffle([...preferred, ...normal]).filter(
    (group) => !pickedPreferred.includes(group),
  );
  const picked = [...pickedPreferred, ...restPool.slice(0, remaining)];
  const replacements = [];
  for (const group of picked) {
    const occurrences = isNumericWord(group.word)
      ? group.occurrences.slice(0, 1)
      : group.occurrences;
    for (const index of occurrences) {
      replacements.push({
        index,
        length: group.word.length,
        value: `{{${group.hint}|${group.word}}}`,
      });
    }
  }
  replacements.sort((a, b) => b.index - a.index);
  let marked = text;
  for (const replacement of replacements) {
    marked =
      marked.slice(0, replacement.index) +
      replacement.value +
      marked.slice(replacement.index + replacement.length);
  }
  return { text: marked, groups: picked.length };
}

function createRound(script, requestedCount) {
  const slots = parseSlots(script.text);
  const groups = groupSlots(slots);
  if (groups.length === 0) {
    throw new Error("剧本里没有可填空的位置");
  }
  const blankCount = Math.max(
    3,
    Math.min(groups.length, Number(requestedCount) || 8),
  );
  const selectedGroups = selectGroups(groups, blankCount);
  const singleBlankWords = new Set(
    selectedGroups
      .filter((group) => isNumericWord(group.word))
      .map((group) => group.word),
  );
  const roundId = crypto.randomUUID();
  rounds.set(roundId, {
    script,
    slots,
    groups,
    selectedGroups,
    selectedWords: new Set(selectedGroups.map((group) => group.word)),
    singleBlankWords,
    createdAt: Date.now(),
  });
  return {
    roundId,
    scriptId: script.id,
    scriptTitle: script.title,
    prompts: shuffle(selectedGroups).map((group, order) => ({
      order: order + 1,
      index: group.word,
      hint: group.hint,
    })),
  };
}

function decodeEntities(text) {
  const named = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
  };
  return text.replace(
    /&#(\d+);|&#x([0-9a-fA-F]+);|&([a-z]+);/g,
    (match, dec, hex, name) => {
      if (dec) return String.fromCodePoint(Number(dec));
      if (hex) return String.fromCodePoint(parseInt(hex, 16));
      return named[name] || match;
    },
  );
}

function htmlToDialogueLines(html) {
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ");
  text = text
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  text = decodeEntities(text);
  const junk =
    /首页|登录|注册|下载|点赞|收藏|评论|分享|举报|推荐|相关|广告|下一页|返回|搜索|百度|知道|文库|更多|展开|问题|回答|提问|摘要|浏览量|更新时间|满意答案|最佳答案|采纳|提交|取消|关闭|确定|播放|暂停|视频|作者|发布于|浏览|转发|选填|联系方式|联系电话|公司地址|邮箱|价格|型号|厂商|库存|订货|购物车|客服|产品|品牌|采购|供应商|现货|封装|描述|数量|单价|成交|销量|购物|提交订单|立即购买|联系我们|关于我们|合作|行情|涨幅|市盈|成交量|涨停|换手|现价|代码|证券|股票|指数|上证|深证|财报|净利润|总市值|流通|注册资本|成立|经营范围|主营|业务|服务|平台|资源|网站|导航|帮助|意见反馈|版权|备案|公安|ICP|浏览器|扫码|打开APP|免费|试用|会员|VIP|获赞数|赞同|被浏览|推荐于|赞同数|点赞数/;
  return text
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(
      (line) =>
        line.length >= 2 &&
        line.length <= 300 &&
        (line.includes("：") || line.includes(":") || line.includes("（")) &&
        !junk.test(line),
    );
}

function extractPageScript(html) {
  const lines = htmlToDialogueLines(html);
  const text = lines.join("\n").slice(0, 6000);
  const speakerCount = (text.match(/[（(][^）)]{1,12}[）)]/g) || []).length;
  const colonCount = (text.match(/[：:]/g) || []).length;
  if (text.length < 80 || (speakerCount < 2 && colonCount < 2)) {
    return null;
  }
  return text;
}

function dialogueSpeakers(scene) {
  const speakers = new Set();
  for (const line of scene.split("\n")) {
    const paren = line.match(/^（([^）]{1,12})）/);
    const colon = line.match(/^([^：:]{1,16})[：:]/);
    const speaker = paren?.[1] || colon?.[1];
    if (
      speaker &&
      speaker.trim().length >= 2 &&
      speaker.trim().length <= 16 &&
      /[\u4e00-\u9fff]/.test(speaker) &&
      !/^\d|^https?/i.test(speaker) &&
      !/台词|剧情|简介|人物|场景|角色|剧本|正文|原文|片段|回复|回答|网友|标题/.test(speaker)
    ) {
      speakers.add(speaker.trim());
    }
  }
  return speakers;
}

function sceneScore(scene, keyword) {
  const speakerCount = dialogueSpeakers(scene).size;
  const dialogueLines = scene
    .split("\n")
    .filter((line) => {
      const paren = line.match(/^（([^）]{1,12})）/);
      const colon = line.match(/^([^：:]{1,16})[：:]/);
      const speaker = paren?.[1] || colon?.[1];
      return speaker && /[\u4e00-\u9fff]/.test(speaker);
    }).length;
  const keywordHits = keyword
    ? (scene.match(new RegExp(keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length
    : 0;
  return speakerCount * 6 + dialogueLines * 2 + keywordHits * 3;
}

function extractDialogueScenes(html, keyword, maxScenes = 4) {
  const lines = htmlToDialogueLines(html);
  if (lines.length < 4) return [];
  const chunks = [];
  let current = [];
  for (const line of lines) {
    current.push(line);
    if (current.length >= 12) {
      chunks.push(current.join("\n"));
      current = [];
    }
  }
  if (current.length >= 4) chunks.push(current.join("\n"));
  return chunks
    .map((text) => ({
      text,
      score: sceneScore(text, keyword),
      speakers: dialogueSpeakers(text).size,
    }))
    .filter(
      (scene) =>
        scene.text.length >= 80 &&
        scene.speakers >= 2,
    )
    .sort((a, b) => b.score - a.score)
    .slice(0, maxScenes)
    .map((scene) => scene.text);
}

async function fetchPageText(pageUrl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 7000);
  try {
    const res = await fetch(pageUrl, {
      headers: { "User-Agent": BROWSER_UA },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function searchItemLooksRelevant(item, keyword) {
  if (
    /电子|采购|商城|股票|行情|涨|食谱|做法|炖|炒|食材|采购平台|有限公司|集团|股份有限公司|公司简介|测速|下载|软件|招聘|咨询|贷款|信用卡|装修|房产|福利|抽奖|广告|推广/.test(
      `${item.title} ${item.snippet}`,
    )
  ) {
    return false;
  }
  if (/台词|剧本|原文|全文|对话|名场面|片段|文案|经典/.test(item.title)) {
    return true;
  }
  const hasKeyword =
    item.title.includes(keyword) ||
    item.snippet.includes(keyword);
  return (
    hasKeyword &&
    /台词|剧本|名场面|完整对话|原文|经典片段/.test(item.snippet)
  );
}

function isScriptLikeSnippet(snippet, keyword) {
  const hasScriptHint = /台词|剧本|名场面|经典片段|对话/.test(snippet);
  const speakerMentions = (snippet.match(/[^：:\s][^：:]{0,15}[：:]/g) || []).filter(
    (match) => {
      const speaker = match.slice(0, -1).trim();
      return (
        speaker.length >= 2 &&
        speaker.length <= 16 &&
        /[\u4e00-\u9fff]/.test(speaker) &&
        !/^\d|^https?/i.test(speaker)
      );
    },
  ).length;
  return (
    snippet.length >= 60 &&
    speakerMentions >= 2 &&
    (snippet.includes(keyword) || hasScriptHint)
  );
}

function parseBingRss(xml) {
  const items = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let match;
  while ((match = itemRe.exec(xml)) !== null) {
    const block = match[1];
    const title = (block.match(/<title>(.*?)<\/title>/) || [])[1] || "";
    const link = (block.match(/<link>(.*?)<\/link>/) || [])[1] || "";
    const desc = (block.match(/<description>(.*?)<\/description>/) || [])[1] || "";
    const item = {
      title: decodeEntities(title).trim(),
      link: decodeEntities(link).trim(),
      snippet: decodeEntities(desc.replace(/<[^>]+>/g, " "))
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 320),
    };
    items.push(item);
  }
  return items;
}

async function fetchBingRss(query) {
  const params = new URLSearchParams({
    q: query,
    format: "rss",
    mkt: "zh-CN",
    setlang: "zh-hans",
  });
  for (const host of ["cn.bing.com", "www.bing.com"]) {
    try {
      const res = await fetch(`https://${host}/search?${params}`, {
        headers: {
          "User-Agent": BROWSER_UA,
          "Accept-Language": "zh-CN,zh;q=0.9",
        },
        redirect: "follow",
      });
      if (!res.ok) continue;
      const xml = await res.text();
      const items = parseBingRss(xml);
      if (items.length > 0) return items;
    } catch {
      // 换下一个 Bing 域名继续尝试
    }
  }
  return [];
}

async function searchBing(keyword) {
  const aliasRules = [
    { keys: ["鸡汤来"], query: `"鸡汤来咯"` },
    { keys: ["华强"], query: `"华强买瓜" 台词` },
    { keys: ["生异形", "生意行", "萨日朗", "这瓜保熟吗"], query: `"华强买瓜" 台词` },
    { keys: ["鸡你太美"], query: `"鸡你太美"` },
  ];
  const alias = aliasRules.find((rule) =>
    rule.keys.some((key) => keyword.includes(key)),
  );
  const isBook = /书|小说|名著|文学/.test(keyword);
  const isMovie = /电影|电视剧|剧集|影片|番|动画/.test(keyword);
  const variants = [];
  if (alias) variants.push(alias.query);
  variants.push(
    `"${keyword}"`,
    `"${keyword}" 台词`,
    `"${keyword}" 完整台词`,
    `"${keyword}" 剧本`,
    `"${keyword}" 名场面`,
    `${keyword} 台词 剧本`,
    `${keyword} 片段 人物 对话`,
    `${keyword} 经典片段 对话`,
  );
  if (isBook) variants.push(`"${keyword}" 原文 片段 对话`);
  if (isMovie) variants.push(`"${keyword}" 电影 片段 台词`);

  const seen = new Set();
  const merged = [];
  for (const variant of variants) {
    let items = [];
    try {
      items = await fetchBingRss(variant);
    } catch {
      items = [];
    }
    for (const item of items) {
      const key = item.link.split("?")[0];
      if (!seen.has(key) && searchItemLooksRelevant(item, keyword)) {
        seen.add(key);
        merged.push(item);
      }
    }
    if (merged.length >= 10) break;
  }
  return merged.slice(0, 10);
}

function parseSo360(html) {
  const items = [];
  const blocks = html.match(/<li class="res-list">[\s\S]*?<\/li>/g) || [];
  for (const block of blocks) {
    const anchor = block.match(
      /<a[^>]*data-mdurl="([^"]+)"[^>]*>([\s\S]*?)<\/a>/,
    );
    if (!anchor) continue;
    const link = decodeEntities(anchor[1].trim());
    const title = decodeEntities(anchor[2].replace(/<[^>]+>/g, " ").trim());
    const text = decodeEntities(
      block
        .replace(/<script[\s\S]*?<\/script>/g, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " "),
    ).trim();
    const snippet = text
      .replace(title, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 320);
    if (title && link && /^https?:\/\//.test(link)) {
      items.push({ title, link, snippet });
    }
  }
  return items;
}

async function searchSo360(keyword) {
  const variants = [
    `${keyword} 台词`,
    `${keyword} 剧本`,
    `${keyword} 名场面`,
  ];
  const seen = new Set();
  const items = [];
  for (const variant of variants) {
    try {
      const url = `https://www.so.com/s?q=${encodeURIComponent(variant)}`;
      const res = await fetch(url, {
        headers: {
          "User-Agent": BROWSER_UA,
          "Accept-Language": "zh-CN,zh;q=0.9",
        },
        redirect: "follow",
      });
      if (!res.ok) continue;
      const html = await res.text();
      for (const item of parseSo360(html)) {
        const key = item.link.split("?")[0];
        if (!seen.has(key) && searchItemLooksRelevant(item, keyword)) {
          seen.add(key);
          items.push(item);
        }
      }
    } catch {
      // 继续尝试下一个查询
    }
    if (items.length >= 2) break;
  }
  return items.slice(0, 6);
}

async function searchScripts(keyword) {
  const bingItems = await searchBing(keyword);
  if (bingItems.length >= 2) return bingItems;
  const soItems = await searchSo360(keyword);
  const seen = new Set();
  return [...bingItems, ...soItems].filter((item) => {
    const key = item.link.split("?")[0];
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 10);
}

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/scripts") {
    sendJson(res, 200, { scripts: SCRIPTS.map(scriptSummary) });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/round") {
    let body;
    try {
      body = await readBody(req);
    } catch {
      sendJson(res, 400, { error: "请求格式不正确" });
      return;
    }
    const script = SCRIPTS.find((item) => item.id === body.scriptId);
    if (!script) {
      sendJson(res, 404, { error: "没有找到这个剧本" });
      return;
    }
    let result;
    try {
      result = createRound(script, Number(body.blankCount) || 8);
    } catch (err) {
      sendJson(res, 500, { error: err.message });
      return;
    }
    if (rounds.size > 800) cleanup();
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/fill") {
    let body;
    try {
      body = await readBody(req);
    } catch {
      sendJson(res, 400, { error: "请求格式不正确" });
      return;
    }
    const round = rounds.get(body.roundId);
    if (!round) {
      sendJson(res, 410, { error: "这一局已过期，请重新开始" });
      return;
    }
    const answers = body.answers || {};
    const missing = round.selectedGroups.filter((group) => {
      const value = answers[group.word];
      return value === undefined || !String(value).trim();
    });
    if (missing.length > 0) {
      sendJson(res, 400, {
        error: `还有 ${missing.length} 个空没有填`,
        missing: missing.map((group) => group.word),
      });
      return;
    }
    round.answers = answers;
    const filledSegments = buildSegments(round, answers, false);
    const originalSegments = buildSegments(round, answers, true);
    sendJson(res, 200, {
      scriptTitle: round.script.title,
      filledSegments,
      originalSegments,
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/video/prompt") {
    let body;
    try {
      body = await readBody(req);
    } catch {
      sendJson(res, 400, { error: "请求格式不正确" });
      return;
    }
    const round = rounds.get(body.roundId);
    if (!round) {
      sendJson(res, 410, { error: "这一局已过期，请重新开始" });
      return;
    }
    const prompt = buildVideoPrompt(round, body.referenceUrl);
    sendJson(res, 200, { scriptTitle: round.script.title, prompt });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/custom/round") {
    let body;
    try {
      body = await readBody(req);
    } catch {
      sendJson(res, 400, { error: "请求格式不正确" });
      return;
    }
    const raw = typeof body.text === "string" ? body.text.trim() : "";
    if (raw.length < 20) {
      sendJson(res, 400, { error: "台词太短，请粘贴完整的剧本或台词语句" });
      return;
    }
    let marked;
    try {
      marked = blankCustomText(raw, Math.max(3, Number(body.blankCount) || 8));
    } catch (err) {
      sendJson(res, 400, { error: err.message });
      return;
    }
    const script = {
      id: `custom-${crypto.randomUUID()}`,
      title: "自定义热梗剧本",
      source: "用户粘贴",
      description: "根据你粘贴的台词自动挖空生成",
      text: marked.text,
    };
    let result;
    try {
      result = createRound(script, Number(body.blankCount) || 8);
    } catch (err) {
      sendJson(res, 500, { error: err.message });
      return;
    }
    if (rounds.size > 800) cleanup();
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/fetch/script") {
    let body;
    try {
      body = await readBody(req);
    } catch {
      sendJson(res, 400, { error: "请求格式不正确" });
      return;
    }
    const pageUrl = typeof body.url === "string" ? body.url.trim() : "";
    let parsedUrl;
    try {
      parsedUrl = new URL(pageUrl);
      if (!/^https?:$/.test(parsedUrl.protocol)) throw new Error("bad protocol");
    } catch {
      sendJson(res, 400, { error: "请输入正确的网页链接" });
      return;
    }
    let html;
    try {
      html = await fetchPageText(parsedUrl.href);
    } catch {
      sendJson(res, 502, { error: "这个网页暂时打不开，换个链接试试" });
      return;
    }
    let scenes = extractDialogueScenes(html, "", 6);
    if (scenes.length === 0) {
      const text = extractPageScript(html);
      if (text) scenes = [text];
    }
    if (scenes.length === 0) {
      sendJson(res, 404, { error: "这个网页里没找到可用的对话片段" });
      return;
    }
    sendJson(res, 200, {
      url: parsedUrl.href,
      results: scenes.map((text, index) => ({
        title: `对话片段 ${index + 1}`,
        url: parsedUrl.href,
        snippet: text.slice(0, 120),
        text,
        fallback: false,
      })),
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/search") {
    const keyword = (url.searchParams.get("q") || "").trim();
    if (keyword.length < 2) {
      sendJson(res, 400, { error: "请输入至少两个字符" });
      return;
    }
    let items;
    try {
      items = await searchScripts(keyword);
    } catch {
      sendJson(res, 502, { error: "网络搜索暂时不可用，请稍后再试" });
      return;
    }
    const settled = await Promise.allSettled(
      items.slice(0, 6).map(async (item) => {
        let scenes = [];
        try {
          const html = await fetchPageText(item.link);
          scenes = extractDialogueScenes(html, keyword, 3);
        } catch {
          scenes = [];
        }
        if (scenes.length > 0) {
          return scenes.map((text, index) => ({
            title: `${item.title} · 片段${index + 1}`,
            url: item.link,
            snippet: text.slice(0, 120),
            text,
            fallback: false,
          }));
        }
        if (isScriptLikeSnippet(item.snippet, keyword)) {
          return [
            {
              title: item.title,
              url: item.link,
              snippet: item.snippet,
              text: item.snippet,
              fallback: true,
            },
          ];
        }
        return [];
      }),
    );
    const seen = new Set();
    const results = settled
      .filter((entry) => entry.status === "fulfilled")
      .flatMap((entry) => entry.value)
      .filter((item) => {
        const key = `${item.url}|${item.text.slice(0, 80)}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 8);
    if (results.length === 0) {
      sendJson(res, 404, { error: "没搜到可用的热梗台词，换个关键词试试" });
      return;
    }
    sendJson(res, 200, { keyword, results });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/network/round") {
    let body;
    try {
      body = await readBody(req);
    } catch {
      sendJson(res, 400, { error: "请求格式不正确" });
      return;
    }
    const raw = typeof body.text === "string" ? body.text.trim() : "";
    if (raw.length < 20) {
      sendJson(res, 400, { error: "这段台词太短，无法生成剧本" });
      return;
    }
    let marked;
    try {
      marked = blankCustomText(raw, Math.max(3, Number(body.blankCount) || 8));
    } catch (err) {
      sendJson(res, 400, { error: err.message });
      return;
    }
    const script = {
      id: `network-${crypto.randomUUID()}`,
      title: typeof body.title === "string" && body.title ? body.title : "网络热梗剧本",
      source: "网络热梗",
      description: typeof body.url === "string" ? body.url : "",
      text: marked.text,
    };
    let result;
    try {
      result = createRound(script, Number(body.blankCount) || 8);
    } catch (err) {
      sendJson(res, 500, { error: err.message });
      return;
    }
    if (rounds.size > 800) cleanup();
    sendJson(res, 200, result);
    return;
  }

  sendJson(res, 404, { error: "接口不存在" });
}

function serveStatic(req, res, url) {
  const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = path.normalize(path.join(PUBLIC, pathname));
  if (!filePath.startsWith(PUBLIC + path.sep) && filePath !== PUBLIC) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("Not Found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (url.pathname.startsWith("/api/")) {
    handleApi(req, res, url).catch((err) => {
      console.error(err);
      sendJson(res, 500, { error: "服务器开小差了" });
    });
    return;
  }
  if (req.method === "GET") {
    serveStatic(req, res, url);
    return;
  }
  res.writeHead(405);
  res.end("Method Not Allowed");
});

const port = Number(process.env.PORT || 3000);
server.listen(port, () => {
  console.log(`fillword game server running at http://localhost:${port}`);
});
