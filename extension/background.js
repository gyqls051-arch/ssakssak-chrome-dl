/* =============================================================================
 * 싹싹김치 — background service worker (스트림 감지부)
 * -----------------------------------------------------------------------------
 * 역할:
 *   1) chrome.webRequest(관찰 모드, 비차단)로 현재 탭에서 흐르는 미디어 요청을
 *      가로챈다.  m3u8(HLS) / mpd(DASH) / mp4 / webm + video/* 응답.
 *   2) 같은 요청(requestId) 안에서 일어나는 3개의 이벤트를 합쳐
 *      "URL + 실제 요청 헤더(Referer/Origin/Cookie/User-Agent) + Content-Type"
 *      를 하나의 스트림 레코드로 만든다.
 *   3) 탭별로 그룹화 + URL 중복 제거 → chrome.storage.session 에 저장 + 배지 갱신.
 *   4) 메인 프레임 이동(새 페이지) 시 해당 탭 목록 초기화.
 *
 * 왜 webRequest 인가:
 *   MV3 에서 "요청 변조(blocking)"는 막혔지만 "관찰(observe)"은 그대로 된다.
 *   단, Cookie/Referer 같은 민감 헤더는 extraInfoSpec 에 'extraHeaders' 를
 *   넣어야만 보인다(Chrome 72/79 이후). 이게 이 도구의 핵심 — 브라우저가 이미
 *   풀어놓은 토큰/쿠키/Referer 를 "그 요청 그대로" 손에 넣는다.
 * ========================================================================== */

'use strict';

// 헬퍼로 넘길 때 의미 있는 헤더만 추린다(토큰 서명 스트림이 열리는 데 필요한 것들).
// Host/Range/sec-fetch-* 등은 오히려 직접 다운로드를 깨므로 제외.
const HEADER_ALLOW = ['referer', 'origin', 'cookie', 'user-agent', 'accept', 'accept-language'];

// requestId 단위로 onBeforeRequest~onHeadersReceived 사이의 조각을 모아두는 임시 버퍼
let pending = {};                   // requestId -> { url, type, tabId, pageUrl, reqHeaders }
const PENDING_CAP = 800;            // 완료 이벤트를 못 받은 요청이 쌓이는 것 방지
// 탭별 확정된 스트림 목록 (서비스워커 메모리상의 1차 소스)
const tabStreams = {};              // tabId(String) -> [ stream, ... ]
// 브라우저 안에서 처리하는 다운로드 작업(헬퍼 안 거치는 HLS/progressive)
let ibjobsMem = {};                 // id -> { id, title, status, percent, ... }
const ibDownloadMap = {};           // chrome.downloads id -> ibjob id (progressive 추적)

const MAX_PER_TAB = 60;             // 한 탭에 너무 많이 쌓이지 않게 상한

// 서비스워커가 잠들었다 깨면 메모리가 비므로 session 저장소에서 복구
(async () => {
  try {
    const all = await chrome.storage.session.get(null);
    for (const [k, v] of Object.entries(all)) {
      if (k.startsWith('streams:')) tabStreams[k.slice('streams:'.length)] = v;
      else if (k === 'ibjobs') ibjobsMem = v || {};
    }
  } catch (e) { /* 최초 실행 등 — 무시 */ }
})();

/* ---------- 작은 유틸들 ---------- */

function headersArrayToObject(arr) {
  const o = {};
  if (!arr) return o;
  for (const h of arr) o[h.name.toLowerCase()] = h.value;
  return o;
}

// 캡처한 전체 헤더에서 다운로드에 쓸 것만 골라 원래 표기로 되돌린다.
function curateHeaders(reqHeaders) {
  const pretty = { referer: 'Referer', origin: 'Origin', cookie: 'Cookie',
                   'user-agent': 'User-Agent', accept: 'Accept', 'accept-language': 'Accept-Language' };
  const out = {};
  for (const name of HEADER_ALLOW) {
    if (reqHeaders[name] != null && reqHeaders[name] !== '') out[pretty[name]] = reqHeaders[name];
  }
  return out;
}

