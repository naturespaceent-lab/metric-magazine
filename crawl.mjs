#!/usr/bin/env node

/**
 * METRIC Magazine RSS Crawler + Static Site Generator
 *
 * Crawls RSS feeds from K-pop news sites,
 * extracts article data, rewrites with data-analytics angle,
 * and generates self-contained static HTML pages.
 *
 * Usage: node crawl.mjs
 * No dependencies needed -- pure Node.js 18+ with built-in fetch.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ============================================================
// Configuration
// ============================================================

const SOURCES = [
  // === Tier 1: High-volume K-pop news ===
  { name: 'Soompi', url: 'https://www.soompi.com/feed', lang: 'en' },
  { name: 'Koreaboo', url: 'https://www.koreaboo.com/feed/', lang: 'en' },
  { name: 'HelloKpop', url: 'https://www.hellokpop.com/feed/', lang: 'en' },
  { name: 'Seoulbeats', url: 'https://seoulbeats.com/feed/', lang: 'en' },
  // === Tier 2: Commentary & Reviews ===
  { name: 'AsianJunkie', url: 'https://www.asianjunkie.com/feed/', lang: 'en' },
  { name: 'TheBiasList', url: 'https://thebiaslist.com/feed/', lang: 'en' },
  // === Tier 3: General entertainment w/ K-pop coverage ===
  { name: 'KDramaStars', url: 'https://www.kdramastars.com/rss.xml', lang: 'en' },
  { name: 'DramaNews', url: 'https://www.dramabeans.com/feed/', lang: 'en' },
];

const FETCH_TIMEOUT = 10_000;
const OG_IMAGE_TIMEOUT = 8_000;
const ARTICLE_FETCH_TIMEOUT = 12_000;
const MAX_OG_IMAGE_FETCHES = 40;
const OG_IMAGE_CONCURRENCY = 10;
const ARTICLE_FETCH_CONCURRENCY = 5;
const PLACEHOLDER_IMAGE = 'https://picsum.photos/seed/metric-placeholder/800/450';

const log = (msg) => console.log(`[METRIC Crawler] ${msg}`);
const warn = (msg) => console.warn(`[METRIC Crawler] WARN: ${msg}`);

// ============================================================
// Fetch with timeout
// ============================================================

async function fetchWithTimeout(url, timeoutMs = FETCH_TIMEOUT) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

// ============================================================
// XML Parsing helpers (regex-based, no dependencies)
// ============================================================

function extractTag(xml, tagName) {
  const cdataRe = new RegExp(`<${tagName}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</${tagName}>`, 'i');
  const cdataMatch = xml.match(cdataRe);
  if (cdataMatch) return cdataMatch[1].trim();

  const re = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)</${tagName}>`, 'i');
  const match = xml.match(re);
  return match ? match[1].trim() : '';
}

function extractAllTags(xml, tagName) {
  const results = [];
  const re = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)</${tagName}>`, 'gi');
  let match;
  while ((match = re.exec(xml)) !== null) {
    results.push(match[1].trim());
  }
  return results;
}

function extractAttribute(xml, tagName, attrName) {
  const re = new RegExp(`<${tagName}[^>]*?${attrName}\\s*=\\s*["']([^"']+)["']`, 'i');
  const match = xml.match(re);
  return match ? match[1] : '';
}

function extractItems(xml) {
  const items = [];
  const re = /<item[^>]*>([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = re.exec(xml)) !== null) {
    items.push(match[1]);
  }
  return items;
}

function decodeHtmlEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#8217;/g, "\u2019")
    .replace(/&#8216;/g, "\u2018")
    .replace(/&#8220;/g, "\u201C")
    .replace(/&#8221;/g, "\u201D")
    .replace(/&#8230;/g, "\u2026")
    .replace(/&#038;/g, '&')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

function stripHtml(html) {
  return html.replace(/<[^>]+>/g, '').trim();
}

// ============================================================
// Image extraction
// ============================================================

function extractImageFromContent(content) {
  if (!content) return '';

  const mediaUrl = extractAttribute(content, 'media:content', 'url')
    || extractAttribute(content, 'media:thumbnail', 'url');
  if (mediaUrl) return mediaUrl;

  const enclosureUrl = extractAttribute(content, 'enclosure', 'url');
  if (enclosureUrl) {
    const enclosureType = extractAttribute(content, 'enclosure', 'type');
    if (!enclosureType || enclosureType.startsWith('image')) return enclosureUrl;
  }

  const imgMatch = content.match(/<img[^>]+src\s*=\s*["']([^"']+)["']/i);
  if (imgMatch) return imgMatch[1];

  return '';
}

async function fetchOgImage(articleUrl) {
  try {
    const html = await fetchWithTimeout(articleUrl, OG_IMAGE_TIMEOUT);
    const ogMatch = html.match(/<meta[^>]+property\s*=\s*["']og:image["'][^>]+content\s*=\s*["']([^"']+)["']/i)
      || html.match(/<meta[^>]+content\s*=\s*["']([^"']+)["'][^>]+property\s*=\s*["']og:image["']/i);
    if (ogMatch) return ogMatch[1];
    return '';
  } catch {
    return '';
  }
}

// ============================================================
// Date formatting -- English style "March 22, 2026"
// ============================================================

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function formatDate(dateStr) {
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return '';
    return `${MONTH_NAMES[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
  } catch {
    return '';
  }
}

function formatDateObj(d) {
  return `${MONTH_NAMES[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

// ============================================================
// REWRITE ENGINE -- Data-driven analytical English titles
// ============================================================

const KNOWN_GROUPS = [
  'BTS', 'BLACKPINK', 'TWICE', 'EXO', 'NCT', 'aespa', 'Stray Kids', 'ENHYPEN',
  'TXT', 'ATEEZ', 'SEVENTEEN', 'Red Velvet', 'IVE', 'LE SSERAFIM', 'NewJeans',
  '(G)I-DLE', 'ITZY', 'NMIXX', 'Kep1er', 'TREASURE', 'MAMAMOO', 'SHINee',
  'GOT7', 'MONSTA X', 'iKON', 'WINNER', '2NE1', "Girls' Generation", 'Super Junior',
  'BIGBANG', 'LOONA', 'fromis_9', 'tripleS', 'Dreamcatcher', 'VIVIZ',
  'Brave Girls', 'OH MY GIRL', 'Apink', 'BTOB', 'PENTAGON', 'SF9', 'THE BOYZ',
  'Golden Child', 'ONEUS', 'VERIVERY', 'CIX', 'VICTON', 'AB6IX', 'WEi',
  'CRAVITY', 'P1Harmony', 'TEMPEST', 'YOUNITE', 'Xdinary Heroes', 'Billlie',
  'LIGHTSUM', 'Weki Meki', 'Cherry Bullet', 'Rocket Punch', 'Purple Kiss',
  'Lapillus', 'FIFTY FIFTY', 'KISS OF LIFE', 'BABYMONSTER', 'ILLIT',
  'ZEROBASEONE', 'RIIZE', 'TWS', 'BOYNEXTDOOR', 'xikers', 'NCT 127',
  'NCT DREAM', 'WayV', 'NCT WISH', 'SNSD', 'f(x)', 'EXO-CBX', 'Super M',
  'Girls Generation', 'DAY6', 'ASTRO', 'Kara', 'INFINITE', 'BEAST',
  'Highlight', 'Block B', 'B.A.P', 'VIXX', 'CNBLUE', 'FTIsland',
  'ZB1', 'G-IDLE',
];

const KNOWN_SOLOISTS = [
  'V', 'Jungkook', 'Jennie', 'Lisa', 'Ros\u00e9', 'Jisoo', 'Suga', 'RM', 'J-Hope',
  'Jin', 'Jimin', 'Winter', 'Karina', 'Giselle', 'NingNing', 'Taeyeon', 'IU',
  'Sunmi', 'HyunA', 'Hwasa', 'Solar', 'Joy', 'Irene', 'Yeri', 'Wendy', 'Seulgi',
  'Mark', 'Taeyong', 'Jaehyun', 'Doyoung', 'Haechan', 'Jeno', 'Jaemin', 'Renjun',
  'Chenle', 'Jisung', 'Bangchan', 'Hyunjin', 'Felix', 'Han', 'Lee Know', 'Changbin',
  'Seungmin', 'I.N', 'Heeseung', 'Jay', 'Jake', 'Sunghoon', 'Sunoo', 'Jungwon',
  'Ni-ki', 'Soobin', 'Yeonjun', 'Beomgyu', 'Taehyun', 'Hueningkai', 'Hongjoong',
  'Seonghwa', 'Yunho', 'Yeosang', 'San', 'Mingi', 'Wooyoung', 'Jongho',
  'S.Coups', 'Jeonghan', 'Joshua', 'Jun', 'Hoshi', 'Wonwoo', 'Woozi', 'DK',
  'Mingyu', 'The8', 'Seungkwan', 'Vernon', 'Dino', 'Wonyoung', 'Yujin', 'Gaeul',
  'Liz', 'Leeseo', 'Rei', 'Sakura', 'Chaewon', 'Kazuha', 'Eunchae', 'Minji',
  'Hanni', 'Danielle', 'Haerin', 'Hyein', 'Miyeon', 'Minnie', 'Soyeon', 'Yuqi',
  'Shuhua', 'Yeji', 'Lia', 'Ryujin', 'Chaeryeong', 'Yuna', 'Sullyoon', 'Haewon',
  'Lily', 'Bae', 'Jiwoo', 'Kyujin', 'Cha Eun Woo', 'Park Bo Gum',
  'Song Joong Ki', 'Lee Min Ho', 'Kim Soo Hyun', 'Park Seo Joon', 'Jung Hae In',
  'Song Hye Kyo', 'Jun Ji Hyun', 'Kim Ji Won', 'Han So Hee', 'Suzy',
  'Park Shin Hye', 'Lee Sung Kyung', 'Yoo Yeon Seok', 'Park Na Rae',
  'Taemin', 'Baekhyun', 'Chanyeol', 'D.O.', 'Kai', 'Sehun', 'Xiumin',
  'Lay', 'Chen', 'Suho', 'GDragon', 'G-Dragon', 'Taeyang', 'Daesung',
  'Seungri', 'TOP', 'CL', 'Dara', 'Bom', 'Minzy', 'Zico',
  'Jackson', 'BamBam', 'Yugyeom', 'Youngjae', 'JB', 'Jinyoung',
  'Nayeon', 'Jeongyeon', 'Momo', 'Sana', 'Jihyo', 'Mina', 'Dahyun',
  'Chaeyoung', 'Tzuyu',
];

const ALL_KNOWN_NAMES = [...KNOWN_GROUPS, ...KNOWN_SOLOISTS]
  .sort((a, b) => b.length - a.length);

// ---- Topic classifier keyword map ----

const TOPIC_KEYWORDS = {
  comeback:     ['comeback', 'return', 'back', 'coming back', 'pre-release'],
  chart:        ['chart', 'billboard', 'number', 'record', 'no.1', '#1', 'top 10', 'million', 'stream', 'sales'],
  release:      ['album', 'single', 'ep', 'tracklist', 'release', 'drop', 'mini-album', 'mini album', 'full album'],
  concert:      ['concert', 'tour', 'live', 'stage', 'arena', 'stadium', 'world tour', 'encore'],
  award:        ['award', 'win', 'trophy', 'daesang', 'bonsang', 'grammy', 'mama', 'golden disc', 'melon'],
  fashion:      ['fashion', 'style', 'outfit', 'airport', 'look', 'brand', 'ambassador', 'vogue', 'elle'],
  sns:          ['social', 'instagram', 'tiktok', 'twitter', 'followers', 'viral', 'trending', 'engagement', 'views'],
  debut:        ['debut', 'launch', 'pre-debut', 'trainee', 'survival', 'rookie'],
  collab:       ['collaboration', 'collab', 'featuring', 'feat', 'team up', 'duet', 'joint'],
  variety:      ['variety', 'show', 'tv', 'running man', 'knowing bros', 'weekly idol', 'guest', 'ratings'],
  general:      [],
};

// ---- METRIC title templates -- data-driven analytical English ----

const TITLE_TEMPLATES = {
  comeback: [
    "By the Numbers: {artist}'s Comeback Launch Performance",
    "Data Shows {artist}'s Return Breaking Pre-Order Records",
    "{artist} Comeback Analytics: What the Numbers Tell Us",
    "Pre-Release Data Points to Strong {artist} Comeback",
    "Tracking {artist}'s Comeback Momentum: A Data Overview",
  ],
  chart: [
    "{artist}'s Chart Trajectory: A Statistical Breakdown",
    "How {artist} Dominated This Week's Charts",
    "The Data Behind {artist}'s Record-Setting Chart Run",
    "{artist}'s Chart Performance: Dissecting the Numbers",
    "Weekly Chart Report: {artist} Holds the Top Position",
  ],
  release: [
    "Streaming Report: {artist}'s New Release First-Week Numbers",
    "{artist}'s Latest Track by the Numbers",
    "Early Data on {artist}'s Release Shows Strong Momentum",
    "First-Week Sales Analysis: {artist}'s New Album",
    "{artist}'s Release Performance Compared to Industry Benchmarks",
  ],
  concert: [
    "{artist} Tour Revenue Analysis: Record-Breaking Figures",
    "Ticket Sales Data: {artist}'s Concert Demand Surges",
    "The Economics of {artist}'s Live Performance",
    "{artist}'s Tour by the Numbers: Venues, Revenue, Reach",
    "Concert Data Shows {artist}'s Touring Power at Peak",
  ],
  award: [
    "Awards Data: How {artist}'s Win Compares Historically",
    "{artist}'s Award Season Performance in Context",
    "Statistical Analysis of {artist}'s Award Trajectory",
    "Measuring {artist}'s Awards Dominance: A Data Look",
    "{artist}'s Award-Season Metrics Outperform Expectations",
  ],
  fashion: [
    "{artist}'s Brand Impact: Measuring Fashion Influence",
    "Social Engagement Data: {artist}'s Style Moments",
    "{artist}'s Fashion ROI: How Style Drives Brand Value",
    "Brand Mentions Spike Following {artist}'s Latest Look",
    "The {artist} Effect: Quantifying Fashion Influence",
  ],
  sns: [
    "Platform Analytics: {artist}'s Social Media Growth Rate",
    "{artist}'s Engagement Metrics Outpace Industry Average",
    "{artist}'s Social Media Reach: A Cross-Platform Analysis",
    "Follower Growth Report: {artist}'s Digital Presence Expands",
    "Viral Coefficient: How {artist}'s Content Spreads",
  ],
  debut: [
    "Debut Analytics: How {artist}'s Launch Compares to Recent Acts",
    "First-Week Data for Rookie Group {artist}",
    "{artist}'s Debut by the Numbers: A Promising Start",
    "Measuring {artist}'s Debut Impact Against Industry Averages",
    "Rookie Report: {artist}'s Opening Metrics Analyzed",
  ],
  collab: [
    "Collab Impact: How {artist}'s Partnership Moved the Needle",
    "Cross-Audience Data on {artist}'s Collaboration",
    "{artist}'s Collaboration Drives Measurable Audience Overlap",
    "The Numbers Behind {artist}'s Latest Joint Project",
    "Collaboration ROI: {artist}'s Partnership in Data",
  ],
  variety: [
    "Viewership Data: {artist}'s TV Appearance Drives Ratings",
    "How {artist}'s Variety Show Boosted Their Metrics",
    "Ratings Analysis: {artist}'s Television Impact Quantified",
    "{artist}'s TV Exposure Correlates with Streaming Spike",
    "Variety Show Data: {artist}'s Appearance Moves Numbers",
  ],
  general: [
    "This Week's K-Pop Data Points Worth Watching",
    "The Numbers Behind K-Pop's Biggest Story",
    "METRIC's Weekly K-Pop Industry Analysis",
    "K-Pop by the Numbers: This Week's Key Metrics",
    "Industry Data Roundup: What Moved in K-Pop This Week",
  ],
};

const NO_ARTIST_TEMPLATES = [
  "This Week's K-Pop Data Points Worth Watching",
  "The Numbers Behind K-Pop's Biggest Story This Week",
  "METRIC's Weekly K-Pop Industry Analysis",
  "K-Pop by the Numbers: This Week's Key Metrics",
  "Industry Data Roundup: What Moved in K-Pop This Week",
  "Chart Trends and Streaming Shifts: Weekly Report",
  "K-Pop Market Snapshot: Trends and Takeaways",
  "Data Dispatch: What the Numbers Say About K-Pop Right Now",
  "Weekly K-Pop Analytics: Trends, Charts, and Insights",
  "Platform Metrics Across K-Pop: A Weekly Overview",
];

// ---- Display categories for METRIC ----

const DISPLAY_CATEGORIES = {
  comeback: 'CHARTS',
  chart: 'CHARTS',
  release: 'STREAMING',
  concert: 'LIVE DATA',
  award: 'AWARDS',
  fashion: 'TRENDS',
  sns: 'SOCIAL',
  debut: 'DEBUT',
  collab: 'COLLAB',
  variety: 'INDUSTRY',
  general: 'ANALYSIS',
};

// ---- Helpers ----

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

const COMMON_ENGLISH_WORDS = new Set([
  'the', 'a', 'an', 'this', 'that', 'these', 'here', 'why', 'how', 'what',
  'when', 'who', 'which', 'where', 'watch', 'check', 'best', 'top', 'new',
  'breaking', 'exclusive', 'official', 'first', 'latest', 'all', 'every',
  'open', 'just', 'more', 'most', 'some', 'many', 'after', 'before',
  'korean', 'kpop', 'k-pop', 'idol', 'idols', 'legendary', 'former',
  'young', 'old', 'big', 'small', 'great', 'good', 'bad', 'real',
  'full', 'final', 'last', 'next', 'other', 'another', 'each', 'both',
  'only', 'even', 'still', 'also', 'already', 'never', 'always', 'again',
  'now', 'then', 'today', 'week', 'weekly', 'daily', 'year', 'month',
  'thread', 'list', 'review', 'reviews', 'roundup', 'recap', 'guide',
  'report', 'reports', 'update', 'updates', 'news', 'story', 'stories',
  'song', 'songs', 'album', 'albums', 'track', 'tracks', 'single', 'singles',
  'music', 'video', 'drama', 'movie', 'show', 'shows', 'stage', 'live',
  'tour', 'concert', 'award', 'awards', 'chart', 'charts', 'record',
  'debut', 'comeback', 'release', 'releases', 'performance', 'cover',
  'photo', 'photos', 'fashion', 'style', 'beauty', 'look', 'looks',
  'will', 'can', 'could', 'would', 'should', 'may', 'might', 'must',
  'does', 'did', 'has', 'had', 'have', 'been', 'being', 'are', 'were',
  'get', 'gets', 'got', 'make', 'makes', 'made', 'take', 'takes', 'took',
  'give', 'gives', 'gave', 'come', 'comes', 'came', 'keep', 'keeps', 'kept',
  'let', 'say', 'says', 'said', 'see', 'sees', 'saw', 'know', 'knows',
  'think', 'find', 'finds', 'want', 'wants', 'tell', 'tells',
  'ask', 'asks', 'work', 'works', 'seem', 'seems', 'feel', 'feels',
  'try', 'tries', 'start', 'starts', 'need', 'needs', 'run', 'runs',
  'move', 'moves', 'play', 'plays', 'pay', 'pays', 'hear', 'hears',
  'during', 'about', 'with', 'from', 'into', 'over', 'under', 'between',
  'through', 'against', 'without', 'within', 'along', 'behind',
  'inside', 'outside', 'above', 'below', 'upon', 'onto', 'toward',
  'for', 'but', 'not', 'yet', 'nor', 'and', 'or', 'so',
  'while', 'since', 'until', 'unless', 'because', 'although', 'though',
  'if', 'than', 'whether', 'once', 'twice',
  'his', 'her', 'its', 'our', 'their', 'my', 'your',
  'he', 'she', 'it', 'we', 'they', 'you', 'me', 'him', 'us', 'them',
  'no', 'yes', 'not', "don't", "doesn't", "didn't", "won't", "can't",
  'eight', 'five', 'four', 'nine', 'one', 'seven', 'six', 'ten', 'three', 'two',
  'up', 'down', 'out', 'off', 'on', 'in', 'at', 'to', 'by', 'of',
  'coming', 'going', 'looking', 'rising', 'star', 'stars',
  'spill', 'spills', 'choi', 'lee', 'kim', 'park', 'jung', 'shin',
  'won', 'young', 'min', 'sung', 'hyun', 'jae', 'hye',
]);

const SHORT_AMBIGUOUS_NAMES = new Set(['V', 'TOP', 'CL', 'JB', 'DK', 'Jun', 'Jay', 'Kai', 'Lay', 'Bom', 'Liz', 'Bae', 'Han', 'San', 'Rei', 'Lia']);

function extractArtist(title) {
  for (const name of ALL_KNOWN_NAMES) {
    if (SHORT_AMBIGUOUS_NAMES.has(name)) continue;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?:^|[\\s,;:'"(\\[])${escaped}(?=[\\s,;:'"')\\]!?.]|$)`, 'i');
    if (re.test(title)) return name;
  }

  for (const name of SHORT_AMBIGUOUS_NAMES) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?:^|[\\s,;:'"(\\[])${escaped}(?=[\\s,;:'"')\\]!?.]|$)`);
    if (re.test(title)) {
      const pos = title.indexOf(name);
      if (pos <= 5) return name;
    }
  }

  const leadingName = title.match(/^([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})\b/);
  if (leadingName) {
    const candidate = leadingName[1];
    const words = candidate.split(/\s+/);
    const allWordsValid = words.every(w => !COMMON_ENGLISH_WORDS.has(w.toLowerCase()));
    if (allWordsValid && words.length >= 2 && words.length <= 4) return candidate;
  }

  return null;
}

function classifyTopic(title) {
  const lower = title.toLowerCase();
  for (const [topic, keywords] of Object.entries(TOPIC_KEYWORDS)) {
    if (topic === 'general') continue;
    for (const kw of keywords) {
      if (lower.includes(kw)) return topic;
    }
  }
  return 'general';
}

function rewriteTitle(originalTitle) {
  const artist = extractArtist(originalTitle);
  const topic = classifyTopic(originalTitle);

  if (artist) {
    const templates = TITLE_TEMPLATES[topic] || TITLE_TEMPLATES.general;
    const template = pickRandom(templates);
    return template.replace(/\{artist\}/g, artist);
  }

  return pickRandom(NO_ARTIST_TEMPLATES);
}

function displayCategory(category) {
  const topic = classifyTopic(category || '');
  return DISPLAY_CATEGORIES[topic] || 'ANALYSIS';
}

function displayCategoryFromTitle(title) {
  const topic = classifyTopic(title || '');
  return DISPLAY_CATEGORIES[topic] || 'ANALYSIS';
}

// ============================================================
// Image downloading
// ============================================================

const IMAGES_DIR = join(__dirname, 'images');
const ARTICLES_DIR = join(__dirname, 'articles');

async function downloadImage(url, filename) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Referer': new URL(url).origin,
      },
    });
    clearTimeout(timer);

    if (!res.ok || !res.body) return null;

    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('image')) return null;

    const ext = contentType.includes('png') ? '.png'
      : contentType.includes('webp') ? '.webp'
      : '.jpg';
    const localFile = `${filename}${ext}`;
    const localPath = join(IMAGES_DIR, localFile);

    const buffer = Buffer.from(await res.arrayBuffer());
    await writeFile(localPath, buffer);

    return `images/${localFile}`;
  } catch {
    return null;
  }
}

async function downloadArticleImages(articles) {
  await mkdir(IMAGES_DIR, { recursive: true });

  log('Downloading article images locally...');
  let downloaded = 0;
  const BATCH = 8;

  for (let i = 0; i < articles.length; i += BATCH) {
    const batch = articles.slice(i, i + BATCH);
    await Promise.allSettled(
      batch.map(async (article, idx) => {
        if (!article.image || article.image.includes('picsum.photos')) return;
        const safeName = `article-${i + idx}-${Date.now() % 100000}`;
        const localPath = await downloadImage(article.image, safeName);
        if (localPath) {
          article.originalImage = article.image;
          article.image = localPath;
          downloaded++;
        }
      })
    );
  }

  log(`  Downloaded ${downloaded}/${articles.length} images locally`);
}

// ============================================================
// RSS Feed Parsing
// ============================================================

function parseRssFeed(xml, sourceName) {
  const items = extractItems(xml);
  const articles = [];

  for (const item of items) {
    const title = decodeHtmlEntities(stripHtml(extractTag(item, 'title')));
    const link = extractTag(item, 'link');
    const pubDate = extractTag(item, 'pubDate');
    const creator = extractTag(item, 'dc:creator');
    const categories = extractAllTags(item, 'category').map(c => decodeHtmlEntities(stripHtml(c)));
    const category = categories[0] || 'News';
    const description = extractTag(item, 'description');
    const contentEncoded = extractTag(item, 'content:encoded');

    let image = extractImageFromContent(item);
    if (!image) image = extractImageFromContent(contentEncoded);
    if (!image) image = extractImageFromContent(description);

    if (!title || !link) continue;

    articles.push({
      title,
      link,
      pubDate: pubDate ? new Date(pubDate) : new Date(),
      formattedDate: formatDate(pubDate),
      creator,
      category,
      categories,
      image,
      source: sourceName,
      articleContent: null,
    });
  }

  return articles;
}

// ============================================================
// Fetch all feeds
// ============================================================

async function fetchAllFeeds() {
  const allArticles = [];

  for (const source of SOURCES) {
    try {
      log(`Fetching ${source.name}...`);
      const xml = await fetchWithTimeout(source.url);
      const articles = parseRssFeed(xml, source.name);
      log(`  ${source.name}: ${articles.length} articles`);
      allArticles.push(...articles);
    } catch (err) {
      warn(`Failed to fetch ${source.name}: ${err.message}`);
    }
  }

  allArticles.sort((a, b) => b.pubDate.getTime() - a.pubDate.getTime());

  log(`Total: ${allArticles.length} articles`);
  return allArticles;
}

// ============================================================
// Fill missing images via og:image
// ============================================================

async function fillMissingImages(articles) {
  const needsImage = articles.filter(a => !a.image);
  if (needsImage.length === 0) return;

  const toFetch = needsImage.slice(0, MAX_OG_IMAGE_FETCHES);
  log(`Extracting og:image for ${toFetch.length} articles (concurrency: ${OG_IMAGE_CONCURRENCY})...`);

  let found = 0;
  for (let i = 0; i < toFetch.length; i += OG_IMAGE_CONCURRENCY) {
    const batch = toFetch.slice(i, i + OG_IMAGE_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (article) => {
        const ogImage = await fetchOgImage(article.link);
        if (ogImage) {
          article.image = ogImage;
          return true;
        }
        return false;
      })
    );
    found += results.filter(r => r.status === 'fulfilled' && r.value === true).length;
  }

  log(`  Found og:image for ${found}/${toFetch.length} articles`);
}

// ============================================================
// Fetch article content from original pages
// ============================================================

function extractArticleContent(html) {
  let cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<aside[\s\S]*?<\/aside>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<div[^>]*class\s*=\s*["'][^"']*(?:sidebar|comment|social|share|related|ad-|ads-|advertisement|cookie|popup|modal|newsletter)[^"']*["'][\s\S]*?<\/div>/gi, '');

  const articleBodyPatterns = [
    /<article[^>]*>([\s\S]*?)<\/article>/i,
    /<div[^>]*class\s*=\s*["'][^"']*(?:article-body|article-content|entry-content|post-content|story-body|content-body|single-content)[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
    /<div[^>]*class\s*=\s*["'][^"']*(?:post-entry|article-text|body-text|main-content|article__body|post__content)[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
  ];

  let bodyHtml = '';
  for (const pattern of articleBodyPatterns) {
    const match = cleaned.match(pattern);
    if (match) {
      bodyHtml = match[1];
      break;
    }
  }
  if (!bodyHtml) bodyHtml = cleaned;

  const paragraphs = [];
  const pRegex = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  let pMatch;
  while ((pMatch = pRegex.exec(bodyHtml)) !== null) {
    const text = stripHtml(decodeHtmlEntities(pMatch[1])).trim();
    if (text.length > 30 &&
        !text.match(/^(advertisement|sponsored|also read|read more|related:|source:|photo:|credit:|getty|shutterstock|loading)/i)) {
      paragraphs.push(text);
    }
  }

  const images = [];
  const imgRegex = /<img[^>]+src\s*=\s*["']([^"']+)["'][^>]*>/gi;
  let imgMatch;
  while ((imgMatch = imgRegex.exec(bodyHtml)) !== null) {
    const src = imgMatch[1];
    if (src && !src.includes('avatar') && !src.includes('icon') && !src.includes('logo') &&
        !src.includes('1x1') && !src.includes('pixel') && !src.includes('tracking')) {
      images.push(src);
    }
  }

  return { paragraphs, images };
}

async function fetchArticleContent(article) {
  try {
    const html = await fetchWithTimeout(article.link, ARTICLE_FETCH_TIMEOUT);
    return extractArticleContent(html);
  } catch {
    return { paragraphs: [], images: [] };
  }
}

async function fetchAllArticleContent(articles) {
  const toFetch = articles.slice(0, 50);
  log(`Fetching full article content for ${toFetch.length} articles (concurrency: ${ARTICLE_FETCH_CONCURRENCY})...`);

  let fetched = 0;
  for (let i = 0; i < toFetch.length; i += ARTICLE_FETCH_CONCURRENCY) {
    const batch = toFetch.slice(i, i + ARTICLE_FETCH_CONCURRENCY);
    await Promise.allSettled(
      batch.map(async (article) => {
        const content = await fetchArticleContent(article);
        if (content.paragraphs.length > 0) {
          article.articleContent = content;
          fetched++;
        }
      })
    );
  }

  log(`  Fetched content for ${fetched}/${toFetch.length} articles`);
}

// ============================================================
// Article body generation -- analytical English style
// ============================================================

const BODY_TEMPLATES = {
  comeback: {
    opening: [
      "The data around {artist}'s upcoming comeback paints a compelling picture. Pre-order figures, social media engagement rates, and search volume trends all point to what could be one of the most anticipated returns this quarter. Here's what the numbers are telling us.",
      "By nearly every measurable metric, {artist}'s comeback is generating significant momentum. Pre-release streaming numbers and social media impressions suggest a fanbase that is not only loyal but growing. METRIC breaks down the key data points.",
      "{artist} is preparing for a comeback, and the early indicators are strong. Pre-save counts have already surpassed their previous release by a meaningful margin, and Google Trends data shows a notable uptick in search interest.",
    ],
    analysis: [
      "Looking at the streaming data more closely, {artist}'s pre-release single has accumulated impressive numbers within its first 72 hours. When compared to the same window for their previous release, the growth rate is notable -- suggesting both retained listeners and a wave of new fans discovering their catalog.",
      "Social media metrics offer another lens on {artist}'s comeback readiness. Engagement rates across Instagram and Twitter have been trending upward for weeks, with fan-generated content reaching audiences well beyond the core fandom. This kind of organic amplification often correlates with strong first-week sales.",
      "From a market positioning standpoint, {artist}'s comeback timing is strategic. The competitive landscape this quarter is less crowded than the previous one, giving them a clearer path to chart dominance. Historical data suggests that releases in this window tend to perform above average.",
    ],
    closing: [
      "As {artist}'s comeback continues to unfold, METRIC will be tracking the numbers in real time. First-week sales, streaming velocity, and chart positions will tell the story. Stay tuned for our full post-release analysis.",
      "The pre-release data paints an optimistic picture for {artist}, but the real test begins at launch. METRIC will provide a comprehensive breakdown of first-week performance data as it becomes available.",
    ],
  },
  chart: {
    opening: [
      "{artist}'s chart performance this cycle has been nothing short of remarkable. The numbers tell a story of sustained dominance -- not a spike followed by a rapid decline, but a steady hold that signals deep listener engagement.",
      "When we look at {artist}'s chart trajectory over the past several weeks, a clear pattern emerges. This is not luck or algorithmic favor; the data points to genuine, broad-based consumption across multiple platforms.",
      "The charts have spoken, and {artist} is leading the conversation. From streaming counts to download figures, the statistical profile of this release is among the strongest we've tracked this year.",
    ],
    analysis: [
      "A deeper dive into the streaming data reveals that {artist}'s unique listener count is growing at an above-average rate compared to comparable releases. The ratio of unique listeners to total streams suggests high replay value -- a metric that often predicts long-term chart endurance.",
      "Cross-platform analysis shows {artist} performing consistently across Spotify, Apple Music, and YouTube Music. This kind of platform parity is significant; releases that over-index on a single platform tend to have shorter chart lifespans.",
      "Comparing {artist}'s current trajectory to historical benchmarks, the numbers are competitive with several of the year's top-performing releases. The key differentiator appears to be international streaming share, which now accounts for a larger portion than in previous cycles.",
    ],
    closing: [
      "METRIC will continue to monitor {artist}'s chart position and streaming velocity. If current trends hold, we may be looking at one of the most durable chart runs of the quarter.",
      "The data suggests {artist}'s chart presence is far from a flash. We'll provide updated analysis as new weekly figures come in.",
    ],
  },
  release: {
    opening: [
      "{artist}'s latest release has landed, and the first-week data is in. The numbers paint a nuanced picture -- strong in some areas, with room for analysis in others. Here's METRIC's breakdown of what the streaming and sales data tells us.",
      "The initial numbers for {artist}'s new release are now available, and they warrant a close look. First-day streaming figures, physical sales data, and platform chart positions all contribute to our understanding of this release's market reception.",
      "With {artist}'s new album now available across all platforms, the data is starting to flow in. METRIC has compiled the early metrics to give you an evidence-based assessment of this release's commercial trajectory.",
    ],
    analysis: [
      "First-day streaming numbers show {artist}'s release tracking ahead of their previous effort, with particularly strong performance on Spotify where the lead single debuted in the top 50 globally. The ratio of saves to streams is notably high, indicating strong listener intent to return.",
      "Physical album sales data, while still preliminary, suggests {artist}'s core fanbase is engaged. Pre-order fulfillment numbers are consistent with projections, and limited editions appear to have sold through quickly. The physical-to-digital ratio for this release aligns with broader K-pop industry patterns.",
      "One metric worth highlighting is the playlist inclusion rate. {artist}'s tracks have been added to a significant number of editorial playlists across major platforms, which historically correlates with sustained streaming over the following weeks.",
    ],
    closing: [
      "METRIC will provide a full first-week report once all data sources have reported. The early indicators suggest a competitive release in a crowded market.",
      "As more data becomes available, METRIC will update our analysis with comparative benchmarks and trend projections. Check back for the complete performance report.",
    ],
  },
  concert: {
    opening: [
      "The economics of {artist}'s live performance are impressive by any standard. Ticket sales data, venue capacities, and secondary market pricing all point to exceptional demand. METRIC analyzes the numbers behind the tour.",
      "{artist}'s concert announcement generated a measurable surge in activity across ticketing platforms. The speed of sell-outs and the premium pricing on the secondary market provide quantifiable evidence of their touring power.",
      "Live performance remains one of the most telling metrics for an artist's real-world popularity, and {artist}'s recent concert data is unambiguous. The figures show strong demand across multiple markets.",
    ],
    analysis: [
      "Ticket sales velocity for {artist}'s tour dates exceeded the average for comparable K-pop acts touring similar venues. Several dates sold out within minutes of general sale, a threshold that puts {artist} in the top tier of touring acts globally. Secondary market data shows tickets trading at 2-3x face value.",
      "Venue selection is another data point worth examining. {artist}'s upgrade to larger venues in several markets reflects promoter confidence in demand projections. Historical data shows that K-pop acts successfully filling these larger venues tend to see increased streaming activity in those markets post-tour.",
      "When we factor in merchandise revenue estimates and sponsorship deals, the total economic footprint of {artist}'s tour extends well beyond ticket sales. The live performance sector remains a crucial revenue driver, and {artist}'s numbers validate their position in the market.",
    ],
    closing: [
      "METRIC will continue tracking {artist}'s tour performance data, including any added dates and market-by-market attendance figures. The live sector remains a key indicator of artist health.",
      "The touring data for {artist} reinforces what the streaming numbers have been suggesting: this is an act at or near peak commercial form. METRIC will report on post-tour streaming impact as data becomes available.",
    ],
  },
  award: {
    opening: [
      "{artist}'s recent award recognition provides an opportunity to examine their competitive position through a data lens. Awards are inherently subjective, but the underlying metrics that inform them are not. Here's what the numbers show.",
      "Awards season often serves as a barometer for industry standing, and {artist}'s performance this cycle has been noteworthy. METRIC takes a statistical approach to putting their wins and nominations in historical context.",
      "{artist} has added another award to their trophy case. But beyond the ceremony itself, the data surrounding their award-season performance tells an interesting story about market position and momentum.",
    ],
    analysis: [
      "Historically, award wins at this level correlate with a measurable boost in streaming activity. Previous winners in this category saw an average increase of 15-25% in daily streams in the week following the ceremony. If {artist} follows this pattern, we should see a corresponding uptick.",
      "When we compare {artist}'s body of work this cycle to other nominees, several data points stand out: total streaming volume, chart peak positions, album sales figures, and social media engagement rates. In most of these categories, {artist} ranked at or near the top.",
      "The cumulative effect of award recognition on an artist's career trajectory is well-documented in our data. Acts that win consistently tend to see compounding benefits in terms of playlist placement, media coverage, and international market expansion.",
    ],
    closing: [
      "METRIC will track the post-award impact on {artist}'s streaming and sales metrics. Awards often serve as inflection points, and the data in the coming weeks will show whether this one follows the pattern.",
      "As awards season continues, METRIC will provide data-driven analysis of each major ceremony. The numbers behind the nominations often tell a more complete story than the results alone.",
    ],
  },
  fashion: {
    opening: [
      "When {artist} steps out in a new look, the data reacts. Social media impressions, brand mention volumes, and search trends all register measurable spikes. METRIC quantifies the fashion influence that {artist} wields.",
      "{artist}'s fashion moments have become data events in their own right. Brand engagement metrics, earned media value, and social reach all point to an artist whose style choices carry genuine commercial weight.",
      "The intersection of K-pop and fashion is increasingly quantifiable, and {artist} sits at the center of that data story. Their latest appearance generated metrics that rival dedicated fashion industry campaigns.",
    ],
    analysis: [
      "Social listening data shows a significant spike in brand mentions following {artist}'s latest public appearance. The engagement rate on posts featuring the outfit exceeded the account's average by a notable margin, suggesting the content resonated beyond the core fanbase.",
      "From an earned media value perspective, {artist}'s fashion moment generated coverage across entertainment, lifestyle, and fashion outlets. This cross-vertical reach is a key indicator of mainstream influence, and {artist}'s numbers consistently rank among the highest for K-pop acts.",
      "Brand search volume data following {artist}'s appearance showed a measurable increase for the featured designers and labels. This 'halo effect' is exactly what luxury brands seek when partnering with K-pop artists, and {artist}'s data validates the investment.",
    ],
    closing: [
      "METRIC tracks the data behind K-pop's fashion influence. As {artist} continues to make style-driven headlines, we'll quantify the impact and compare it to industry benchmarks.",
      "The numbers confirm what the industry already suspected: {artist}'s fashion influence is real, measurable, and commercially significant. METRIC will continue monitoring these data points.",
    ],
  },
  sns: {
    opening: [
      "{artist}'s social media metrics have been on an upward trajectory, and the latest data confirms the trend. Follower growth rates, engagement ratios, and content virality metrics all point to an expanding digital presence.",
      "Platform analytics for {artist} reveal a social media profile that is outpacing the K-pop industry average. Cross-platform data shows consistent growth across Instagram, TikTok, and Twitter, with engagement metrics that are especially noteworthy.",
      "Social media is the pulse of modern fandom, and {artist}'s numbers tell a story of accelerating growth. METRIC breaks down the platform-by-platform data.",
    ],
    analysis: [
      "{artist}'s engagement rate across platforms consistently exceeds the K-pop industry average. On Instagram, their posts achieve interaction rates that place them in the top percentile of entertainment accounts. This is not simply a function of follower count; it reflects genuine audience connection.",
      "TikTok has emerged as a particularly strong platform for {artist}. Content featuring their music or likeness has accumulated significant views, with a disproportionate share coming from users outside the traditional K-pop audience. This platform crossover is a leading indicator of mainstream cultural relevance.",
      "Content velocity is another metric worth examining. {artist}'s posting cadence and the consistency of audience response suggest a well-optimized content strategy. The ratio of organic to prompted engagement is healthy, indicating that the audience is self-motivated rather than purely campaign-driven.",
    ],
    closing: [
      "METRIC will continue tracking {artist}'s social media metrics as part of our broader platform analytics coverage. Digital presence is increasingly correlated with commercial performance, and {artist}'s data is worth watching.",
      "The social media data for {artist} aligns with their broader performance metrics: growth, engagement, and expanding reach. METRIC will provide quarterly updates on these trends.",
    ],
  },
  debut: {
    opening: [
      "{artist}'s debut has now generated enough data for a meaningful analysis. First-week streaming numbers, chart positions, social media growth, and media coverage volume all provide a baseline for evaluating this new act's market entry.",
      "Debut analytics are among the most telling data sets in K-pop. They establish baselines, reveal market receptivity, and set expectations for future performance. {artist}'s debut numbers are now in, and here's what they show.",
      "Every new act enters the market with uncertainty, but data can cut through the noise. {artist}'s debut performance, measured across streaming, sales, and social metrics, provides a clearer picture of their early trajectory.",
    ],
    analysis: [
      "Compared to recent K-pop debuts in the same tier, {artist}'s first-week numbers are competitive. Streaming figures place them above the median for new acts, and their social media follower acquisition rate during launch week exceeded what we've seen from several comparable groups.",
      "One notable data point is {artist}'s international streaming share. For a debut act, a high proportion of listens coming from outside Korea suggests effective pre-debut marketing or strong label infrastructure for global distribution. Either way, it's a positive signal for long-term growth potential.",
      "Music video views, while not the most reliable metric on their own, provide another reference point. {artist}'s MV achieved strong view counts in its first 24 hours, and the engagement metrics (likes, comments, shares) suggest authentic viewer interest rather than passive consumption.",
    ],
    closing: [
      "Debut data is only the beginning of the story. METRIC will track {artist}'s trajectory over the coming months to see whether initial momentum translates into sustained growth.",
      "The early data for {artist} is promising but preliminary. METRIC will revisit these numbers at the 30-day and 90-day marks for a more complete picture.",
    ],
  },
  collab: {
    opening: [
      "Collaborations in K-pop are strategic data events. When {artist} partners with another act, the resulting audience overlap metrics, streaming lift, and social media cross-pollination provide valuable insights. Here's what the numbers show.",
      "{artist}'s latest collaboration has generated measurable impact across multiple data dimensions. From streaming numbers to social media reach, the partnership appears to be delivering for both parties involved.",
      "The data behind {artist}'s collaboration tells an interesting story about audience dynamics. METRIC examines the cross-pollination effect and what it means for both artists' metrics.",
    ],
    analysis: [
      "Streaming data for the collaboration track shows a lift for both artists. {artist}'s monthly listener count on Spotify saw a measurable increase in the days following release, suggesting that the partner's audience is converting to {artist} listeners. This cross-discovery effect is the primary strategic value of collaborations.",
      "Social media cross-pollination metrics are equally telling. Mentions of {artist} in the partner's fanbase increased significantly, and the overlap in social following has grown. These audience bridges, once established, tend to persist beyond the collaboration itself.",
      "From a chart perspective, the collaboration benefited from combined fandom streaming efforts. The track's chart trajectory shows a steeper initial climb than either artist's recent solo releases, though the long-term sustainability of this boost remains to be seen.",
    ],
    closing: [
      "METRIC will track the residual impact of this collaboration on both artists' metrics over the coming weeks. Successful partnerships often create lasting audience growth.",
      "The collaboration data for {artist} aligns with industry patterns for well-matched partnerships. We'll provide a follow-up analysis once longer-term data is available.",
    ],
  },
  variety: {
    opening: [
      "Television appearances and streaming metrics are more connected than many realize. {artist}'s recent variety show appearance provides a useful case study in the data behind cross-media influence.",
      "When {artist} appeared on a major variety show, the effect was measurable across multiple data points. Viewership data, social media activity, and streaming metrics all registered the impact.",
      "{artist}'s television exposure continues to generate quantifiable results. METRIC examines the ratings data and downstream effects on their broader metrics.",
    ],
    analysis: [
      "Ratings data for the episode featuring {artist} showed an uptick compared to the show's recent average. While attributing viewership changes to a single guest requires caution, the correlation is consistent with patterns we've observed for other K-pop guest appearances.",
      "More telling than the ratings themselves is the downstream impact on {artist}'s streaming numbers. In the 48 hours following the broadcast, Spotify and YouTube plays for {artist}'s catalog showed a measurable increase, suggesting that the TV exposure drove new discovery.",
      "Social media data during and after the broadcast showed elevated activity around {artist}-related content. Clip shares of key moments accumulated significant views, extending the reach of the appearance well beyond the live broadcast audience.",
    ],
    closing: [
      "The data confirms that well-placed television appearances remain an effective tool for audience expansion. METRIC will continue tracking the correlation between media exposure and streaming performance for K-pop acts.",
      "METRIC's analysis of {artist}'s variety show impact adds to our growing dataset on cross-media effects. We'll update these findings as post-broadcast streaming data stabilizes.",
    ],
  },
  general: {
    opening: [
      "This week in K-pop data, several notable developments caught METRIC's attention. From streaming trends to chart movements, the numbers tell a story worth examining.",
      "The K-pop landscape is constantly shifting, and this week's data reveals interesting patterns. METRIC has identified key metrics that deserve closer analysis.",
      "METRIC's weekly review of K-pop industry data has flagged several trends worth watching. Here's our breakdown of the most significant numbers this week.",
      "{artist} has been in the news, and the data supports the attention. METRIC examines the relevant metrics and puts them in context.",
    ],
    analysis: [
      "The streaming landscape continues to evolve, with notable shifts in platform market share affecting how K-pop consumption is measured. Cross-platform analysis is increasingly important for getting an accurate picture of any act's real reach.",
      "Industry-wide, K-pop streaming numbers remain on an upward trajectory. However, the distribution of those streams is becoming more concentrated among top acts, creating a widening gap between the top tier and the rest of the market.",
      "Social media metrics across the K-pop industry show continued growth in engagement rates, particularly on TikTok. The platform's algorithmic discovery mechanism continues to be a key driver of new listener acquisition for K-pop acts.",
    ],
    closing: [
      "METRIC's commitment to evidence-based K-pop coverage means we let the numbers lead the narrative. Check back next week for our updated data report.",
      "As always, METRIC will continue tracking these data points and providing analysis grounded in evidence. The numbers don't lie, and they often tell a more complete story than headlines alone.",
    ],
  },
};

const NO_ARTIST_BODY = {
  opening: [
    "The K-pop industry continues to generate impressive numbers across streaming, sales, and social engagement metrics. This week's data roundup highlights the most significant movements in the market.",
    "METRIC's analysis of this week's K-pop data reveals several noteworthy trends. From chart performances to platform metrics, here's what the numbers are saying.",
    "The intersection of data and K-pop fandom produces some of the most fascinating numbers in the entertainment industry. This week is no exception.",
  ],
  analysis: [
    "Streaming volumes across the K-pop category have maintained their upward trajectory this quarter. The aggregate data shows that total K-pop streams on major platforms are trending above year-over-year comparisons, driven by a combination of new releases and catalog discovery.",
    "Chart data from the past week shows increased competition at the top, with several releases vying for the leading positions. The compressed nature of the chart is a signal of market health -- multiple acts are generating meaningful consumption simultaneously.",
    "Social media metrics across the industry continue to evolve as platforms change their algorithms. The most successful K-pop acts this week were those that achieved high engagement rates relative to their follower counts, suggesting that authentic content is outperforming purely promotional material.",
  ],
  closing: [
    "METRIC provides weekly data-driven analysis of the K-pop industry. Our methodology is grounded in publicly available metrics and aims to provide context beyond the headlines.",
    "For more data-driven K-pop analysis, follow METRIC's weekly reports. We let the numbers tell the story.",
  ],
};

const SHARED_PARAGRAPHS = {
  background: [
    "{artist} has been on a sustained growth trajectory that the data makes clear. Year-over-year streaming increases, expanding international market share, and consistently high engagement rates across social platforms all point to an act that is still ascending rather than plateauing.",
    "To contextualize {artist}'s current metrics, it helps to look at the broader K-pop market data. The industry has been experiencing aggregate growth, but {artist}'s numbers have outpaced the market average, suggesting specific factors beyond general market tailwinds.",
    "Historical data on {artist}'s releases reveals a consistent pattern of improvement cycle over cycle. Each successive release has posted higher first-week numbers, suggesting an expanding core audience combined with effective marketing reach into new listener segments.",
    "The K-pop market's competitive landscape provides important context for {artist}'s performance. With more acts releasing more frequently, maintaining or growing chart positions requires genuine audience engagement -- something {artist}'s data consistently demonstrates.",
    "Platform-level data shows that {artist}'s listener demographics have been shifting over time. International listener share has increased, the age distribution has broadened, and the gender balance has shifted closer to equilibrium. These are hallmarks of an act transitioning from niche to mainstream.",
  ],
  detail: [
    "Drilling into the granular data, several metrics stand out. {artist}'s repeat listener rate is notably high, indicating that the music has strong replay value. This metric is often a leading indicator of chart longevity, as it suggests listeners are choosing to come back rather than moving on after initial curiosity.",
    "An analysis of {artist}'s content performance across social platforms reveals that video content significantly outperforms static posts in terms of reach and engagement. This is consistent with broader platform trends, but {artist}'s video engagement rates are above the category average.",
    "The geographical distribution of {artist}'s streams has been diversifying. While domestic Korean streams still represent a significant share, markets in Southeast Asia, North America, and Europe have been growing at a faster rate. This geographic diversification reduces market concentration risk.",
    "When we overlay {artist}'s release timeline with their social media activity cadence, a clear pattern of strategic content scheduling emerges. Peaks in social activity typically precede releases by 7-14 days, creating measurable anticipation as tracked through search volume and social mention frequency.",
    "Music video data for {artist} shows viewer retention rates that compare favorably to industry benchmarks. High retention suggests that the visual content is compelling enough to hold attention, which has downstream effects on algorithmic recommendation across platforms.",
  ],
  reaction: [
    "Fan engagement metrics around this development have been robust. Comment sentiment analysis shows overwhelmingly positive reception, and the ratio of engaged fans (those who liked, shared, or commented) to passive viewers is above the K-pop industry average.",
    "The fan community's response, as measured through social media volume and sentiment, has been significant. Hashtags related to {artist} trended in multiple markets, and the volume of user-generated content exceeded what we typically see for comparable events.",
    "Real-time engagement data during the announcement showed a sharp spike in social media activity across platforms. This kind of synchronized fan response is characteristic of well-organized fandoms, and {artist}'s community is among the most coordinated in the industry.",
    "Global fan response data reveals interesting geographic patterns. While East Asian markets drove the initial surge in engagement, North American and European fan activity followed within hours, creating a rolling wave of social media activity that sustained trending status for an extended period.",
  ],
  impact: [
    "From a market perspective, {artist}'s performance data this cycle sends a clear signal to the industry. The metrics validate the approach their team has taken and set benchmarks that other acts will be measured against in the coming quarters.",
    "The broader industry implications of {artist}'s numbers are worth noting. In an increasingly competitive K-pop landscape, the data shows that quality and consistency can still cut through the noise. {artist}'s sustained performance offers a data-backed case study in effective artist development.",
    "Looking ahead, the trajectory suggested by {artist}'s current data points is positive. If recent growth rates are maintained, several significant milestones are within reach in the coming months. METRIC will continue tracking these projections against actual results.",
  ],
  noArtist: {
    background: [
      "The K-pop industry's growth story is well-supported by data. Total streaming volumes, physical album sales, and concert revenues have all trended upward over the past several years. This week's numbers continue that narrative, with several categories posting above-average figures.",
      "Context matters in data analysis. The K-pop market operates within a broader entertainment ecosystem that is itself evolving. Platform algorithm changes, shifting consumer habits, and market maturation all factor into how we interpret this week's numbers.",
    ],
    detail: [
      "A closer look at the streaming data reveals interesting platform-level differences. Spotify's K-pop category has seen consistent growth, while YouTube Music's share has been particularly strong in Southeast Asian markets. These platform dynamics affect how we assess any individual release's performance.",
      "Physical album sales data, often overlooked in streaming-first analysis, tells an important complementary story. K-pop remains one of the few music genres where physical sales are not just relevant but growing, driven by collector editions and fandom-driven purchasing patterns.",
    ],
    reaction: [
      "Online discourse around this week's K-pop data points has been active. Fan communities have been analyzing the numbers with increasing sophistication, creating their own data visualizations and comparative analyses. This data literacy within fandoms is itself a noteworthy trend.",
    ],
    impact: [
      "This week's data adds to the growing body of evidence that K-pop's global market position is strengthening. The numbers suggest not just growth, but qualitative shifts in how the genre is consumed and perceived in international markets.",
    ],
  },
};

function rewriteArticleBody(articleContent, title) {
  const artist = extractArtist(title) || (articleContent ? extractArtistFromParagraphs(articleContent.paragraphs) : null);
  const topic = classifyTopic(title);

  const originalLength = articleContent?.paragraphs?.length || 0;
  const targetParagraphs = Math.max(8, Math.min(12, originalLength || 8));

  const inlineImages = (articleContent?.images || []).slice(1, 4);

  const paragraphs = [];

  if (artist) {
    const templates = BODY_TEMPLATES[topic] || BODY_TEMPLATES.general;
    const sub = (text) => text.replace(/\{artist\}/g, artist);

    paragraphs.push({ type: 'intro', text: sub(pickRandom(templates.opening)) });

    const bgCount = targetParagraphs >= 10 ? 2 : 1;
    for (const bg of shuffleAndPick(SHARED_PARAGRAPHS.background, bgCount)) {
      paragraphs.push({ type: 'body', text: sub(bg) });
    }

    const analysisCount = targetParagraphs >= 10 ? 3 : 2;
    for (const a of shuffleAndPick(templates.analysis, analysisCount)) {
      paragraphs.push({ type: 'body', text: sub(a) });
    }

    if (inlineImages.length > 0) {
      paragraphs.push({ type: 'image', src: inlineImages[0] });
    }

    const detailCount = targetParagraphs >= 10 ? 2 : 1;
    for (const d of shuffleAndPick(SHARED_PARAGRAPHS.detail, detailCount)) {
      paragraphs.push({ type: 'body', text: sub(d) });
    }

    const reactionCount = targetParagraphs >= 10 ? 2 : 1;
    for (const r of shuffleAndPick(SHARED_PARAGRAPHS.reaction, reactionCount)) {
      paragraphs.push({ type: 'body', text: sub(r) });
    }

    if (inlineImages.length > 1) {
      paragraphs.push({ type: 'image', src: inlineImages[1] });
    }

    paragraphs.push({ type: 'body', text: sub(pickRandom(SHARED_PARAGRAPHS.impact)) });
    paragraphs.push({ type: 'closing', text: sub(pickRandom(templates.closing)) });

  } else {
    paragraphs.push({ type: 'intro', text: pickRandom(NO_ARTIST_BODY.opening) });

    for (const bg of shuffleAndPick(SHARED_PARAGRAPHS.noArtist.background, 2)) {
      paragraphs.push({ type: 'body', text: bg });
    }

    for (const a of shuffleAndPick(NO_ARTIST_BODY.analysis, 2)) {
      paragraphs.push({ type: 'body', text: a });
    }

    if (inlineImages.length > 0) {
      paragraphs.push({ type: 'image', src: inlineImages[0] });
    }

    for (const d of shuffleAndPick(SHARED_PARAGRAPHS.noArtist.detail, 2)) {
      paragraphs.push({ type: 'body', text: d });
    }

    for (const r of shuffleAndPick(SHARED_PARAGRAPHS.noArtist.reaction, 1)) {
      paragraphs.push({ type: 'body', text: r });
    }

    if (inlineImages.length > 1) {
      paragraphs.push({ type: 'image', src: inlineImages[1] });
    }

    paragraphs.push({ type: 'body', text: pickRandom(SHARED_PARAGRAPHS.noArtist.impact) });
    paragraphs.push({ type: 'closing', text: pickRandom(NO_ARTIST_BODY.closing) });
  }

  return { paragraphs };
}

function extractArtistFromParagraphs(paragraphs) {
  if (!paragraphs || paragraphs.length === 0) return null;
  const sample = paragraphs.slice(0, 3).join(' ');
  return extractArtist(sample);
}

function shuffleAndPick(arr, n) {
  const shuffled = [...arr].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, Math.min(n, shuffled.length));
}

// ============================================================
// HTML escaping
// ============================================================

function escapeHtml(str) {
  return (str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ============================================================
// Build image tag helpers
// ============================================================

function imgTag(article, width, height, loading = 'lazy') {
  const src = escapeHtml(article.image || PLACEHOLDER_IMAGE);
  const fallback = `https://picsum.photos/seed/${encodeURIComponent(article.title.slice(0, 20))}/${width}/${height}`;
  return `<img src="${src}" alt="${escapeHtml(article.title)}" width="${width}" height="${height}" loading="${loading}" referrerpolicy="no-referrer" data-fallback="${escapeHtml(fallback)}" onerror="if(!this.dataset.failed){this.dataset.failed='1';this.src=this.dataset.fallback}">`;
}

function imgTagForArticle(article, width, height, loading = 'lazy') {
  let src = article.image || PLACEHOLDER_IMAGE;
  if (src.startsWith('images/')) src = '../' + src;
  const escapedSrc = escapeHtml(src);
  const fallback = `https://picsum.photos/seed/${encodeURIComponent(article.title.slice(0, 20))}/${width}/${height}`;
  return `<img src="${escapedSrc}" alt="${escapeHtml(article.title)}" width="${width}" height="${height}" loading="${loading}" referrerpolicy="no-referrer" data-fallback="${escapeHtml(fallback)}" onerror="if(!this.dataset.failed){this.dataset.failed='1';this.src=this.dataset.fallback}">`;
}

// ============================================================
// Section generators for index page
// ============================================================

function generateHeroCard(article) {
  if (!article) return '';
  const cat = displayCategoryFromTitle(article.originalTitle || article.title);
  const stat = generateFakeStat();
  return `<a href="${escapeHtml(article.localUrl)}" class="hero">
        <div class="hero-img">
          ${imgTag(article, 760, 570, 'eager')}
        </div>
        <div class="hero-body">
          <div class="hero-cat">${escapeHtml(cat)}</div>
          <div class="hero-stat">${stat}</div>
          <div class="hero-title">${escapeHtml(article.title)}</div>
          <div class="hero-meta">
            <span>${escapeHtml(article.formattedDate)}</span>
            <span>Source: ${escapeHtml(article.source)}</span>
          </div>
        </div>
      </a>`;
}

function generateFakeStat() {
  const stats = [
    '47.2M', '1.8B', '312K', '94.7%', '#1', '2.4M', '156K', '88.3%',
    '521K', '3.7M', '12.4M', '67.8%', '4.1B', '238K', '91.2%',
  ];
  return pickRandom(stats);
}

function generateDataSnapshot(article) {
  if (!article) return '';
  const stat = generateFakeStat();
  const isUp = Math.random() > 0.3;
  const trendPct = (Math.random() * 25 + 2).toFixed(1);
  const cat = displayCategoryFromTitle(article.originalTitle || article.title);
  return `<div class="snap">
          <div class="snap-label">${escapeHtml(cat)}</div>
          <div class="snap-val">${stat}</div>
          <div class="snap-trend ${isUp ? 'up' : 'down'}">${isUp ? '+' : '-'}${trendPct}%</div>
        </div>`;
}

function generateAnalysisCard(article) {
  if (!article) return '';
  const cat = displayCategoryFromTitle(article.originalTitle || article.title);
  const readMins = Math.floor(Math.random() * 8) + 4;
  return `<a href="${escapeHtml(article.localUrl)}" class="analysis-item">
          <div class="analysis-thumb">
            ${imgTag(article, 80, 52)}
          </div>
          <div class="analysis-info">
            <div class="analysis-cat">${escapeHtml(cat)}</div>
            <div class="analysis-title">${escapeHtml(article.title)}</div>
            <div class="analysis-meta">${escapeHtml(article.formattedDate)} &middot; ${escapeHtml(article.source)}</div>
          </div>
          <div class="analysis-read">${readMins} min</div>
        </a>`;
}

function generateChartItem(article, rank) {
  if (!article) return '';
  const rankClass = rank <= 3 ? 'ct-rank top' : 'ct-rank';
  const changeTypes = ['up', 'up', 'up', 'down', 'same'];
  const changeType = pickRandom(changeTypes);
  const changeVal = Math.floor(Math.random() * 5) + 1;
  const changeIcon = changeType === 'up' ? `+${changeVal}` : changeType === 'down' ? `-${changeVal}` : '--';
  const cat = displayCategoryFromTitle(article.originalTitle || article.title);
  return `<tr>
          <td class="${rankClass}">${String(rank).padStart(2, '0')}</td>
          <td class="ct-chg ${changeType}">${changeIcon}</td>
          <td><div class="ct-thumb">${imgTag(article, 40, 40)}</div></td>
          <td><a href="${escapeHtml(article.localUrl)}"><div class="ct-title">${escapeHtml(article.title)}</div><div class="ct-meta">${escapeHtml(cat)}</div></a></td>
          <td style="font-size:11px;color:#999;white-space:nowrap">${escapeHtml(article.formattedDate)}</td>
        </tr>`;
}

function generateDeepDiveMain(article) {
  if (!article) return '';
  const readMins = Math.floor(Math.random() * 10) + 8;
  return `<a href="${escapeHtml(article.localUrl)}" class="deep-main">
          <div class="deep-main-img">
            ${imgTag(article, 760, 380)}
          </div>
          <div class="deep-main-body">
            <div class="deep-tag">DEEP DIVE</div>
            <div class="deep-title">${escapeHtml(article.title)}</div>
            <div class="deep-read">${readMins} min read</div>
          </div>
        </a>`;
}

function generateDeepDiveSide(article) {
  if (!article) return '';
  const readMins = Math.floor(Math.random() * 8) + 5;
  const cat = displayCategoryFromTitle(article.originalTitle || article.title);
  return `<a href="${escapeHtml(article.localUrl)}" class="deep-side">
          <div class="deep-tag">${escapeHtml(cat)}</div>
          <div class="deep-title">${escapeHtml(article.title)}</div>
          <div class="deep-read">${readMins} min read</div>
        </a>`;
}

// ============================================================
// Backdate articles -- Jan 1 to Mar 22, 2026
// ============================================================

function backdateArticles(articles) {
  const startDate = new Date(2026, 0, 1); // Jan 1, 2026
  const endDate = new Date(2026, 2, 22);  // Mar 22, 2026
  const totalDays = Math.floor((endDate - startDate) / (1000 * 60 * 60 * 24));

  for (let i = 0; i < articles.length; i++) {
    const daysAgo = Math.floor((i / articles.length) * totalDays);
    const d = new Date(endDate);
    d.setDate(d.getDate() - daysAgo);
    // Add some randomness to the hours
    d.setHours(Math.floor(Math.random() * 14) + 8);
    d.setMinutes(Math.floor(Math.random() * 60));
    articles[i].pubDate = d;
    articles[i].formattedDate = formatDateObj(d);
  }
}

// ============================================================
// Generate article HTML pages
// ============================================================

async function generateArticlePages(allArticles, usedArticles) {
  await mkdir(ARTICLES_DIR, { recursive: true });

  const templatePath = join(__dirname, 'article-template.html');
  const articleTemplate = await readFile(templatePath, 'utf-8');

  log(`Generating ${usedArticles.length} article pages...`);

  // Pre-assign localUrl
  for (let i = 0; i < usedArticles.length; i++) {
    const filename = `article-${String(i + 1).padStart(3, '0')}.html`;
    usedArticles[i].localUrl = `articles/${filename}`;
  }

  let generated = 0;

  for (let i = 0; i < usedArticles.length; i++) {
    const article = usedArticles[i];
    const filename = `article-${String(i + 1).padStart(3, '0')}.html`;

    const related = allArticles
      .filter(a => a !== article && a.image && a.localUrl)
      .slice(0, 20)
      .sort(() => Math.random() - 0.5)
      .slice(0, 3);

    const bodyData = rewriteArticleBody(article.articleContent, article.title);

    let bodyHtml = '';
    for (const item of bodyData.paragraphs) {
      if (item.type === 'intro') {
        bodyHtml += `<div class="editorial-intro">${escapeHtml(item.text)}</div>\n`;
      } else if (item.type === 'closing') {
        bodyHtml += `        <div class="editorial-closing">${escapeHtml(item.text)}</div>`;
      } else if (item.type === 'image') {
        const imgSrc = item.src;
        const fallback = `https://picsum.photos/seed/inline-${Math.random().toString(36).slice(2,8)}/760/428`;
        bodyHtml += `        <figure class="article-inline-image">
          <img src="${escapeHtml(imgSrc)}" alt="" width="760" height="428" loading="lazy" decoding="async" referrerpolicy="no-referrer" data-fallback="${escapeHtml(fallback)}" onerror="if(!this.dataset.failed){this.dataset.failed='1';this.src=this.dataset.fallback}">
        </figure>\n`;
      } else {
        bodyHtml += `        <p>${escapeHtml(item.text)}</p>\n`;
      }
    }

    let heroImgSrc = article.image || PLACEHOLDER_IMAGE;
    if (heroImgSrc.startsWith('images/')) heroImgSrc = '../' + heroImgSrc;
    const heroFallback = `https://picsum.photos/seed/${encodeURIComponent(article.title.slice(0, 20))}/800/450`;
    const heroImg = `<img src="${escapeHtml(heroImgSrc)}" alt="${escapeHtml(article.title)}" width="760" height="428" loading="eager" referrerpolicy="no-referrer" data-fallback="${escapeHtml(heroFallback)}" onerror="if(!this.dataset.failed){this.dataset.failed='1';this.src=this.dataset.fallback}">`;

    let relatedHtml = '';
    for (const rel of related) {
      const relUrl = `../${rel.localUrl}`;
      let relImgSrc = rel.image || PLACEHOLDER_IMAGE;
      if (relImgSrc.startsWith('images/')) relImgSrc = '../' + relImgSrc;
      const relFallback = `https://picsum.photos/seed/${encodeURIComponent(rel.title.slice(0, 20))}/400/225`;
      const relCat = displayCategoryFromTitle(rel.originalTitle || rel.title);
      relatedHtml += `
          <a href="${escapeHtml(relUrl)}" class="related-card">
            <div class="thumb">
              <img src="${escapeHtml(relImgSrc)}" alt="${escapeHtml(rel.title)}" width="400" height="225" loading="lazy" referrerpolicy="no-referrer" data-fallback="${escapeHtml(relFallback)}" onerror="if(!this.dataset.failed){this.dataset.failed='1';this.src=this.dataset.fallback}">
            </div>
            <div class="related-body">
              <div class="related-category">${escapeHtml(relCat)}</div>
              <h3>${escapeHtml(rel.title)}</h3>
              <span class="date">${escapeHtml(rel.formattedDate)}</span>
            </div>
          </a>`;
    }

    const articleCat = displayCategoryFromTitle(article.originalTitle || article.title);

    const sourceAttribution = `<div class="source-attribution" style="max-width:720px;margin:40px auto 0;padding:20px 24px;">
          Source: <a href="${escapeHtml(article.link)}" target="_blank" rel="noopener noreferrer">${escapeHtml(article.source)}</a>
          <br><a href="${escapeHtml(article.link)}" target="_blank" rel="noopener noreferrer" class="read-original">Read original article &rarr;</a>
        </div>`;

    const photoCredit = `Photo: &copy;${escapeHtml(article.source)}`;

    let html = articleTemplate
      .replace(/\{\{ARTICLE_TITLE\}\}/g, escapeHtml(article.title))
      .replace('{{ARTICLE_DESCRIPTION}}', escapeHtml(article.title).slice(0, 160))
      .replace('{{ARTICLE_IMAGE}}', escapeHtml(heroImgSrc))
      .replace('{{ARTICLE_CATEGORY}}', escapeHtml(articleCat))
      .replace('{{ARTICLE_DATE}}', escapeHtml(article.formattedDate))
      .replace('{{ARTICLE_HERO_IMAGE}}', heroImg)
      .replace('{{ARTICLE_BODY}}', bodyHtml)
      .replace('{{SOURCE_ATTRIBUTION}}', sourceAttribution)
      .replace('{{PHOTO_CREDIT}}', photoCredit)
      .replace('{{RELATED_ARTICLES}}', relatedHtml);

    const outputPath = join(ARTICLES_DIR, filename);
    await writeFile(outputPath, html, 'utf-8');
    generated++;
  }

  log(`  Generated ${generated} article pages`);
}

// ============================================================
// Assign articles to sections
// ============================================================

const HERO_OFFSET = 3;

function assignSections(articles) {
  let placeholderIdx = 0;
  for (const article of articles) {
    if (!article.image) {
      placeholderIdx++;
      article.image = `https://picsum.photos/seed/metric-${placeholderIdx}-${Date.now() % 10000}/800/450`;
      article.hasPlaceholder = true;
    }
  }

  const withRealImages = articles.filter(a => !a.hasPlaceholder);
  const all = [...articles];
  const used = new Set();

  const take = (pool, count) => {
    const result = [];
    for (const article of pool) {
      if (result.length >= count) break;
      if (!used.has(article.link)) {
        result.push(article);
        used.add(article.link);
      }
    }
    return result;
  };

  const heroCandidates = withRealImages.length >= 2 ? withRealImages : all;
  const heroSkipped = heroCandidates.slice(HERO_OFFSET);
  const hero = take(heroSkipped.length ? heroSkipped : heroCandidates, 1);
  const snapshots = take(all, 4);
  const latest = take(all, 5);
  const chart = take(all, 5);
  const deep = take(all, 3);

  return {
    hero: hero[0] || null,
    snapshots,
    latest,
    chart,
    deep,
  };
}

// ============================================================
// Generate index HTML
// ============================================================

async function generateHtml(sections) {
  const templatePath = join(__dirname, 'template.html');
  let template = await readFile(templatePath, 'utf-8');

  template = template.replace(
    '{{HERO_CARD}}',
    sections.hero ? generateHeroCard(sections.hero) : ''
  );

  template = template.replace(
    '{{DATA_SNAPSHOTS}}',
    sections.snapshots.map(a => generateDataSnapshot(a)).join('\n      ')
  );

  template = template.replace(
    '{{LATEST_ANALYSIS}}',
    sections.latest.map(a => generateAnalysisCard(a)).join('\n      ')
  );

  template = template.replace(
    '{{CHART_WATCH}}',
    sections.chart.map((a, i) => generateChartItem(a, i + 1)).join('\n      ')
  );

  // Deep Dives: first is main, rest are sidebar
  const deepMain = sections.deep[0] ? generateDeepDiveMain(sections.deep[0]) : '';
  const deepSide = sections.deep.slice(1).map(a => generateDeepDiveSide(a)).join('\n        ');
  template = template.replace(
    '{{DEEP_DIVES}}',
    `${deepMain}
      <div class="deep-sidebar">
        ${deepSide}
      </div>`
  );

  return template;
}

// ============================================================
// Main
// ============================================================

async function main() {
  log('Starting METRIC Magazine RSS Crawler...');
  log('');

  // 1. Fetch all RSS feeds
  const articles = await fetchAllFeeds();
  if (articles.length === 0) {
    warn('No articles fetched. Aborting.');
    process.exit(1);
  }
  log('');

  // 2. Fill missing images via og:image
  await fillMissingImages(articles);
  log('');

  // 3. Rewrite ALL titles to data-analytics English
  log('Rewriting titles to METRIC analytical style...');
  let rewritten = 0;
  for (const article of articles) {
    const original = article.title;
    article.originalTitle = original;
    article.title = rewriteTitle(original);
    if (article.title !== original) rewritten++;
  }
  log(`  Rewritten ${rewritten}/${articles.length} titles`);
  log('');

  // 4. Backdate articles from Jan 1 to Mar 22, 2026
  backdateArticles(articles);
  log('Backdated articles from January 1 to March 22, 2026');
  log('');

  // 5. Assign articles to sections
  const sections = assignSections(articles);

  // Collect all used articles
  const usedArticles = [];
  const usedSet = new Set();
  const addUsed = (arr) => {
    for (const a of arr) {
      if (a && !usedSet.has(a.link)) {
        usedArticles.push(a);
        usedSet.add(a.link);
      }
    }
  };
  if (sections.hero) addUsed([sections.hero]);
  addUsed(sections.snapshots);
  addUsed(sections.latest);
  addUsed(sections.chart);
  addUsed(sections.deep);

  // 6. Download images locally
  const withImages = articles.filter(a => a.image).length;
  log(`Articles with images: ${withImages}/${articles.length}`);
  await downloadArticleImages(usedArticles);
  log('');

  // 7. Fetch full article content
  await fetchAllArticleContent(usedArticles);
  log('');

  // 8. Generate individual article pages
  await generateArticlePages(articles, usedArticles);
  log('');

  // 9. Generate index HTML from template
  const html = await generateHtml(sections);

  // 10. Write index output
  const outputPath = join(__dirname, 'index.html');
  await writeFile(outputPath, html, 'utf-8');

  const totalUsed =
    (sections.hero ? 1 : 0) +
    sections.snapshots.length +
    sections.latest.length +
    sections.chart.length +
    sections.deep.length;

  log(`Generated index.html with ${totalUsed} articles`);
  log(`Generated ${usedArticles.length} article pages in articles/`);
  log(`Done! Open: file://${outputPath}`);
}

main().catch((err) => {
  console.error('[METRIC Crawler] Fatal error:', err);
  process.exit(1);
});
