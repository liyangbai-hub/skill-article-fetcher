#!/usr/bin/env node
/**
 * article-fetcher — 独立文章抓取脚本（不依赖任何宿主程序）
 *
 * 两种机械产物（"提炼摘要+语义标签"由调用本技能的智能体完成，不在脚本里）：
 *   content : 文章 → Markdown（默认回发对话框；加 --out 时落地 md + 本地图片 + 图片清单）
 *   pdf     : 文章 → PDF（必须落盘，返回路径）
 *
 * 智能路由："该快则快、该兜底则兜底"
 *   fast    = 纯 HTTP 抓静态 HTML（微信、多数静态站秒级，且无需 chromium）
 *   stealth = 无头浏览器渲染（JS 渲染站/反爬/生成 PDF 必需；playwright 按需懒加载）
 *   默认 fast；正文不足或失败自动回退 stealth；已知 JS-only 站直接 stealth。
 *
 * 用法：
 *   node fetch-article.mjs --mode content <url> [url2 ...]      # 正文回发 stdout
 *   node fetch-article.mjs --mode content --out ./out <url>     # 落地 md + 本地图片
 *   node fetch-article.mjs --mode pdf --out ./out <url>         # 生成 PDF
 *   node fetch-article.mjs --mode content --file urls.txt       # 批量
 *   cat urls.txt | node fetch-article.mjs --mode content        # stdin 批量
 *   加 --json 输出机器可读结果（每条链接的产物路径/正文/成败）。
 *
 * 依赖：turndown、cheerio（fast 路径只需这两个）；playwright（仅 stealth/pdf 时懒加载）。
 *
 * 同源约定：标有 [SYNC:*] 的常量块与桌面端 baidu-downloader/src/main/article-fetcher/engine.ts
 * 必须逐字一致（由桌面端 sync-with-skill.test.ts 自动校验）。改一边必须同步另一边。
 */

import TurndownService from 'turndown';
import * as cheerio from 'cheerio';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';

// Node 的 Happy Eyeballs 默认每个候选地址只给 250ms 连接窗口。当 DNS 返回多个地址
// （如 mp.weixin.qq.com 同时给 IPv6+IPv4）且网络握手 >250ms 时，所有地址会被轮流掐死，
// fetch 报 ETIMEDOUT，fast 路径被迫回退无头浏览器。放宽到 1.5s（与桌面端 main.ts 一致）。
try {
  net.setDefaultAutoSelectFamilyAttemptTimeout?.(1500);
} catch { /* 旧版 Node 无此 API，忽略 */ }

const MODE_ALIASES = {
  content: 'content', markdown: 'content', md: 'content', 提取内容: 'content', 读取: 'content',
  pdf: 'pdf', 生成pdf: 'pdf'
};

// [SYNC:routing]
const STEALTH_HOSTS = ['zhuanlan.zhihu.com', 'www.zhihu.com', 'juejin.cn'];
const MIN_CONTENT_LENGTH = 200; // body 兜底时判定"是否疑似 JS 空壳"的阈值
const CONTAINER_FLOOR = 30;     // 命中正文容器的最低字数门槛（命中即信任，含真·短文）
const FETCH_TIMEOUT_MS = 30000;  // 页面 HTTP 抓取超时
const IMAGE_TIMEOUT_MS = 20000;  // 单张图片下载超时
const IMAGE_CONCURRENCY = 4;     // 图片并发下载数
// [/SYNC:routing]

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

// [SYNC:selectors]
const WECHAT_SELECTORS = ['#js_content', '.rich_media_content'];
const GENERIC_SELECTORS = [
  'article', 'main', '.post-content', '.entry-content', '.article-content', '.article-body',
  '.article-detail', '.post_body', '.Post-RichText', '#article_content', '.article-area',
  '.ssa-article', '.markdown-body', '[role="article"]', '[itemprop="articleBody"]'
];
// [/SYNC:selectors]

// ── 参数解析 ─────────────────────────────────────────────