// URL → 미디어 유형 분류. 매니페스트(HLS/DASH)는 항상, 프로그레시브 파일은 조건부.
function classify(url, contentType) {
  let path = '';
  try { path = new URL(url).pathname.toLowerCase(); } catch { path = url.toLowerCase(); }
  const ct = (contentType || '').toLowerCase();

  // 1) Content-Type 기반(가장 신뢰도 높음)
  if (ct.includes('mpegurl')) return 'hls';                         // application/vnd.apple.mpegurl, application/x-mpegurl
  if (ct.includes('dash+xml')) return 'dash';                       // application/dash+xml
  // 2) 확장자 기반
  if (path.endsWith('.m3u8')) return 'hls';
  if (path.endsWith('.mpd')) return 'dash';
  if (path.endsWith('.ts') || path.endsWith('.m4s')) return 'segment';  // 개별 세그먼트 → 목록에서 제외
  if (/(^|\/)init\.mp4$/.test(path)) return 'segment';                  // DASH 초기화 세그먼트
  if (path.endsWith('.mp4') || path.endsWith('.m4v') || path.endsWith('.mov')) return 'mp4';
  if (path.endsWith('.webm')) return 'webm';
  // 3) Content-Type video/* (확장자 없는 토큰 URL 대응)
  if (ct.startsWith('video/')) return ct.includes('webm') ? 'webm' : 'mp4';
  return null;
}

function makeId(url) {
  // URL → 짧은 해시(중복 제거/요소 식별용). 암호화 목적 아님.
  let h = 0;
  for (let i = 0; i < url.length; i++) { h = (h * 31 + url.charCodeAt(i)) | 0; }
  return 'm' + (h >>> 0).toString(36);
}

function badge(tabId) {
  const n = (tabStreams[tabId] || []).length;
  chrome.action.setBadgeText({ tabId: Number(tabId), text: n ? String(n) : '' });
  chrome.action.setBadgeBackgroundColor({ tabId: Number(tabId), color: '#1f6feb' });
}

function persist(tabId) {
  chrome.storage.session.set({ ['streams:' + tabId]: tabStreams[tabId] || [] }).catch(() => {});
}

function clearTab(tabId) {
  delete tabStreams[tabId];
  chrome.storage.session.remove('streams:' + tabId).catch(() => {});
  chrome.action.setBadgeText({ tabId: Number(tabId), text: '' });
}

// 확정된 스트림을 탭 목록에 추가(중복 URL 무시, 매니페스트가 위로 오게 정렬)
function addStream(stream) {
  const tabId = String(stream.tabId);
  const list = tabStreams[tabId] || (tabStreams[tabId] = []);
  if (list.some(s => s.url === stream.url)) return;          // 같은 URL 중복 제거
  list.unshift(stream);
  // 매니페스트(hls/dash)를 항상 위로
  list.sort((a, b) => rank(b) - rank(a));
  if (list.length > MAX_PER_TAB) list.length = MAX_PER_TAB;
  persist(tabId);
  badge(tabId);
}
function rank(s) { return s.type === 'hls' ? 3 : s.type === 'dash' ? 3 : 2; }

/* ---------- webRequest 파이프라인 (요청 1건 = 3 이벤트 합치기) ----------
 * 성능: 이미지/스크립트/폰트/CSS 까지 전부 감시하면 무겁고, 민감 헤더 캡처용
 *       'extraHeaders' 는 Chrome 문서가 "성능 저하" 를 경고한다. 그래서 미디어가
 *       흐를 가능성이 있는 요청 타입만 본다(media/xhr/other/object).
 * 단, 새 페이지 감지(목록 리셋)는 main_frame 도 봐야 하므로 (1) 에만 포함. */
const MEDIA_TYPES = ['media', 'xmlhttprequest', 'other', 'object'];
const FILTER_MEDIA = { urls: ['<all_urls>'], types: MEDIA_TYPES };
const FILTER_BEFORE = { urls: ['<all_urls>'], types: ['main_frame', ...MEDIA_TYPES] };

// (1) 요청 시작: URL·탭·페이지 기록. (main_frame 은 새 페이지 → 목록 리셋)
chrome.webRequest.onBeforeRequest.addListener((d) => {
  if (d.tabId < 0) return;                                   // 탭에 속하지 않는 요청 무시
  if (d.type === 'main_frame') { clearTab(String(d.tabId)); return; }

  if (Object.keys(pending).length > PENDING_CAP) pending = {};  // 누수 방지(완료 못 받은 요청 정리)
  pending[d.requestId] = {
    url: d.url, tabId: d.tabId, type: d.type,
    pageUrl: d.documentUrl || d.initiator || ''
  };
}, FILTER_BEFORE);

