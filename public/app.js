'use strict';

/* ==================================================================
   스팀 찜 목록 카드 메이커
   미리보기로 보이는 <canvas>가 그대로 저장 결과물이다. DOM으로 한 번
   그리고 캔버스로 또 그리면 둘이 어긋나므로, 처음부터 캔버스 하나만 그린다.
   ================================================================== */

const FONT = '"Pretendard", "Malgun Gothic", "Apple SD Gothic Neo", system-ui, sans-serif';

// 전체 판과 카드 한 장의 치수(1배 기준, px)
const L = {
  pad: 40,
  gap: 12,
  cardW: 300,
  cardRadius: 8,
  bandH: 24,          // 카드 맨 아래 색 띠
  cardPadX: 12,
  titleSize: 14,
  metaSize: 12,
  profileH: 104,
  statsH: 74,
  sectionH: 42,
  footerH: 40,
  avatar: 68,
};
L.imageH = Math.round((L.cardW * 215) / 460); // 스팀 헤더 이미지 비율 460×215
L.cardH = L.imageH + L.bandH;

const THEMES = {
  light: {
    page: '#ffffff',
    sub: '#f4f5f7',
    line: '#e6e8ec',
    text: '#14181d',
    muted: '#8b929c',
    accent: '#1b7ac4',
  },
  dark: {
    page: '#12161c',
    sub: '#1a2029',
    line: '#2a323d',
    text: '#eef2f7',
    muted: '#8794a4',
    accent: '#66c0f4',
  },
  paper: {
    page: '#f6f3ec',
    sub: '#efeae0',
    line: '#e0d9cb',
    text: '#241f18',
    muted: '#8d8577',
    accent: '#b06a2c',
  },
};

/* ── 요소 ─────────────────────────────────────────────── */

const $ = (id) => document.getElementById(id);
const el = {
  link: $('link'), load: $('load'), status: $('status'), filterNote: $('filterNote'),
  options: $('options'), pickerBlock: $('pickerBlock'), picker: $('picker'),
  pickCount: $('pickCount'), pickAll: $('pickAll'), pickNone: $('pickNone'),
  columns: $('columns'), columnsValue: $('columnsValue'), sort: $('sort'), theme: $('theme'),
  showHeader: $('showHeader'), showAvatar: $('showAvatar'), showName: $('showName'),
  showDate: $('showDate'), showRelease: $('showRelease'),
  title: $('title'), scale: $('scale'), format: $('format'), save: $('save'), sizeInfo: $('sizeInfo'),
  board: $('board'), empty: $('empty'),
  perPage: $('perPage'), pager: $('pager'), pageLabel: $('pageLabel'),
  prevPage: $('prevPage'), nextPage: $('nextPage'),
};

/* ── 상태 ─────────────────────────────────────────────── */

let wishlist = null;              // 서버에서 받은 원본
let excluded = new Set();         // 제외한 appid
const imageCache = new Map();     // url -> Promise<HTMLImageElement|null>
const colorCache = new Map();     // url -> {r,g,b}
let renderToken = 0;
let currentPage = 0;
let pageCount = 1;

/* ── 유틸 ─────────────────────────────────────────────── */

function setStatus(message, isError) {
  el.status.hidden = !message;
  el.status.textContent = message || '';
  el.status.classList.toggle('error', !!isError);
}

function formatDate(unixSeconds) {
  if (!unixSeconds) return '';
  const d = new Date(unixSeconds * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '.' + pad(d.getMonth() + 1) + '.' + pad(d.getDate());
}

// 스팀 이미지는 서버를 거쳐 같은 출처로 받아야 캔버스를 저장할 수 있다.
function proxied(url) {
  return '/api/image?u=' + encodeURIComponent(url);
}

// 이미지 한 장이 곧 서버 요청 한 번이다. 찜한 게임이 40개면 브라우저는 40개를
// 동시에 요청하는데, 서버가 그만큼 못 받아서 대부분이 거절당한다(429).
// 그래서 한 번에 몇 개까지만 요청하고, 거절당하면 잠시 뒤 다시 시도한다.
const IMAGE_CONCURRENCY = 4;
const IMAGE_RETRIES = 3;

let activeLoads = 0;
const loadQueue = [];

function pumpQueue() {
  while (activeLoads < IMAGE_CONCURRENCY && loadQueue.length) {
    const run = loadQueue.shift();
    activeLoads += 1;
    run().finally(() => {
      activeLoads -= 1;
      pumpQueue();
    });
  }
}

function enqueue(task) {
  return new Promise((resolve) => {
    loadQueue.push(() => task().then(resolve));
    pumpQueue();
  });
}

function fetchImage(url, attempt) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => {
      if (attempt >= IMAGE_RETRIES) {
        resolve(null);
        return;
      }
      // 몰려서 거절당한 것일 수 있으니 점점 더 기다렸다가 다시 시도한다.
      setTimeout(() => fetchImage(url, attempt + 1).then(resolve), 300 * Math.pow(2, attempt));
    };
    img.src = proxied(url);
  });
}

