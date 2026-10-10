'use strict';

/* ==================================================================
   요청 처리의 알맹이.
   로컬 HTTP 서버(server.js)와 AWS Lambda(lambda.js)가 이 파일을 함께 쓴다.
   그래서 여기에는 Node의 req/res나 Lambda 이벤트가 들어오지 않고,
   "메서드 + 경로 + 쿼리"만 들어오고 "상태 + 헤더 + 본문"만 나간다.
   ================================================================== */

const fs = require('fs/promises');
const path = require('path');

const PUBLIC_DIR = path.join(__dirname, 'public');

const LANGUAGE = 'koreana';
const COUNTRY = 'KR';
const ASSET_BASE = 'https://shared.fastly.steamstatic.com/store_item_assets/';

const CACHE_TTL = 10 * 60 * 1000;
const wishlistCache = new Map();
const libraryCache = new Map();
const imageCache = new Map();
const IMAGE_CACHE_MAX = 200;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/* ------------------------------------------------------------------ */
/* 응답 만들기                                                          */
/* ------------------------------------------------------------------ */

// 본문은 항상 Buffer로 돌려준다. Lambda는 이걸 base64로 감싸서 보내면 되고,
// 로컬 서버는 그대로 흘려보내면 되므로 한글 인코딩 문제가 생기지 않는다.
function reply(status, contentType, body, extraHeaders) {
  return {
    status,
    headers: Object.assign({ 'Content-Type': contentType }, extraHeaders),
    body: Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8'),
  };
}

function jsonReply(status, payload) {
  return reply(status, 'application/json; charset=utf-8', JSON.stringify(payload));
}

/* ------------------------------------------------------------------ */
/* 스팀 데이터 수집                                                      */
/* ------------------------------------------------------------------ */

// 사용자가 붙여넣은 찜 목록 공유 링크에서 프로필 ID(steamID64)를 뽑아낸다.
// 지원 형태:
//   https://store.steampowered.com/wishlist/profiles/7656.../?st=...
//   https://store.steampowered.com/wishlist/id/<커스텀URL>/
//   https://steamcommunity.com/profiles/7656.../wishlist
//   https://steamcommunity.com/id/<커스텀URL>/wishlist
//   7656...  또는  <커스텀URL>
async function resolveSteamId(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new HttpError(400, '링크를 입력해 주세요.');
  if (/^\d{17}$/.test(raw)) return raw;

  let id64 = null;
  let vanity = null;

  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : 'https://' + raw);
    const parts = url.pathname.split('/').filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
      if (parts[i] === 'profiles' && parts[i + 1]) id64 = decodeURIComponent(parts[i + 1]);
      if (parts[i] === 'id' && parts[i + 1]) vanity = decodeURIComponent(parts[i + 1]);
    }
  } catch {
    // URL 형태가 아니면 커스텀 URL 이름으로 취급한다.
  }

  if (id64 && /^\d{17}$/.test(id64)) return id64;
  if (!vanity) vanity = raw.replace(/^https?:\/\//i, '').split('/').filter(Boolean).pop() || raw;

  return resolveVanityUrl(vanity);
}

async function resolveVanityUrl(vanity) {
  if (!/^[\w.-]{2,64}$/.test(vanity)) {
    throw new HttpError(400, '링크에서 스팀 프로필을 찾지 못했습니다. 스팀 주소를 그대로 붙여넣어 주세요.');
  }
  const res = await fetch('https://steamcommunity.com/id/' + encodeURIComponent(vanity) + '?xml=1', {
    headers: { 'User-Agent': 'steam-wishlist-capture' },
  });
  const xml = await res.text();
  const found = xml.match(/<steamID64>(\d{17})<\/steamID64>/);
  if (!found) throw new HttpError(404, '"' + vanity + '" 프로필을 찾을 수 없습니다.');
  return found[1];
}