function parseArgs(argv) {
  const opts = { mode: 'content', out: null, file: null, concurrency: 2, json: false, urls: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--mode' || a === '-m') opts.mode = MODE_ALIASES[(argv[++i] || '').toLowerCase()] || 'content';
    else if (a === '--out' || a === '-o') opts.out = path.resolve(argv[++i]);
    else if (a === '--file' || a === '-f') opts.file = argv[++i];
    else if (a === '--concurrency' || a === '-c') opts.concurrency = Math.max(1, Number(argv[++i]) || 1);
    else if (a === '--json') opts.json = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (/^https?:\/\//i.test(a)) opts.urls.push(a);
  }
  return opts;
}

const HELP = `article-fetcher — 文章链接抓取（content / pdf；摘要由调用 agent 做）

  node fetch-article.mjs --mode <content|pdf> [--out <dir>] <url...>

  -m,--mode  content（默认，正文回发 stdout）| pdf（必须 --out 或用默认目录）
  -o,--out   输出目录（content 模式下指定才会落地 md+本地图片）
  -f,--file  从文件读链接（每行一个）
  -c,--concurrency  并发（默认 2）
  --json     输出机器可读 JSON
  -h,--help  帮助
  也可从 stdin 读链接（每行一个）。`;

function extractUrls(text) {
  const matches = text.match(/https?:\/\/[^\s,，、"'<>）)】\]]+/gi) || [];
  const seen = new Set(), urls = [];
  for (const m of matches) {
    const u = m.trim().replace(/[.,;。；]+$/, '');
    if (!seen.has(u)) { seen.add(u); urls.push(u); }
  }
  return urls;
}

async function readStdin() {
  if (process.stdin.isTTY) return '';
  const rl = readline.createInterface({ input: process.stdin });
  const lines = [];
  for await (const line of rl) lines.push(line);
  return lines.join('\n');
}

// ── 工具 ─────────────────────────────────────────────────

function sanitizeDirName(title) {
  const c = (title || '').replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '_').slice(0, 50).replace(/_+$/, '');
  return c || 'untitled';
}
// 规范化为 YYYY-MM-DD：优先文章发布时间，取不到用抓取当天。
function toDateStr(publishTime) {
  if (publishTime) {
    const m = publishTime.match(/(\d{4})[-/年.](\d{1,2})[-/月.](\d{1,2})/);
    if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
    const iso = publishTime.match(/(\d{4}-\d{2}-\d{2})/);
    if (iso) return iso[1];
  }
  return new Date().toISOString().slice(0, 10);
}
// 每篇统一命名前缀 <日期>_<标题>，用于文件夹名与文件名。
function articleBaseName(meta) {
  return `${toDateStr(meta.publishTime)}_${sanitizeDirName(meta.title)}`;
}
const safe = (v) => (v ? String(v).replace(/\n/g, ' ') : '');
function prefersStealth(url) {
  // 解析不出的 URL 走 fast 路径快速失败即可，不值得开浏览器
  try { return STEALTH_HOSTS.some((h) => new URL(url).hostname.includes(h)); } catch { return false; }
}

async function pathExists(p) {
  try { await fs.stat(p); return true; } catch { return false; }
}

// 同日期同标题不再静默覆盖：若目标产物已存在，目录与文件名追加 _2、_3…
async function resolveArticleDir(parent, base, ext) {
  for (let i = 1; ; i++) {
    const name = i === 1 ? base : `${base}_${i}`;
    const dir = path.join(parent, name);
    if (!(await pathExists(path.join(dir, `${name}${ext}`)))) return { dir, name };
  }
}

// 带超时的 fetch（无上游信号场景，超时即中止）。
async function fetchWithTimeout(url, headers, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`请求超时 (${Math.round(timeoutMs / 1000)}s): ${url}`)),
    timeoutMs
  );
  try {
    return await fetch(url, { headers, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ── 统一正文提取（cheerio；fast 与 stealth 共用，和桌面端 engine.ts 同源）──

function extractFromHtml(html, url) {
  const $ = cheerio.load(html);
  const isWechat = url.includes('mp.weixin.qq.com');
  const selectors = isWechat ? [...WECHAT_SELECTORS, ...GENERIC_SELECTORS] : GENERIC_SELECTORS;

  // 按优先级取第一个有实质内容(>CONTAINER_FLOOR 字)的容器；命中即信任(真·短文也保留 fast)。
  let contentHtml = '', textLength = 0, matchedSelector = false;
  for (const sel of selectors) {
    const el = $(sel).first();
    if (el.length) {
      const len = el.text().trim().length;
      if (len > CONTAINER_FLOOR) { contentHtml = el.html() || ''; textLength = len; matchedSelector = true; break; }
    }
  }
  if (!matchedSelector) { contentHtml = $('body').html() || html; textLength = $('body').text().trim().length; }

  let title = '';
  if (isWechat) {
    title = $('#activity_name').text().trim() || $('h1.rich_media_title').text().trim() || $('h2.rich_media_title').text().trim();
  }
  title = title || $('meta[property="og:title"]').attr('content')?.trim() || $('h1').first().text().trim() || $('title').text().trim() || 'Untitled';

  let author = '';
  if (isWechat) author = $('#js_name').text().trim() || $('.rich_media_meta_nickname').text().trim();
  author = author || $('meta[name="author"]').attr('content')?.trim() || $('.author, [rel="author"], .byline').first().text().trim() || '';

  let publishTime = '';
  if (isWechat) {
    publishTime = $('#publish_time').text().trim() || $('#js_publish_time').text().trim() || $('em#publish_time').text().trim();
    if (!publishTime) {
      const ct = html.match(/var ct = "(\d{10})"/);
      if (ct) publishTime = new Date(Number(ct[1]) * 1000).toISOString().slice(0, 10);
    }
  }
  publishTime = publishTime || $('meta[property="article:published_time"]').attr('content')?.trim() || $('time').attr('datetime')?.trim() || $('time').first().text().trim() || '';

  let sourceDomain = '';
  try { sourceDomain = new URL(url).hostname; } catch {}
  return { title, author: author || undefined, publishTime: publishTime || undefined, sourceDomain, contentHtml, textLength, matchedSelector };
}

// ── 反爬验证页 / 失效文章检测 ────────────────────────────
//
// fast 拿到拦截页时会回退 stealth，但 stealth 渲染的还是同一个拦截页——
// 若不检测，会把验证页当正文输出"假文章"。

// [SYNC:blocked-pages]
const BLOCKED_PAGE_PATTERNS = [
  /环境异常/, /完成验证后.{0,6}访问/, /访问过于频繁/, /请输入验证码/, /安全验证/,
  /该内容已被发布者删除/, /此内容因违规无法查看/, /此内容被投诉且经审核/, /该公众号已迁移/, /链接已过期/
];
// [/SYNC:blocked-pages]

function detectBlockedReason(extracted) {
  // 命中真正文容器且内容充足时不可能是拦截页，跳过检测避免误伤讨论反爬的正常文章。
  if (extracted.matchedSelector && extracted.textLength >= 300) return null;
  const text = `${extracted.title} ${cheerio.load(extracted.contentHtml).text()}`.slice(0, 3000);
  for (const re of BLOCKED_PAGE_PATTERNS) {
    const m = text.match(re);
    if (m) return m[0];
  }
  return null;
}

// ── fast / stealth 抓取 ──────────────────────────────────

async function httpFetchHtml(url) {
  const resp = await fetchWithTimeout(url, {
    'User-Agent': USER_AGENT,
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
  }, FETCH_TIMEOUT_MS);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return await resp.text();
}

let sharedBrowser = null;
async function getBrowser() {
  if (!sharedBrowser) {
    let chromium;
    try {
      ({ chromium } = await import('playwright')); // 懒加载：fast-only 用法无需 chromium
    } catch {
      throw new Error('未安装 playwright（生成 PDF / JS 渲染站兜底需要）。请在 scripts/ 目录执行: npm install && npx playwright install chromium');
    }
    try {
      sharedBrowser = await chromium.launch({ headless: true });
    } catch (err) {
      throw new Error(`无法启动无头浏览器（Playwright Chromium）。请先执行: npx playwright install chromium\n原因: ${err.message}`);
    }
  }
  return sharedBrowser;
}
async function closeBrowser() {
  if (sharedBrowser) { await sharedBrowser.close(); sharedBrowser = null; }
}
async function renderWithBrowser(url) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' });
  await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
  return { html: await page.content(), page };
}

// 按 Content-Type 优先决定图片扩展名，回退到 URL 的 wx_fmt / 路径扩展名，再回退 .jpg
function pickImageExt(src, contentType) {
  const ct = (contentType || '').toLowerCase();
  if (ct.includes('png')) return '.png';
  if (ct.includes('jpeg') || ct.includes('jpg')) return '.jpg';
  if (ct.includes('gif')) return '.gif';
  if (ct.includes('webp')) return '.webp';
  if (ct.includes('svg')) return '.svg';
  try {
    const u = new URL(src);
    const fmt = (u.searchParams.get('wx_fmt') || '').toLowerCase();
    if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(fmt)) return '.' + (fmt === 'jpeg' ? 'jpg' : fmt);
    const ext = path.extname(u.pathname);
    if (ext && ext.length <= 5) return ext;
  } catch {}
  return '.jpg';
}

// 轻量解析图片像素尺寸（PNG/GIF/JPEG/WEBP），解析不出返回 null（按"保留"处理）
function imageSize(buf) {
  try {
    if (buf.length < 24) return null;
    if (buf[0] === 0x89 && buf[1] === 0x50) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      let off = 2;
      while (off + 9 < buf.length) {
        if (buf[off] !== 0xff) { off++; continue; }
        const marker = buf[off + 1];
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))
          return { height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7) };
        off += 2 + buf.readUInt16BE(off + 2);
      }
    }
    if (buf.length >= 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
      const fmt = buf.toString('ascii', 12, 16);
      if (fmt === 'VP8X') return { width: 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16)), height: 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16)) };
      if (fmt === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    }
  } catch {}
  return null;
}
// 分隔线/占位图：任一边 ≤8px（真实内容图不会这么细），剔除。
function isDividerImage(buf) {
  const d = imageSize(buf);
  return !!d && (d.width <= 8 || d.height <= 8);
}