// 찜한 게임이 1,600개면 이미지를 전부 붙들고 있을 수 없다(수백 MB가 된다).
// 최근에 쓴 것만 남기고 나머지는 놓아줘서 브라우저가 메모리를 회수하게 한다.
// 다시 필요해지면 브라우저·CDN 캐시에서 곧바로 온다.
const IMAGE_CACHE_MAX = 160;

function loadImage(url) {
  if (!url) return Promise.resolve(null);

  if (imageCache.has(url)) {
    const kept = imageCache.get(url);
    imageCache.delete(url);
    imageCache.set(url, kept);     // 최근 사용으로 올려둔다
    return kept;
  }

  const promise = enqueue(() => fetchImage(url, 0));
  imageCache.set(url, promise);
  while (imageCache.size > IMAGE_CACHE_MAX) {
    imageCache.delete(imageCache.keys().next().value);
  }
  return promise;
}

/* ── 대표색 뽑기 ──────────────────────────────────────── */

// 카드 색을 게임 이미지에서 가져온다. 파란 아트는 파란 카드, 붉은 아트는 붉은 카드가
// 되어 목록 전체가 한눈에 알록달록해진다.
const sampler = document.createElement('canvas');
sampler.width = 24;
sampler.height = 12;
const samplerCtx = sampler.getContext('2d', { willReadFrequently: true });

function dominantColor(img, key) {
  if (colorCache.has(key)) return colorCache.get(key);

  let color = { r: 90, g: 100, b: 120 };
  try {
    samplerCtx.clearRect(0, 0, sampler.width, sampler.height);
    samplerCtx.drawImage(img, 0, 0, sampler.width, sampler.height);
    const data = samplerCtx.getImageData(0, 0, sampler.width, sampler.height).data;

    // 단순 평균을 내면 잿빛이 되기 쉬워서, 채도가 있는 픽셀에 가중치를 준다.
    let wr = 0, wg = 0, wb = 0, total = 0;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const weight = 1 + (max - min) / 32;   // 선명한 색일수록 크게 반영
      wr += r * weight; wg += g * weight; wb += b * weight; total += weight;
    }
    if (total > 0) color = { r: wr / total, g: wg / total, b: wb / total };
  } catch {
    // 이미지를 읽을 수 없으면 기본색을 쓴다.
  }

  const adjusted = normalizeColor(color);
  colorCache.set(key, adjusted);
  return adjusted;
}

// 너무 어둡거나 너무 흐린 색은 카드로 쓰기 어려우니 밝기와 선명도를 손본다.
function normalizeColor(c) {
  const hsl = rgbToHsl(c.r, c.g, c.b);
  hsl.s = Math.min(0.8, Math.max(0.45, hsl.s * 1.7));
  hsl.l = Math.min(0.5, Math.max(0.32, hsl.l));
  return hslToRgb(hsl.h, hsl.s, hsl.l);
}

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0, s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  return { h, s, l };
}

function hslToRgb(h, s, l) {
  const f = (n) => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return { r: f(0), g: f(8), b: f(4) };
}

function rgba(c, alpha) {
  return 'rgba(' + Math.round(c.r) + ',' + Math.round(c.g) + ',' + Math.round(c.b) + ',' + alpha + ')';
}

function shade(c, amount) {
  const mix = amount < 0 ? 0 : 255;
  const t = Math.abs(amount);
  return {
    r: c.r + (mix - c.r) * t,
    g: c.g + (mix - c.g) * t,
    b: c.b + (mix - c.b) * t,
  };
}