// (2) 요청 헤더 전송 직전: 실제 Referer/Origin/Cookie/User-Agent 캡처 (extraHeaders 필수!)
chrome.webRequest.onBeforeSendHeaders.addListener((d) => {
  const p = pending[d.requestId];
  if (p) p.reqHeaders = headersArrayToObject(d.requestHeaders);
}, FILTER_MEDIA, ['requestHeaders', 'extraHeaders']);

// (3) 응답 헤더 수신: Content-Type/Length 로 최종 판정 후 확정
chrome.webRequest.onHeadersReceived.addListener((d) => {
  const p = pending[d.requestId];
  if (!p) return;
  const resp = headersArrayToObject(d.responseHeaders);
  const contentType = resp['content-type'] || '';
  const len = parseInt(resp['content-length'] || '0', 10) || 0;

  const type = classify(p.url, contentType);
  delete pending[d.requestId];                              // 판정 끝났으니 버퍼 비움

  if (!type || type === 'segment') return;                  // 미디어 아님/세그먼트 → 제외

  // 프로그레시브 파일(mp4/webm)은 너무 작으면(광고 비콘/짧은 세그먼트) 제외
  if ((type === 'mp4' || type === 'webm') && len > 0 && len < 300 * 1024) return;

  addStream({
    id: makeId(p.url),
    url: p.url,
    type,                                                   // hls | dash | mp4 | webm
    tabId: p.tabId,
    pageUrl: p.pageUrl,
    contentType,
    size: len || 0,
    headers: curateHeaders(p.reqHeaders || {})              // ★ 다운로드에 그대로 넘길 헤더
  });
}, FILTER_MEDIA, ['responseHeaders', 'extraHeaders']);

// 정리: 완료/실패 시 남은 버퍼 제거
chrome.webRequest.onCompleted.addListener((d) => { delete pending[d.requestId]; }, FILTER_MEDIA);
chrome.webRequest.onErrorOccurred.addListener((d) => { delete pending[d.requestId]; }, FILTER_MEDIA);

/* ---------- 탭 정리 / 팝업 메시지 API ---------- */

chrome.tabs.onRemoved.addListener((tabId) => clearTab(String(tabId)));

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;

  // offscreen → background 진행률
  if (msg.target === 'background' && msg.cmd === 'ib_progress') {
    ibSetJob(msg.id, { status: msg.phase, percent: Math.round((msg.ratio || 0) * 100) });
    return;
  }
  if (!msg.cmd) return;

  switch (msg.cmd) {
    case 'getStreams':
      sendResponse({ streams: tabStreams[String(msg.tabId)] || [] });
      return true;
    case 'clearStreams':
      clearTab(String(msg.tabId));
      sendResponse({ ok: true });
      return true;

    // ----- 브라우저 내 처리 (헬퍼 없이) -----
    case 'ibVariants':            // HLS 화질 변형 목록
      ensureOffscreen()
        .then(() => chrome.runtime.sendMessage({ target: 'offscreen', cmd: 'variants', url: msg.url, headers: msg.headers }))
        .then((r) => sendResponse(r || { error: '응답 없음' }))
        .catch((e) => sendResponse({ error: String(e.message || e) }));
      return true;

    case 'ibDownload':            // HLS 다운로드(offscreen 엔진)
      sendResponse({ id: startIbHls(msg) });
      return true;

    case 'ibProgressive':         // 단순 mp4/webm → chrome.downloads 로 바로
      sendResponse({ id: startIbProgressive(msg) });
      return true;

    case 'ibClearFinished':
      for (const id of Object.keys(ibjobsMem)) {
        if (['done', 'error', 'canceled'].includes(ibjobsMem[id].status)) delete ibjobsMem[id];
      }
      ibPersist();
      sendResponse({ ok: true });
      return true;

    case 'ibJobs':
      sendResponse({ jobs: Object.values(ibjobsMem) });
      return true;

    // ----- 헬퍼(yt-dlp) 프록시: 페이지 영상 정보/다운로드/진행률 -----
    case 'pageProbe':           // 현재 페이지를 yt-dlp 로 분석 → 썸네일/제목/화질
      helperJSON('/probe', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: msg.url, headers: {} }) })
        .then((r) => sendResponse(r)).catch(() => sendResponse({ error: 'helper' }));
      return true;

    case 'pageDownload':        // 페이지 주소를 yt-dlp 로 다운로드 (YouTube 등)
      helperJSON('/download', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: msg.url, type: 'page', headers: {}, title: msg.title || '', format: msg.format || '' }) })
        .then((r) => sendResponse(r)).catch(() => sendResponse({ error: 'helper' }));
      return true;

    case 'helperJobs':          // 헬퍼 작업 목록(진행률 폴링용)
      helperJSON('/jobs').then((r) => sendResponse(r)).catch(() => sendResponse({ jobs: [] }));
      return true;
  }
});