// ── 图片处理（imageDir 为空时仅把 data-src 提升为远程 src）──

async function processImages(contentHtml, baseUrl, imageDir) {
  const $ = cheerio.load(contentHtml);
  const images = [];
  if (imageDir) await fs.mkdir(imageDir, { recursive: true });

  // 先收集候选图片并解析真实地址（data-src / data-croporisrc 是微信等站懒加载的真实地址）。
  const candidates = [];
  for (const el of $('img').toArray()) {
    let src = $(el).attr('data-src') || $(el).attr('data-croporisrc') || $(el).attr('src');
    if (!src) continue;
    try { if (src.startsWith('//')) src = 'https:' + src; else if (!src.startsWith('http')) src = new URL(src, baseUrl).href; } catch { continue; }
    if (src.startsWith('data:')) continue;
    candidates.push({ el, src });
  }

  if (!imageDir) {
    // 不落地：保留远程 URL（用"已保留数"连续编号）
    for (const { el, src } of candidates) {
      const label = `图${String(images.length + 1).padStart(3, '0')}`;
      const existingAlt = ($(el).attr('alt') || '').trim();
      $(el).attr('alt', existingAlt ? `${label} ${existingAlt}` : label);
      $(el).attr('src', src);
      $(el).removeAttr('data-src');
      $(el).removeAttr('data-croporisrc');
      images.push({ originalUrl: src, localPath: null });
    }
    return { updatedHtml: $.html(), images };
  }

  // 小并发下载（带超时），下载与编号分离：编号按文档顺序进行，保证确定性。
  const downloaded = new Array(candidates.length).fill(null);
  await runPool(candidates, IMAGE_CONCURRENCY, async (cand, i) => {
    try {
      const resp = await fetchWithTimeout(cand.src, { Referer: baseUrl, 'User-Agent': USER_AGENT }, IMAGE_TIMEOUT_MS);
      if (resp.ok) downloaded[i] = { buf: Buffer.from(await resp.arrayBuffer()), contentType: resp.headers.get('content-type') };
    } catch { /* 下载失败：下面统一保留远程引用，不阻断 */ }
  });

  for (let i = 0; i < candidates.length; i++) {
    const { el, src } = candidates[i];
    const result = downloaded[i];
    if (!result) {
      // 下载失败：提升为远程地址保留引用（不编号、不进清单），Markdown 里仍可见原图链接。
      $(el).attr('src', src);
      $(el).removeAttr('data-src');
      $(el).removeAttr('data-croporisrc');
      continue;
    }
    // 剔除分隔线/占位图（任一边 ≤8px），并从正文移除该 <img>
    if (isDividerImage(result.buf)) { $(el).remove(); continue; }
    const n = images.length + 1; // 已保留图片连续编号，跳过的分隔图不占号
    const ext = pickImageExt(src, result.contentType);
    const filename = `img_${String(n).padStart(3, '0')}_${crypto.createHash('md5').update(src).digest('hex').slice(0, 8)}${ext}`;
    const relativePath = path.posix.join('images', filename);
    await fs.writeFile(path.join(imageDir, filename), result.buf);
    const label = `图${String(n).padStart(3, '0')}`;
    const existingAlt = ($(el).attr('alt') || '').trim();
    $(el).attr('alt', existingAlt ? `${label} ${existingAlt}` : label);
    $(el).attr('src', relativePath);
    $(el).removeAttr('data-src');
    $(el).removeAttr('data-croporisrc');
    images.push({ originalUrl: src, localPath: relativePath });
  }
  return { updatedHtml: $.html(), images };
}