/* ── 캔버스 그리기 도우미 ─────────────────────────────── */

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// 비율을 유지하며 영역을 가득 채우도록(cover) 그린다.
function drawCover(ctx, img, x, y, w, h) {
  const scale = Math.max(w / img.width, h / img.height);
  const dw = img.width * scale;
  const dh = img.height * scale;
  ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
}

function fitCount(ctx, text, maxWidth) {
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (ctx.measureText(text.slice(0, mid)).width <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return Math.max(1, lo);
}

function ellipsize(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  const chars = Array.from(text);
  while (chars.length > 1 && ctx.measureText(chars.join('') + '…').width > maxWidth) chars.pop();
  return chars.join('') + '…';
}

/* ── 옵션 읽기 / 데이터 정렬 ──────────────────────────── */

function readOptions() {
  return {
    columns: Number(el.columns.value),
    sort: el.sort.value,
    theme: THEMES[el.theme.value] || THEMES.light,
    showHeader: el.showHeader.checked,
    showAvatar: el.showAvatar.checked,
    showName: el.showName.checked,
    showDate: el.showDate.checked,
    showRelease: el.showRelease.checked,
    title: el.title.value.trim(),
    scale: Number(el.scale.value),
    perPage: Number(el.perPage.value),
  };
}

function visibleItems(options) {
  const items = wishlist.items.filter((it) => !excluded.has(it.appid));
  const sorters = {
    'added-desc': (a, b) => b.dateAdded - a.dateAdded,
    'added-asc': (a, b) => a.dateAdded - b.dateAdded,
    priority: (a, b) => (a.priority || 9999) - (b.priority || 9999) || b.dateAdded - a.dateAdded,
    name: (a, b) => a.name.localeCompare(b.name, 'ko'),
  };
  return items.slice().sort(sorters[options.sort] || sorters['added-desc']);
}

/* ── 그리기 ───────────────────────────────────────────── */

/* ── 여러 장으로 나누기 ───────────────────────────────── */

// 캔버스는 무한정 커질 수 없다. 크롬은 한 변 65,535px, 전체 넓이 약 2억 6천만 px가
// 한계라 찜한 게임이 수백 개만 넘어가도 한 장에 담기지 않는다. 한계보다 넉넉히
// 낮은 선을 잡고, 넘치면 여러 장으로 나눈다.
const MAX_CANVAS_SIDE = 30000;
const MAX_CANVAS_AREA = 110000000;

function boardWidth(columns) {
  return L.pad * 2 + columns * L.cardW + (columns - 1) * L.gap;
}

// 프로필·통계·제목은 첫 장에만 넣는다. 둘째 장부터는 카드만 이어진다.
function chromeHeight(options, isFirstPage) {
  if (!isFirstPage) return L.pad * 2;
  return (options.showHeader ? L.profileH + L.statsH + L.footerH : 0) + L.sectionH + L.pad * 2;
}

// 한 장에 몇 개까지 담을 수 있는지 계산한다.
function itemsPerPage(options, columns) {
  const canvasW = boardWidth(columns) * options.scale;
  const limitH = Math.min(MAX_CANVAS_SIDE, MAX_CANVAS_AREA / canvasW) / options.scale;
  // 상단 정보가 붙는 첫 장이 가장 빡빡하므로 그 기준으로 잡고 모든 장에 같은 수를 담는다.
  const usable = limitH - chromeHeight(options, true);

  let rows = Math.max(1, Math.floor((usable + L.gap) / (L.cardH + L.gap)));
  if (options.perPage > 0) rows = Math.min(rows, Math.max(1, Math.ceil(options.perPage / columns)));
  return rows * columns;
}

function updatePager() {
  el.pager.hidden = pageCount <= 1;
  el.pageLabel.textContent = (currentPage + 1) + ' / ' + pageCount;
  el.prevPage.disabled = currentPage === 0;
  el.nextPage.disabled = currentPage >= pageCount - 1;
  el.save.lastChild.textContent = pageCount > 1 ? ' 다운로드 (' + pageCount + '장 zip)' : ' 다운로드';
}

async function render() {
  if (!wishlist) return;
  const token = ++renderToken;

  const options = readOptions();
  const all = visibleItems(options);
  const columns = Math.max(1, options.columns);

  // 한 장에 안 들어가면 여러 장으로 나눈다.
  const perPage = itemsPerPage(options, columns);
  pageCount = Math.max(1, Math.ceil(all.length / perPage));
  if (currentPage > pageCount - 1) currentPage = pageCount - 1;
  const items = all.slice(currentPage * perPage, (currentPage + 1) * perPage);
  updatePager();

  const isFirstPage = currentPage === 0;
  const rows = Math.max(1, Math.ceil(items.length / columns));
  const boardW = boardWidth(columns);
  const gridH = items.length ? rows * L.cardH + (rows - 1) * L.gap : 0;
  const boardH = chromeHeight(options, isFirstPage) + gridH;

  const avatar = isFirstPage && options.showHeader && options.showAvatar &&
    wishlist.profile && wishlist.profile.avatar
    ? await loadImage(wishlist.profile.avatar)
    : null;
  if (token !== renderToken) return; // 그 사이 설정이 또 바뀌었다면 이 그리기는 버린다

  const scale = options.scale;
  const canvas = el.board;
  canvas.width = Math.round(boardW * scale);
  canvas.height = Math.round(boardH * scale);
  canvas.style.width = boardW + 'px';

  const ctx = canvas.getContext('2d');
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';

  const t = options.theme;
  ctx.fillStyle = t.page;
  ctx.fillRect(0, 0, boardW, boardH);

  let y = L.pad;

  // 첫 장에만 프로필·통계·제목을 넣는다. 둘째 장부터는 카드만.
  if (isFirstPage) {
    if (options.showHeader) {
      drawProfile(ctx, options, avatar, boardW, y);
      y += L.profileH;
      drawStats(ctx, options, all, boardW, y);
      y += L.statsH;
    }
    drawSectionHeader(ctx, options, all, boardW, y);
    y += L.sectionH;
  }

  el.empty.hidden = true;
  canvas.hidden = false;

  // 이미지를 전부 받아놓고 시작하면 수백 MB를 붙들게 되고 기다림도 길다.
  // 조금 앞서 받아두면서 받는 대로 그려 나간다.
  const PREFETCH = 8;
  const pending = new Map();
  const prefetch = (i) => {
    if (i < items.length && !pending.has(i)) pending.set(i, loadImage(items[i].image));
  };

  for (let index = 0; index < items.length; index += 1) {
    for (let k = index; k < index + PREFETCH; k += 1) prefetch(k);

    const cover = await pending.get(index);
    pending.delete(index);
    if (token !== renderToken) return;

    drawCard(
      ctx, options, items[index], cover,
      L.pad + (index % columns) * (L.cardW + L.gap),
      y + Math.floor(index / columns) * (L.cardH + L.gap),
    );

    if (index % 25 === 0 || index === items.length - 1) {
      setSizeInfo(canvas, items.length, all.length, index + 1);
    }
  }

  if (isFirstPage && options.showHeader) drawFooter(ctx, options, boardW, boardH);
  setSizeInfo(canvas, items.length, all.length, items.length);
}

function setSizeInfo(canvas, pageItems, totalItems, drawn) {
  const size = canvas.width.toLocaleString() + ' × ' + canvas.height.toLocaleString() + ' px';
  const progress = drawn < pageItems ? ' · 그리는 중 ' + drawn + '/' + pageItems : '';
  const paged = pageCount > 1
    ? ' · ' + (currentPage + 1) + '장째 ' + pageItems + '개 (전체 ' + totalItems + '개)'
    : ' · 게임 ' + totalItems + '개';
  el.sizeInfo.textContent = size + paged + progress;
}

/* ── 프로필 ──────────────────────────────────────────── */

function drawProfile(ctx, options, avatar, boardW, top) {
  const t = options.theme;
  const nickname = options.showName ? ((wishlist.profile && wishlist.profile.name) || '') : '';
  let x = L.pad;
  const blockTop = top + 8;

  if (avatar) {
    ctx.save();
    roundRect(ctx, x, blockTop, L.avatar, L.avatar, 14);
    ctx.clip();
    drawCover(ctx, avatar, x, blockTop, L.avatar, L.avatar);
    ctx.restore();
    x += L.avatar + 18;
  }

  ctx.fillStyle = t.muted;
  ctx.font = '400 13px ' + FONT;
  ctx.fillText(formatDate(Date.now() / 1000) + ' 기준 · 스팀 찜 목록', x, blockTop + 18);

  // 이름은 글자 사이를 벌려서 크게
  const heading = options.title || nickname || '스팀 찜 목록';
  ctx.fillStyle = t.text;
  ctx.font = '800 30px ' + FONT;
  drawSpaced(ctx, ellipsize(ctx, heading, boardW - x - L.pad), x, blockTop + 55, 5);
}

// 글자 사이를 일정하게 벌려 그린다.
function drawSpaced(ctx, text, x, y, spacing) {
  let cursor = x;
  for (const ch of Array.from(text)) {
    ctx.fillText(ch, cursor, y);
    cursor += ctx.measureText(ch).width + spacing;
  }
}

/* ── 통계 ────────────────────────────────────────────── */

function drawStats(ctx, options, items, boardW, top) {
  const t = options.theme;
  const dates = items.map((i) => i.dateAdded).filter(Boolean).sort((a, b) => a - b);
  const upcoming = items.filter((i) => i.comingSoon).length;

  const cells = [
    { label: '찜한 게임', value: String(items.length), note: '개' },
    { label: '가장 오래된 찜', value: formatDate(dates[0]) || '-' },
    { label: '가장 최근 찜', value: formatDate(dates[dates.length - 1]) || '-' },
    { label: '출시 예정', value: String(upcoming), note: '개', highlight: upcoming > 0 },
  ];

  const innerW = boardW - L.pad * 2;
  const cellW = innerW / cells.length;
  const baseY = top + 6;

  ctx.strokeStyle = t.line;
  ctx.lineWidth = 1;

  cells.forEach((cell, i) => {
    const x = L.pad + i * cellW;
    if (i > 0) {
      ctx.beginPath();
      ctx.moveTo(x - 0.5, baseY + 6);
      ctx.lineTo(x - 0.5, baseY + 50);
      ctx.stroke();
    }
    const textX = x + (i === 0 ? 0 : 18);

    ctx.fillStyle = t.muted;
    ctx.font = '400 12px ' + FONT;
    ctx.fillText(cell.label, textX, baseY + 20);

    ctx.fillStyle = cell.highlight ? t.accent : t.text;
    ctx.font = '700 21px ' + FONT;
    ctx.fillText(cell.value, textX, baseY + 46);

    if (cell.note) {
      const w = ctx.measureText(cell.value).width;
      ctx.fillStyle = t.muted;
      ctx.font = '400 13px ' + FONT;
      ctx.fillText(cell.note, textX + w + 4, baseY + 46);
    }
  });

  ctx.beginPath();
  ctx.moveTo(L.pad, top + L.statsH - 6.5);
  ctx.lineTo(boardW - L.pad, top + L.statsH - 6.5);
  ctx.stroke();
}

/* ── 섹션 제목 ───────────────────────────────────────── */

function drawSectionHeader(ctx, options, items, boardW, top) {
  const t = options.theme;
  const dates = items.map((i) => i.dateAdded).filter(Boolean).sort((a, b) => a - b);
  const y = top + 22;

  ctx.fillStyle = t.text;
  ctx.font = '800 19px ' + FONT;
  ctx.fillText('WISHLIST', L.pad, y);

  if (dates.length) {
    ctx.fillStyle = t.muted;
    ctx.font = '400 12.5px ' + FONT;
    ctx.textAlign = 'right';
    const span = formatDate(dates[0]) + ' ~ ' + formatDate(dates[dates.length - 1]);
    ctx.fillText(items.length + '개 [' + span + ']', boardW - L.pad, y);
    ctx.textAlign = 'left';
  }
}

function drawFooter(ctx, options, boardW, boardH) {
  const t = options.theme;
  const y = boardH - L.pad + 14;

  ctx.strokeStyle = t.line;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(L.pad, y - 18);
  ctx.lineTo(boardW - L.pad, y - 18);
  ctx.stroke();

  ctx.font = '400 12px ' + FONT;
  ctx.fillStyle = t.muted;
  ctx.fillText('wishlist.quest', L.pad, y);
  ctx.textAlign = 'right';
  ctx.fillText('store.steampowered.com', boardW - L.pad, y);
  ctx.textAlign = 'left';
}

/* ── 카드 ────────────────────────────────────────────── */

function drawCard(ctx, options, item, cover, x, y) {
  const t = options.theme;
  const base = cover ? dominantColor(cover, item.image) : { r: 92, g: 104, b: 124 };
  const deep = shade(base, -0.42);   // 글자 깔릴 어두운 쪽
  const band = shade(base, 0.34);    // 카드 아래 띠

  ctx.save();
  roundRect(ctx, x, y, L.cardW, L.cardH, L.cardRadius);
  ctx.clip();

  // 게임 이미지
  if (cover) {
    drawCover(ctx, cover, x, y, L.cardW, L.imageH);
  } else {
    ctx.fillStyle = rgba(base, 1);
    ctx.fillRect(x, y, L.cardW, L.imageH);
  }

  // 이미지 위에 대표색을 덮어 글자가 읽히게 한다.
  // 위쪽은 거의 건드리지 않아 아트가 그대로 보이고, 아래로 갈수록 색이 진해진다.
  const wash = ctx.createLinearGradient(0, y, 0, y + L.imageH);
  wash.addColorStop(0, rgba(base, 0));
  wash.addColorStop(0.34, rgba(base, 0.14));
  wash.addColorStop(0.62, rgba(deep, 0.66));
  wash.addColorStop(1, rgba(deep, 0.97));
  ctx.fillStyle = wash;
  ctx.fillRect(x, y, L.cardW, L.imageH);

  // 아래 띠
  ctx.fillStyle = rgba(band, 1);
  ctx.fillRect(x, y + L.imageH, L.cardW, L.bandH);

  ctx.restore();

  const innerW = L.cardW - L.cardPadX * 2;


  // 이미지 아래쪽에 겹치는 정보줄
  const metaY = y + L.imageH - 30;
  if (options.showDate) {
    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    ctx.font = '700 ' + L.metaSize + 'px ' + FONT;
    ctx.fillText(formatDate(item.dateAdded) || '날짜 없음', x + L.cardPadX, metaY);
  }

  // 출시 상태 배지
  const status = item.comingSoon ? '출시 예정' : '';
  if (status) {
    ctx.font = '700 10.5px ' + FONT;
    const w = ctx.measureText(status).width + 12;
    ctx.fillStyle = 'rgba(255,255,255,0.22)';
    roundRect(ctx, x + L.cardW - L.cardPadX - w, metaY - 11, w, 16, 8);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.fillText(status, x + L.cardW - L.cardPadX - w / 2, metaY + 0.5);
    ctx.textAlign = 'left';
  }

  // 게임 이름
  ctx.fillStyle = '#ffffff';
  ctx.font = '700 ' + L.titleSize + 'px ' + FONT;
  ctx.fillText(ellipsize(ctx, item.name, innerW), x + L.cardPadX, y + L.imageH - 11);

  // 아래 띠 안의 글자
  const bandText = options.showRelease
    ? (item.comingSoon ? '출시일 미정' : (formatDate(item.releaseDate) || '출시일 미상') + ' 출시')
    : 'STEAM';
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.font = '600 10.5px ' + FONT;
  ctx.fillText(ellipsize(ctx, bandText, innerW), x + L.cardPadX, y + L.imageH + 16);
}

/* ── 게임 선택 목록 ───────────────────────────────────── */

function buildPicker() {
  el.picker.innerHTML = '';
  const ordered = wishlist.items.slice().sort((a, b) => b.dateAdded - a.dateAdded);

  for (const item of ordered) {
    const li = document.createElement('li');
    const label = document.createElement('label');

    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = !excluded.has(item.appid);
    box.addEventListener('change', () => {
      if (box.checked) excluded.delete(item.appid);
      else excluded.add(item.appid);
      li.classList.toggle('off', !box.checked);
      updatePickCount();
      render();
    });

    // 접힌 목록 안이라 펼치기 전에는 요청이 나가지 않고, 펼쳐도 보이는 것만 받는다.
    // 카드 그리기용 대기열과 경쟁하지 않도록 여기서는 대기열을 쓰지 않는다.
    const thumb = document.createElement('img');
    thumb.alt = '';
    thumb.loading = 'lazy';
    thumb.src = proxied(item.image);

    const name = document.createElement('span');
    name.textContent = item.name;
    name.title = item.name;

    label.append(box, thumb, name);
    li.append(label);
    el.picker.append(li);
  }
  updatePickCount();
}

function updatePickCount() {
  const total = wishlist.items.length;
  el.pickCount.textContent = (total - excluded.size) + ' / ' + total;
}

function setAllPicked(picked) {
  excluded = picked ? new Set() : new Set(wishlist.items.map((i) => i.appid));
  buildPicker();
  render();
}

/* ── 불러오기 / 저장 ──────────────────────────────────── */

// 링크에 필터가 걸려 있으면 무엇이 적용됐는지 보여준다.
// 우리가 아직 못 다루는 필터가 섞여 있으면 그것도 솔직히 알린다.
function showFilterNote(filters) {
  const note = el.filterNote;
  const applied = (filters && filters.applied) || [];
  const ignored = (filters && filters.ignored) || [];

  if (!applied.length && !ignored.length) {
    note.hidden = true;
    note.textContent = '';
    return;
  }

  note.hidden = false;
  note.textContent = '';

  if (applied.length) {
    const line = document.createElement('span');
    line.innerHTML = '링크에 걸린 필터를 적용했습니다 — <b></b>';
    line.querySelector('b').textContent = applied.join(' · ');
    note.append(line);
  }
  if (ignored.length) {
    const warn = document.createElement('span');
    warn.className = 'warn';
    warn.textContent = '아직 지원하지 않는 필터라 무시했습니다: ' + ignored.join(', ');
    note.append(warn);
  }
}

async function loadWishlist() {
  const link = el.link.value.trim();
  if (!link) {
    setStatus('찜 목록 링크를 입력해 주세요.', true);
    return;
  }

  el.load.disabled = true;
  setStatus('스팀에서 찜 목록을 불러오는 중…');

  try {
    const res = await fetch('/api/wishlist?url=' + encodeURIComponent(link));
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '불러오지 못했습니다.');

    wishlist = data;
    excluded = new Set();
    currentPage = 0;
    el.options.hidden = false;
    el.pickerBlock.hidden = false;
    buildPicker();
    await render();

    const who = (data.profile && data.profile.name) || data.steamid;
    const applied = (data.filters && data.filters.applied) || [];
    setStatus(applied.length
      ? who + ' 님의 찜 목록에서 ' + data.count + '개를 골랐습니다. (전체 ' + data.total + '개)'
      : who + ' 님의 찜 목록 ' + data.count + '개를 불러왔습니다.');
    showFilterNote(data.filters);
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    el.load.disabled = false;
  }
}