async function fetchWishlist(steamid) {
  const res = await fetch('https://api.steampowered.com/IWishlistService/GetWishlist/v1/?steamid=' + steamid, {
    headers: { 'User-Agent': 'steam-wishlist-capture' },
  });
  if (!res.ok) throw new HttpError(502, '스팀에서 찜 목록을 가져오지 못했습니다. (HTTP ' + res.status + ')');
  const body = await res.json();
  const items = body && body.response && body.response.items;
  if (!Array.isArray(items) || items.length === 0) {
    throw new HttpError(404, '찜 목록이 비어 있거나 비공개입니다. 스팀 [프로필 → 개인정보 보호 설정 → 게임 세부 정보]를 "공개"로 바꾼 뒤 다시 시도해 주세요.');
  }
  return items;
}

// 카드 묶음 상단에 넣을 닉네임과 아바타. 실패해도 목록 자체는 만들 수 있으므로 조용히 넘어간다.
async function fetchProfile(steamid) {
  try {
    const res = await fetch('https://steamcommunity.com/profiles/' + steamid + '?xml=1', {
      headers: { 'User-Agent': 'steam-wishlist-capture' },
    });
    const xml = await res.text();
    const name = xml.match(/<steamID><!\[CDATA\[([\s\S]*?)\]\]><\/steamID>/);
    const avatar = xml.match(/<avatarFull><!\[CDATA\[([\s\S]*?)\]\]><\/avatarFull>/);
    return {
      name: name ? name[1].trim() : '',
      avatar: avatar ? avatar[1].trim() : '',
    };
  } catch {
    return { name: '', avatar: '' };
  }
}

// 여러 요청을 한꺼번에 다 던지지 않고 정해진 개수씩만 굴린다.
// 찜한 게임이 1,600개면 묶음이 32개가 되는데, 전부 동시에 보내면 스팀이 거절한다.
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(runners);
  return results;
}