// ── HTML → Markdown ──────────────────────────────────────

function htmlToMarkdown(html) {
  const td = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-', codeBlockStyle: 'fenced', emDelimiter: '*' });
  td.addRule('img', { filter: 'img', replacement: (_c, node) => `![${node.getAttribute('alt') || ''}](${node.getAttribute('src') || ''})` });
  td.addRule('a', {
    filter: 'a',
    replacement: (content, node) => {
      const href = node.getAttribute('href') || '';
      if (!href || href.startsWith('javascript:')) return content;
      return `[${content}](${href})`;
    }
  });
  return td.turndown(html).replace(/\n{3,}/g, '\n\n').trim();
}

// 保守的广告/推广行过滤：只删明显是号召性推广(CTA)的短行；图片/表格/标题行保留。
// 价格/促销词（优惠/折扣/原价…）必须与行动词共现才删——单独出现往往是正文。

// [SYNC:ad-patterns]
const AD_LINE_PATTERNS = [
  /扫码|扫一?扫|扫描.{0,4}二维码|长按.{0,6}(识别|二维码|关注)|识别.{0,4}二维码/,
  /添加(我的)?(微信|客服|助理|小助手)|加(我)?(微信|客服)|(微信|VX|vx|wx)[:：]\s*\S{3,}/,
  /(点击|戳|长按).{0,8}(上方|下方|蓝字|名片)?.{0,4}(关注|阅读原文|在看|订阅)/,
  /商务合作|广告合作|投稿(邮箱|请联系)|转载(请|授权|联系)|版权合作/,
  /(报名|咨询|抢购|抢座|购票|订购|预约).{0,4}(方式|入口|通道|链接|热线|电话|请加|扫码)/,
  /(限时|早鸟|特价|原价|折扣|优惠|秒杀|立减|福利价|内部价|名额有限|仅需).{0,12}(报名|抢购|下单|扫码|咨询|领取|订阅|购买|开课|加入|戳|点击)/,
  /(报名|抢购|下单|扫码|咨询|领取|订阅|购买|开课)[^。，,]{0,12}(限时|早鸟|特价|原价|折扣|优惠|秒杀|立减|福利价|内部价)/,
  /(仅需|秒杀价|福利价|内部价|早鸟价|限时价)\s*[¥￥]?\s*\d/,
  /(培训|课程|训练营|社群|知识星球|星球|会员群).{0,8}(报名|费用|价格|优惠|名额|加入|扫码|咨询|开课)/,
  /(报名|加入|扫码|咨询|开课).{0,8}(培训|课程|训练营|社群|知识星球|星球)/,
  /(进群|入群|加入.{0,3}群聊|交流群|读者群|powered by)/i
];
// [/SYNC:ad-patterns]