/* ── 여러 장을 zip 하나로 묶기 ────────────────────────── */

// 장이 여러 개일 때 파일을 하나씩 내려주면 브라우저가 "여러 파일 다운로드"를 묻고
// 사용자도 번거롭다. 그래서 zip 하나로 묶어 한 번에 받게 한다.
// JPG/PNG는 이미 압축되어 있으므로 압축하지 않고(store) 담는다.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i += 1) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function dosDateTime(d) {
  return {
    time: ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() >> 1) & 31),
    date: (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31),
  };
}

// files: [{ name, blob, crc, size }]
function buildZip(files) {
  const encoder = new TextEncoder();
  const stamp = dosDateTime(new Date());
  const body = [];
  const directory = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = encoder.encode(file.name);

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true);   // 파일명이 UTF-8임을 표시(한글 파일명)
    local.setUint16(8, 0, true);        // 압축 안 함
    local.setUint16(10, stamp.time, true);
    local.setUint16(12, stamp.date, true);
    local.setUint32(14, file.crc, true);
    local.setUint32(18, file.size, true);
    local.setUint32(22, file.size, true);
    local.setUint16(26, nameBytes.length, true);
    body.push(new Uint8Array(local.buffer), nameBytes, file.blob);

    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true);
    entry.setUint16(4, 20, true);
    entry.setUint16(6, 20, true);
    entry.setUint16(8, 0x0800, true);
    entry.setUint16(10, 0, true);
    entry.setUint16(12, stamp.time, true);
    entry.setUint16(14, stamp.date, true);
    entry.setUint32(16, file.crc, true);
    entry.setUint32(20, file.size, true);
    entry.setUint32(24, file.size, true);
    entry.setUint16(28, nameBytes.length, true);
    entry.setUint32(42, offset, true);
    directory.push(new Uint8Array(entry.buffer), nameBytes);

    offset += 30 + nameBytes.length + file.size;
  }

  const directorySize = directory.reduce((sum, part) => sum + part.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, directorySize, true);
  end.setUint32(16, offset, true);

  return new Blob([...body, ...directory, new Uint8Array(end.buffer)], { type: 'application/zip' });
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function megabytes(bytes) {
  return (bytes / 1048576).toFixed(1) + 'MB';
}

