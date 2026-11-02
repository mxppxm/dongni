/**
 * 回复落库前的整理：她偶尔会把工具调用标记、磁盘路径、解析残片直接吐到正文里。
 * 这些不该出现在她的话里——文件有卡片，路径和乱码谁也不想读到、更不想听见。
 */

/** 代码块原样留着（他让她写代码、命令时不能动），只整理普通文字 */
const FENCE = /(```[\s\S]*?```|~~~[\s\S]*?~~~)/g;
function outsideFences(text: string, fn: (s: string) => string) {
  return text.split(FENCE).map((part, i) => (i % 2 ? part : fn(part))).join("");
}

/** 模型漏出来的工具调用块（整段丢掉，比按行删干净；非贪婪，两个块中间她说的话不能一起吞掉） */
const TOOL_BLOCK = /<(?:tool_calls?|tool_call|function_calls?|function_call)>[\s\S]*?<\/(?:tool_calls?|tool_call|function_calls?|function_call)>/gi;
/** DeepSeek 那套全角竖线的调用标记：<｜｜DSML｜｜ invoke …>…</｜｜DSML｜｜ invoke> */
const PIPE_BLOCK = /<[\uFF5C|]{2,}[^>]*>[\s\S]*?<\/[\uFF5C|]{2,}[^>]*>/g;
/** 单行没配对的标记、残片。全角竖线只认 <｜…｜> 这种尖括号包着的标记，她自己写的「A｜B」不能删 */
const LEAK_LINE =
  /<\/?\uFF5C[^<>\n]*\uFF5C[^<>\n]*>|<\|[^>]*\|>|<\/?(?:tool_calls?|tool_call|function_calls?|function_call|invoke|parameter)\b[^>]*>|\[TOOL_CALLS?\]/i;
const LEAK_INLINE = /<\/?(?:tool_calls?|tool_call|function_calls?|function_call|invoke|parameter)\b[^>]*>/gi;

/** 去掉调用残片、乱码符号（含 U+FFFD 替换字符） */
export function stripLeaks(text: string) {
  return text
    .replace(TOOL_BLOCK, " ")
    .replace(PIPE_BLOCK, " ")
    .split("\n")
    .filter((line) => !LEAK_LINE.test(line))
    .join("\n")
    .replace(LEAK_INLINE, "")
    .replace(/\uFFFD+/g, "");
}

/**
 * 电脑上的真实路径不该念出来：文件有卡片（点一下就在 Finder 里看到），
 * 正文里出现 /Users/…、~/… 这类地址只会在语音里变成一串听不懂的东西。
 */
const PATH =
  /(?:~\/|\/(?:Users|home|private|tmp|var|opt|usr|etc|Volumes|Applications|System|Library|bin|sbin|dev|cores)\/)(?:[^\s，。；：、！？（）()「」“”"'<>`]|\s+(?:\([^)]*\)[^\s，。；：、！？（）()「」“”"'<>`]*|[^\s，。；：、！？（）()「」“”"'<>`]*\.\w{1,8}))*/g;

export function stripPaths(text: string) {
  return text.replace(PATH, "");
}

/** 去掉路径以后把留下的空括号、空代码、连着的标点收干净 */
function tidy(text: string) {
  return text
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+([，。；：、！？])/g, "$1")
    .replace(/([，。；：、])\s*[，。；：、]+/g, "$1")
    .replace(/`\s*`/g, "")
    .replace(/（\s*）/g, "")
    .replace(/\(\s*\)/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n");
}

/** 卡片块：按内容去重，同一路径/链接/编号在一次回复里只留一张 */
export function dedupeCards(text: string) {
  const seen = new Set<string>();
  return text
    .replace(/\n*```card\n([\s\S]*?)\n```\n*/g, (block, body: string) => {
      let key = block;
      try {
        const spec = JSON.parse(body) as Record<string, unknown>;
        const id = spec.path ?? spec.url ?? spec.id ?? spec.text ?? spec.title ?? "";
        key = `${String(spec.type ?? "")}|${String(id)}`;
      } catch {
        // JSON 坏了就按整块比
      }
      if (seen.has(key)) return "\n";
      seen.add(key);
      return `\n\n${block}\n\n`;
    })
    .trim();
}

/** 交给她自己看的历史里不保留卡片（卡片是界面上的东西，留在上下文里她就会照着写一遍） */
export function stripCards(text: string) {
  return text.replace(/```card\n[\s\S]*?\n```/g, "\n").trim();
}

/** 一条回复落库前的总整理：卡片去重、路径和乱码清掉 */
export function cleanReply(text: string) {
  const deduped = dedupeCards(text);
  let stripped = false;
  outsideFences(deduped, (s) => {
    const a = stripLeaks(s);
    const b = stripPaths(a);
    if (a !== s || b !== a) stripped = true;
    return b;
  });
  const squash = (t: string) => outsideFences(t, (s) => s.replace(/\n{3,}/g, "\n\n"));
  // 只是空白差异就不动：别为了几个空格把整条回复重刷一遍
  if (!stripped) return squash(deduped);
  return squash(outsideFences(deduped, (s) => tidy(stripPaths(stripLeaks(s))))).trim();
}