async function helperBase() {
  const c = await chrome.storage.local.get(['helperUrl']);
  return (c.helperUrl || 'http://127.0.0.1:8787').replace(/\/+$/, '');
}
async function helperJSON(path, opts) {
  const r = await fetch((await helperBase()) + path, opts);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

/* ---------- 브라우저 내 다운로드 오케스트레이션 ---------- */

function ibPersist() { chrome.storage.session.set({ ibjobs: ibjobsMem }).catch(() => {}); }
function ibSetJob(id, patch) {
  ibjobsMem[id] = Object.assign(ibjobsMem[id] || { id }, patch);
  ibPersist();
}
function makeJobId() { return 'ib' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36); }
function sanitizeName(s) {
  return (String(s || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 150)) || 'video';
}

// offscreen 문서 보장(없으면 생성). HLS 합치기는 Blob/DOM 이 필요해 여기서 처리.
let offscreenCreating = null;
async function ensureOffscreen() {
  const has = await chrome.offscreen.hasDocument();
  if (has) return;
  if (offscreenCreating) { await offscreenCreating; return; }
  offscreenCreating = chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['BLOBS'],
    justification: 'HLS 세그먼트를 받아 mp4 로 합쳐 저장(브라우저 내 처리).',
  });
  try { await offscreenCreating; } finally { offscreenCreating = null; }
}

function startIbHls(msg) {
  const id = makeJobId();
  ibSetJob(id, { id, title: msg.title || '', status: 'downloading', percent: 0, speed: '', eta: null, filename: '', error: '' });
  ensureOffscreen()
    .then(() => chrome.runtime.sendMessage({ target: 'offscreen', cmd: 'download', id, mediaUrl: msg.mediaUrl, headers: msg.headers }))
    .then((res) => {
      if (!res || res.error) { ibSetJob(id, { status: 'error', error: (res && res.error) || '엔진 무응답' }); return; }
      const filename = sanitizeName(msg.title) + '.' + res.ext;
      ibSetJob(id, { status: 'merging', percent: 100 });
      chrome.downloads.download({ url: res.blobUrl, filename, saveAs: false }, (dlId) => {
        if (chrome.runtime.lastError || dlId === undefined) {
          // 폴백: offscreen 에서 a 클릭으로 저장 (chrome.downloads 가 blob URL 거부 시)
          chrome.runtime.sendMessage({ target: 'offscreen', cmd: 'save', id, filename })
            .then((r) => ibSetJob(id, r && r.ok ? { status: 'done', percent: 100, filename }
                                                : { status: 'error', error: (r && r.error) || '저장 실패' }))
            .catch((e) => ibSetJob(id, { status: 'error', error: String(e.message || e) }));
        } else {
          ibSetJob(id, { status: 'done', percent: 100, filename });
        }
        setTimeout(() => chrome.runtime.sendMessage({ target: 'offscreen', cmd: 'revoke', id }).catch(() => {}), 60000);
      });
    })
    .catch((e) => ibSetJob(id, { status: 'error', error: String(e.message || e) }));
  return id;
}

function startIbProgressive(msg) {
  const id = makeJobId();
  const filename = sanitizeName(msg.title) + '.' + (msg.ext || 'mp4');
  ibSetJob(id, { id, title: msg.title || '', status: 'downloading', percent: 0, speed: '', eta: null, filename, error: '' });
  chrome.downloads.download({ url: msg.url, filename, saveAs: false }, (dlId) => {
    if (chrome.runtime.lastError) { ibSetJob(id, { status: 'error', error: chrome.runtime.lastError.message }); return; }
    ibDownloadMap[dlId] = id;
  });
  return id;
}

// chrome.downloads 상태로 progressive 작업 진행률/완료 갱신
chrome.downloads.onChanged.addListener((delta) => {
  const id = ibDownloadMap[delta.id];
  if (!id) return;
  if (delta.state) {
    if (delta.state.current === 'complete') ibSetJob(id, { status: 'done', percent: 100 });
    else if (delta.state.current === 'interrupted') ibSetJob(id, { status: 'error', error: '다운로드 중단됨' });
  }
});