function fileBaseName() {
  // 이름을 숨긴 채로 저장했다면 파일 이름에도 닉네임을 넣지 않는다.
  const raw = el.showName.checked && wishlist.profile && wishlist.profile.name
    ? wishlist.profile.name
    : '스팀';
  const who = raw.replace(/[\\/:*?"<>|]/g, '').trim() || '스팀';
  return '찜목록_' + who + '_' + formatDate(Date.now() / 1000).replace(/\./g, '');
}

// 지금 캔버스를 이미지 한 장으로 만든다.
// 배경이 불투명하게 이미 칠해져 있어 JPG로 내보내도 검게 뜨지 않는다.
function canvasBlob() {
  const isJpeg = el.format.value === 'jpeg';
  return new Promise((resolve) => {
    el.board.toBlob(resolve, isJpeg ? 'image/jpeg' : 'image/png', 0.92);
  });
}

async function saveImage() {
  if (!wishlist) return;

  el.save.disabled = true;
  const base = fileBaseName();
  const extension = el.format.value === 'jpeg' ? '.jpg' : '.png';
  const startedAt = currentPage;

  try {
    if (pageCount === 1) {
      setStatus('이미지를 만드는 중…');
      const blob = await canvasBlob();
      if (!blob) throw new Error('이미지를 만들지 못했습니다.');
      downloadBlob(blob, base + extension);
      setStatus('저장했습니다. (' + megabytes(blob.size) + ')');
      return;
    }

    // 여러 장이면 전부 만들어 zip 하나로 묶는다.
    const files = [];
    for (let page = 0; page < pageCount; page += 1) {
      setStatus('이미지를 만드는 중… (' + (page + 1) + '/' + pageCount + '장)');
      currentPage = page;
      await render();

      const blob = await canvasBlob();
      if (!blob) throw new Error('이미지를 만들지 못했습니다.');

      // CRC를 구하는 동안만 바이트를 펼치고, 담아둘 때는 blob만 들고 있는다.
      const bytes = new Uint8Array(await blob.arrayBuffer());
      files.push({
        name: base + '_' + (page + 1) + 'of' + pageCount + extension,
        blob,
        crc: crc32(bytes),
        size: bytes.length,
      });
    }

    setStatus('한 파일로 묶는 중…');
    const zip = buildZip(files);
    downloadBlob(zip, base + '.zip');
    setStatus(pageCount + '장을 zip 하나로 저장했습니다. (' + megabytes(zip.size) + ')');
  } catch (err) {
    setStatus(err.message + ' 해상도를 낮추거나 한 장에 담을 게임 수를 줄여 보세요.', true);
  } finally {
    if (currentPage !== startedAt) {
      currentPage = startedAt;
      await render();
    }
    el.save.disabled = false;
  }
}

/* ── 이벤트 연결 ──────────────────────────────────────── */

el.load.addEventListener('click', loadWishlist);
el.link.addEventListener('keydown', (e) => { if (e.key === 'Enter') loadWishlist(); });
el.save.addEventListener('click', saveImage);
el.pickAll.addEventListener('click', () => setAllPicked(true));
el.pickNone.addEventListener('click', () => setAllPicked(false));

function rerenderFromFirstPage() {
  currentPage = 0;
  render();
}

el.columns.addEventListener('input', () => {
  el.columnsValue.textContent = el.columns.value;
  rerenderFromFirstPage();
});

el.prevPage.addEventListener('click', () => { if (currentPage > 0) { currentPage -= 1; render(); } });
el.nextPage.addEventListener('click', () => { if (currentPage < pageCount - 1) { currentPage += 1; render(); } });

// 상단 영역을 끄면 그 안의 프로필 사진·이름 항목은 손댈 이유가 없으므로 함께 잠근다.
function syncHeaderControls() {
  el.showAvatar.disabled = !el.showHeader.checked;
  el.showName.disabled = !el.showHeader.checked;
}
el.showHeader.addEventListener('change', syncHeaderControls);
syncHeaderControls();

for (const control of [el.sort, el.theme, el.scale, el.perPage, el.showHeader, el.showAvatar,
                       el.showName, el.showDate, el.showRelease]) {
  control.addEventListener('change', rerenderFromFirstPage);
}

let titleTimer;
el.title.addEventListener('input', () => {
  clearTimeout(titleTimer);
  titleTimer = setTimeout(render, 200);
});