function stripAds(markdown) {
  return markdown.split('\n').filter((line) => {
    const t = line.trim();
    if (!t) return true;
    if (t.startsWith('![') || t.startsWith('|') || t.startsWith('#')) return true;
    if (t.length < 100 && AD_LINE_PATTERNS.some((re) => re.test(t))) return false;
    return true;
  }).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function buildMarkdown(meta, body, images, url) {
  const metaLines = [
    meta.author ? `**作者**: ${safe(meta.author)}` : null,
    meta.publishTime ? `**发布时间**: ${safe(meta.publishTime)}` : null,
    `**原文链接**: ${url}`,
    `**来源域名**: ${meta.sourceDomain}`,
    `**抓取时间**: ${new Date().toISOString()}`,
    images.length ? `**图片数量**: ${images.length} 张` : null
  ].filter(Boolean);
  const frontmatter = `# ${safe(meta.title)}\n\n${metaLines.join('\n')}\n\n---\n\n`;
  const manifest = images.length
    ? ['', '', '---', '', '## 图片清单', '', '| 编号 | 本地文件 | 原始链接 |', '| --- | --- | --- |',
       ...images.map((img, idx) => `| 图${String(idx + 1).padStart(3, '0')} | ${img.localPath || '（未下载，见原始链接）'} | ${img.originalUrl} |`), ''].join('\n')
    : '';
  return frontmatter + body + manifest + '\n';
}

// ── 单篇流水线 ───────────────────────────────────────────

async function fetchOne(url, mode, outRoot, log) {
  let page = null;
  try {
    // 无效链接快速失败，不浪费一次浏览器启动。
    try { new URL(url); } catch { throw new Error(`无效链接: ${url}`); }

    log(`抓取（${mode}）：${url}`);
    let html, strategy;
    const mustBrowser = mode === 'pdf' || prefersStealth(url);

    if (mustBrowser) {
      const r = await renderWithBrowser(url); html = r.html; page = r.page; strategy = 'stealth';
    } else {
      try {
        html = await httpFetchHtml(url);
        const probe = extractFromHtml(html, url);
        // 命中正文容器就信任(含短文)；只有没命中任何容器且 body 也很少时才回退浏览器。
        const insufficient = probe.matchedSelector ? false : probe.textLength < MIN_CONTENT_LENGTH;
        if (insufficient) {
          const r = await renderWithBrowser(url); html = r.html; page = r.page; strategy = 'stealth(fallback)';
        } else strategy = 'fast';
      } catch {
        const r = await renderWithBrowser(url); html = r.html; page = r.page; strategy = 'stealth(fallback)';
      }
    }
    log(`  策略：${strategy}`);

    const extracted = extractFromHtml(html, url);

    // 反爬验证页/失效文章：不当成正文输出"假文章"。
    const blockedReason = detectBlockedReason(extracted);
    if (blockedReason) throw new Error(`无法获取文章内容（页面提示「${blockedReason}」），可能被反爬拦截或文章已不可访问`);

    const meta = { title: extracted.title, author: extracted.author, publishTime: extracted.publishTime, sourceDomain: extracted.sourceDomain };

    // 基础原则：全部文字 + 图片都要拿到。两种模式都落地本地图片，
    // 不指定 --out 时默认存到 ./article-output/<日期>_<标题>/（回发对话框照旧）。
    // 已存在同名产物时追加 _2、_3…，不静默覆盖。
    const root = outRoot || path.join(process.cwd(), 'article-output');
    const { dir: articleDir, name: baseName } = await resolveArticleDir(
      root, articleBaseName(meta), mode === 'pdf' ? '.pdf' : '.md'
    );
    await fs.mkdir(articleDir, { recursive: true });
    const imageDir = path.join(articleDir, 'images');
    const { updatedHtml, images } = await processImages(extracted.contentHtml, url, imageDir);

    if (mode === 'pdf') {
      await page.addStyleTag({
        content: `@media print { body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
          img { max-width:100% !important; page-break-inside: avoid; }
          pre, blockquote, table, figure { page-break-inside: avoid; }
          h1,h2,h3,h4,h5,h6 { page-break-after: avoid; } }`
      });
      const pdfPath = path.join(articleDir, `${baseName}.pdf`);
      await page.pdf({
        path: pdfPath, format: 'A4', printBackground: true,
        margin: { top: '32px', bottom: '32px', left: '28px', right: '28px' },
        displayHeaderFooter: true, headerTemplate: '<div></div>',
        footerTemplate: '<div style="font-size:9px;color:#888;width:100%;text-align:center;"><span class="pageNumber"></span> / <span class="totalPages"></span></div>'
      });
      log(`  ✓ PDF → ${pdfPath}`);
      return { url, mode, ok: true, strategy, title: meta.title, pdfPath };
    }

    // content：始终落地 <日期>_<标题>.md + 本地图片
    const markdown = buildMarkdown(meta, stripAds(htmlToMarkdown(updatedHtml)), images, url);
    const mdPath = path.join(articleDir, `${baseName}.md`);
    await fs.writeFile(mdPath, markdown, 'utf-8');
    log(`  ✓ Markdown → ${mdPath}（${images.length} 张图片）`);
    return { url, mode, ok: true, strategy, title: meta.title, mdPath, imageDir, markdown };
  } catch (err) {
    log(`  ✗ 失败：${url} — ${err.message}`);
    return { url, mode, ok: false, error: err.message };
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

// ── 并发批处理 ───────────────────────────────────────────

async function runPool(items, size, worker) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) { const i = next++; results[i] = await worker(items[i], i); }
  }));
  return results;
}