// 게임 이름/이미지/출시일/가격을 appid 50개씩 묶어 조회한다.
async function fetchStoreItems(appids) {
  const chunks = [];
  for (let i = 0; i < appids.length; i += 50) chunks.push(appids.slice(i, i + 50));

  const responses = await mapLimit(chunks, 6, async (chunk) => {
    const input = {
      ids: chunk.map((appid) => ({ appid })),
      context: { language: LANGUAGE, country_code: COUNTRY, steam_realm: 1 },
      data_request: {
        include_assets: true,
        include_release: true,
        include_platforms: true,
        include_basic_info: true,
        include_all_purchase_options: true,
      },
    };
    const url = 'https://api.steampowered.com/IStoreBrowseService/GetItems/v1/?input_json=' +
      encodeURIComponent(JSON.stringify(input));
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'steam-wishlist-capture' } });
      if (!res.ok) return [];
      const body = await res.json();
      return (body && body.response && body.response.store_items) || [];
    } catch {
      return [];
    }
  });

  const result = new Map();
  for (const storeItems of responses) {
    for (const item of storeItems) {
      if (item && item.appid) result.set(item.appid, item);
    }
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* 찜 목록 링크에 걸린 필터                                               */
/* ------------------------------------------------------------------ */

// 스팀 찜 목록 페이지는 필터를 브라우저에서 적용한다. 서버가 내려주는 HTML에는
// 앞쪽 16개 정도만 들어 있어서 그대로 긁어올 수 없다. 그래서 링크에 붙은
// 필터 조건을 읽어 같은 기준으로 우리가 직접 걸러낸다.
//
// type 값은 실제 항목으로 확인했다: 0=게임, 4=DLC, 6=소프트웨어, 11=사운드트랙
const TYPE_IDS = {
  games: 0, game: 0,
  dlc: 4,
  software: 6,
  soundtrack: 11, music: 11,
};

function parseFilters(link) {
  const filters = { applied: [], ignored: [] };

  let params;
  try {
    params = new URL(/^https?:\/\//i.test(link) ? link : 'https://' + link).searchParams;
  } catch {
    return filters;
  }

  const minDiscount = params.get('min_discount');
  if (minDiscount) {
    if (minDiscount === 'any') {
      filters.minDiscount = 1;
      filters.applied.push('할인 중인 게임만');
    } else {
      const percent = Number(minDiscount);
      if (Number.isFinite(percent) && percent > 0) {
        filters.minDiscount = percent;
        filters.applied.push(percent + '% 이상 할인');
      }
    }
  }

  const typeNames = (params.get('type_filters') || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (typeNames.length) {
    const ids = typeNames.map((name) => TYPE_IDS[name.toLowerCase()]);
    if (ids.every((id) => id !== undefined)) {
      filters.types = new Set(ids);
      filters.applied.push('종류: ' + typeNames.join(', '));
    } else {
      // 모르는 종류가 섞여 있으면 잘못 걸러내느니 통째로 건너뛴다.
      filters.ignored.push('type_filters');
    }
  }

  const osNames = (params.get('os_filters') || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (osNames.length) {
    filters.os = osNames.map((s) => s.toLowerCase());
    filters.applied.push('실행 환경: ' + osNames.join(', '));
  }

  const text = params.get('search') || params.get('q') || params.get('search_text');
  if (text) {
    filters.text = text.toLowerCase();
    filters.applied.push('검색어: ' + text);
  }

  // 아직 구현하지 못한 것들. 조용히 무시하지 않고 사용자에게 알려준다.
  for (const key of ['tag_filters', 'price_filters', 'max_price', 'hide_owned', 'hide_ignored']) {
    if (params.get(key)) filters.ignored.push(key);
  }

  return filters;
}

function matchesFilters(item, filters) {
  if (filters.minDiscount && item.discountPct < filters.minDiscount) return false;
  if (filters.types && !filters.types.has(item.type)) return false;
  if (filters.os) {
    const p = item.platforms;
    const ok = filters.os.some((os) =>
      (os === 'win' && p.windows) || (os === 'mac' && p.mac) || (os === 'linux' && p.linux));
    if (!ok) return false;
  }
  if (filters.text && !item.name.toLowerCase().includes(filters.text)) return false;
  return true;
}

function pickImage(storeItem, appid) {
  const assets = storeItem && storeItem.assets;
  if (assets && assets.asset_url_format) {
    const filename = assets.header_2x || assets.header || assets.main_capsule_2x || assets.main_capsule;
    if (filename) return ASSET_BASE + assets.asset_url_format.replace('${FILENAME}', filename);
  }
  return 'https://cdn.cloudflare.steamstatic.com/steam/apps/' + appid + '/header.jpg';
}

// 필터는 링크마다 다르지만 원본 목록은 같으므로, 원본만 캐시하고 필터는 그 위에 얹는다.
async function fetchWishlistRaw(steamid) {
  const cached = wishlistCache.get(steamid);
  if (cached && Date.now() - cached.time < CACHE_TTL) return cached.data;

  const entries = await fetchWishlist(steamid);
  const [profile, storeItems] = await Promise.all([
    fetchProfile(steamid),
    fetchStoreItems(entries.map((e) => e.appid)),
  ]);

  const items = entries.map((entry) => {
    const store = storeItems.get(entry.appid);
    const release = store && store.release;
    const platforms = (store && store.platforms) || {};
    const purchase = (store && store.best_purchase_option) ||
      (store && store.purchase_options && store.purchase_options[0]) || null;

    return {
      appid: entry.appid,
      name: (store && store.name) || ('앱 ' + entry.appid),
      image: pickImage(store, entry.appid),
      dateAdded: entry.date_added || 0,
      priority: entry.priority || 0,
      comingSoon: !!(release && release.is_coming_soon),
      releaseDate: (release && release.steam_release_date) || 0,
      storeUrl: 'https://store.steampowered.com/app/' + entry.appid + '/',
      // 아래는 링크에 걸린 필터를 적용할 때만 쓴다.
      type: (store && store.type) || 0,
      discountPct: (purchase && purchase.discount_pct) || 0,
      platforms: {
        windows: !!platforms.windows,
        mac: !!platforms.mac,
        linux: !!platforms.steamos_linux,
      },
    };
  });

  const data = { steamid, profile, items };
  wishlistCache.set(steamid, { time: Date.now(), data });
  return data;
}

async function buildWishlist(link) {
  const steamid = await resolveSteamId(link);
  const raw = await fetchWishlistRaw(steamid);
  const filters = parseFilters(link);

  const items = filters.applied.length
    ? raw.items.filter((item) => matchesFilters(item, filters))
    : raw.items;

  if (filters.applied.length && items.length === 0) {
    throw new HttpError(404, '링크에 걸린 필터(' + filters.applied.join(', ') +
      ')에 해당하는 게임이 없습니다. 필터 없는 찜 목록 주소로 다시 시도해 보세요.');
  }

  return {
    mode: 'wishlist',
    steamid,
    profile: raw.profile,
    count: items.length,
    total: raw.items.length,
    filters: { applied: filters.applied, ignored: filters.ignored },
    // 필터 판단용 값은 화면에서 쓰지 않으므로 응답에서 뺀다.
    items: items.map(({ type, discountPct, platforms, ...rest }) => rest),
  };
}

/* ------------------------------------------------------------------ */
/* 라이브러리(보유 게임)                                                  */
/* ------------------------------------------------------------------ */

// 찜 목록과 달리 보유 게임은 키 없이 가져올 방법이 없다. 2026년 기준으로
// 전부 막혀 있음을 확인했다:
//   - steamcommunity.com/profiles/<id>/games?tab=all&xml=1  → 302 로그인 리디렉션
//   - 게임 목록 페이지 HTML                                  → Sign In 페이지
//   - IPlayerService/GetOwnedGames 키 없이                   → 401 Unauthorized
// 그래서 스팀 웹 API 키를 환경 변수로 받는다. 키는 저장소에 두지 않는다.
const STEAM_API_KEY = process.env.STEAM_API_KEY || '';

async function fetchOwnedGames(steamid) {
  if (!STEAM_API_KEY) {
    throw new HttpError(503,
      '라이브러리 기능은 아직 준비 중입니다. (서버에 스팀 API 키가 설정되지 않았습니다)');
  }

  // 스팀 프로필의 게임 목록 페이지(/games/?tab=all)와 같은 개수가 나오도록 맞췄다.
  // 유료든 무료든 전부 포함한다. skip_unvetted_apps 를 켜면 일부가 빠져서 끈다.
  const url = 'https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/' +
    '?key=' + encodeURIComponent(STEAM_API_KEY) +
    '&steamid=' + steamid +
    '&include_appinfo=1&include_played_free_games=1&skip_unvetted_apps=false';

  const res = await fetch(url, { headers: { 'User-Agent': 'steam-wishlist-capture' } });
  if (res.status === 401 || res.status === 403) {
    throw new HttpError(502, '스팀 API 키가 거부되었습니다. 키가 올바른지 확인해 주세요.');
  }
  if (!res.ok) throw new HttpError(502, '스팀에서 라이브러리를 가져오지 못했습니다. (HTTP ' + res.status + ')');

  const body = await res.json();
  const games = body && body.response && body.response.games;

  // 게임 세부 정보가 비공개면 스팀이 빈 응답을 준다. 숨긴 게임도 여기 포함되지 않는다.
  if (!Array.isArray(games) || games.length === 0) {
    throw new HttpError(404,
      '라이브러리가 비어 있거나 비공개입니다. 스팀 [프로필 → 개인정보 보호 설정 → 게임 세부 정보]를 ' +
      '"공개"로 바꾼 뒤 다시 시도해 주세요.');
  }
  return games;
}

async function buildLibrary(link) {
  const steamid = await resolveSteamId(link);

  const cached = libraryCache.get(steamid);
  if (cached && Date.now() - cached.time < CACHE_TTL) return cached.data;

  const owned = await fetchOwnedGames(steamid);
  const [profile, storeItems] = await Promise.all([
    fetchProfile(steamid),
    fetchStoreItems(owned.map((g) => g.appid)),
  ]);

  const items = owned.map((game) => {
    const store = storeItems.get(game.appid);
    const release = store && store.release;
    return {
      appid: game.appid,
      name: (store && store.name) || game.name || ('앱 ' + game.appid),
      image: pickImage(store, game.appid),
      playtime: game.playtime_forever || 0,          // 분 단위
      lastPlayed: game.rtime_last_played || 0,
      comingSoon: !!(release && release.is_coming_soon),
      releaseDate: (release && release.steam_release_date) || 0,
      storeUrl: 'https://store.steampowered.com/app/' + game.appid + '/',
    };
  });

  const data = {
    mode: 'library',
    steamid,
    profile,
    count: items.length,
    total: items.length,
    filters: { applied: [], ignored: [] },
    items,
  };
  libraryCache.set(steamid, { time: Date.now(), data });
  return data;
}

/* ------------------------------------------------------------------ */
/* 이미지 프록시                                                         */
/* ------------------------------------------------------------------ */

// 캔버스로 저장하려면 이미지가 같은 출처여야 한다. 다른 출처의 이미지는 canvas를
// 오염시켜 toBlob 호출이 막히므로, 스팀 CDN 이미지를 이 서버가 대신 받아서 넘겨준다.
const ALLOWED_IMAGE_HOST = /(^|\.)(steamstatic\.com|steampowered\.com|akamaihd\.net)$/i;

async function proxyImage(target) {
  let url;
  try {
    url = new URL(target);
  } catch {
    throw new HttpError(400, '잘못된 이미지 주소입니다.');
  }
  if (url.protocol !== 'https:' || !ALLOWED_IMAGE_HOST.test(url.hostname)) {
    throw new HttpError(403, '스팀 이미지 주소만 사용할 수 있습니다.');
  }

  const key = url.href;
  const hit = imageCache.get(key);
  if (hit) return reply(200, hit.type, hit.buffer, { 'Cache-Control': 'public, max-age=86400' });

  const upstream = await fetch(key, { headers: { 'User-Agent': 'steam-wishlist-capture' } });
  if (!upstream.ok) throw new HttpError(502, '이미지를 가져오지 못했습니다. (HTTP ' + upstream.status + ')');

  const type = upstream.headers.get('content-type') || 'image/jpeg';
  const buffer = Buffer.from(await upstream.arrayBuffer());

  if (imageCache.size >= IMAGE_CACHE_MAX) imageCache.delete(imageCache.keys().next().value);
  imageCache.set(key, { type, buffer });

  return reply(200, type, buffer, { 'Cache-Control': 'public, max-age=86400' });
}

/* ------------------------------------------------------------------ */
/* 정적 파일                                                            */
/* ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

async function serveStatic(pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = path.join(PUBLIC_DIR, rel);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    return reply(403, 'text/plain; charset=utf-8', '접근할 수 없습니다.');
  }
  try {
    const body = await fs.readFile(filePath);
    const ext = path.extname(filePath);
    // HTML은 캐시하지 않는다. 그래야 배포 직후 새 CSS/JS 버전을 바로 집어간다.
    // CSS/JS는 index.html에서 ?v= 를 붙여 부르므로 길게 캐시해도 안전하다.
    const cache = ext === '.html' ? 'no-cache' : 'public, max-age=86400';
    return reply(200, MIME[ext] || 'application/octet-stream', body, { 'Cache-Control': cache });
  } catch {
    return reply(404, 'text/plain; charset=utf-8', '없는 페이지입니다.');
  }
}

/* ------------------------------------------------------------------ */
/* 라우팅                                                               */
/* ------------------------------------------------------------------ */

async function route(method, pathname, query) {
  try {
    if (pathname === '/api/wishlist') return jsonReply(200, await buildWishlist(query.get('url')));
    if (pathname === '/api/library') return jsonReply(200, await buildLibrary(query.get('url')));
    if (pathname === '/api/image') return await proxyImage(query.get('u'));
    if (pathname === '/health') return jsonReply(200, { ok: true });
    return await serveStatic(pathname);
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status >= 500) console.error(err);
    return jsonReply(status, { error: err.message || '알 수 없는 오류가 발생했습니다.' });
  }
}

module.exports = { route };