// ── 入口 ─────────────────────────────────────────────────

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(HELP); return; }

  let urls = [...opts.urls];
  if (opts.file) urls.push(...extractUrls(await fs.readFile(opts.file, 'utf-8')));
  if (urls.length === 0) urls.push(...extractUrls(await readStdin()));
  urls = [...new Set(urls)];
  if (urls.length === 0) { console.error('未提供任何链接。\n\n' + HELP); process.exit(1); }

  const log = (m) => console.error(m);
  log(`共 ${urls.length} 条链接 | 模式：${opts.mode} | 并发：${opts.concurrency} | 输出：${opts.out || '(content 回发对话框 / pdf 用 ./article-output)'}\n`);

  let results;
  try {
    results = await runPool(urls, opts.concurrency, (url) => fetchOne(url, opts.mode, opts.out, log));
  } finally {
    await closeBrowser();
  }

  const ok = results.filter((r) => r && r.ok).length;
  log(`\n完成：${ok} 成功，${urls.length - ok} 失败。`);

  if (opts.json) {
    // 不在 JSON 里塞正文（批量会很大）；正文读 mdPath 即可。
    const lean = results.map((r) => (r ? (({ markdown, ...rest }) => rest)(r) : r));
    process.stdout.write(JSON.stringify({ mode: opts.mode, outputDir: opts.out, results: lean }, null, 2) + '\n');
  } else if (opts.mode === 'content' && !opts.out) {
    // 默认：正文直接回发对话框（多篇用分隔符标明来源）
    for (const r of results) {
      if (r?.ok) {
        process.stdout.write(results.length > 1 ? `\n\n===== ${r.url} =====\n\n` : '');
        process.stdout.write(r.markdown);
      } else if (r) {
        process.stdout.write(`\n\n===== ${r.url} =====\n[抓取失败] ${r.error}\n`);
      }
    }
  } else {
    // 落盘模式：打印产物路径
    for (const r of results) {
      if (r?.ok) process.stdout.write(`${r.url}\n  → ${r.pdfPath || r.mdPath}\n`);
      else if (r) process.stdout.write(`${r.url}\n  → [失败] ${r.error}\n`);
    }
  }
  if (ok === 0) process.exit(2);
}

main().catch((err) => { console.error('致命错误：', err); process.exit(1); });
