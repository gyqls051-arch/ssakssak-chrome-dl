/* =============================================================================
 * 싹싹김치 — popup (UI + 다운로드 요청 + 진행률 표시)
 * -----------------------------------------------------------------------------
 *  - 감지된 스트림 목록: background 가 storage.session 에 넣어둔 걸 읽어 표시
 *  - 다운로드 버튼: { url, headers, title, type } 을 로컬 헬퍼로 POST
 *  - 진행률: 헬퍼 /jobs 를 주기적으로 폴링해서 표시
 *  - 헬퍼 연결 상태 / ffmpeg 유무 배너
 * ========================================================================== */

'use strict';

const $ = (id) => document.getElementById(id);
let activeTabId = null;
let pageMeta = { title: '', ogImage: '' };
let helperOn = false;     // 헬퍼 연결 상태 — 켜져 있으면 모든 다운로드를 헬퍼(yt-dlp)로

/* ---------- 헬퍼 통신 ---------- */

async function api(path, opts = {}) {
  return SsakHelper.request(path, opts);
}

/* ---------- 초기화 ---------- */

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTabId = tab ? tab.id : null;

  // 페이지 메타(제목/썸네일) — content script 가 없으면 탭 정보로 대체
  pageMeta = { title: tab ? tab.title : '', ogImage: '' };
  try {
    const m = await chrome.tabs.sendMessage(activeTabId, { cmd: 'getPageMeta' });
    if (m) pageMeta = { title: m.title || pageMeta.title, ogImage: m.ogImage || '' };
  } catch { /* 제한 페이지(chrome:// 등)에선 무시 */ }

  await renderStreams();
  maybeProbePage(tab);                       // YouTube 등이면 자동 분석해 영상 카드 표시

  // 스트림이 실시간으로 추가되면 즉시 반영
  chrome.storage.session.onChanged.addListener((changes) => {
    if (changes['streams:' + activeTabId]) renderStreams();
  });

  $('clear-btn').onclick = async () => {
    await chrome.runtime.sendMessage({ cmd: 'clearStreams', tabId: activeTabId });
    renderStreams();
  };
  $('open-options').onclick = () => chrome.runtime.openOptionsPage();
  $('warn-options').onclick = (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); };
  $('open-folder').onclick = async () => { try { await api('/open', { method: 'POST' }); } catch {} };
  $('page-dl-btn').onclick = (e) => startPageDownload(e.target);
  $('clear-finished').onclick = async () => {
    try { await bg({ cmd: 'ibClearFinished' }); } catch {}
    try { await api('/clear-finished', { method: 'POST' }); } catch {}
    tick();
  };

  tick();
  setInterval(tick, 1500);   // 헬퍼 상태 + 다운로드 진행률 폴링
}

/* ---------- 스트림 목록 렌더 ---------- */

async function renderStreams() {
  const data = await chrome.storage.session.get('streams:' + activeTabId);
  const streams = data['streams:' + activeTabId] || [];
  $('stream-count').textContent = streams.length;

  const box = $('streams');
  if (!streams.length) {
    box.innerHTML = '';
    box.appendChild($('streams-empty') || emptyNode('streams-empty', '감지된 스트림이 없습니다.'));
    $('streams-empty').classList.remove('hidden');
    return;
  }
  box.innerHTML = '';
  for (const s of streams) box.appendChild(streamCard(s));
}

function streamCard(s) {
  const card = document.createElement('div');
  card.className = 'card';

  const title = pageMeta.title || urlName(s.url) || '제목 없음';
  // MV3 CSP 는 인라인 이벤트 핸들러(onerror=...)를 막으므로 JS 로 붙인다.
  const thumb = pageMeta.ogImage
    ? `<img class="thumb" src="${escapeAttr(pageMeta.ogImage)}" alt="">`
    : `<div class="thumb"></div>`;

  card.innerHTML = `
    ${thumb}
    <div class="card-body">
      <div class="card-title" title="${escapeAttr(title)}">${escapeHtml(title)}</div>
      <div class="card-meta">
        <span class="tag tag-${s.type}">${s.type}</span>
        ${s.size ? `<span class="size">${fmtSize(s.size)}</span>` : ''}
      </div>
      <div class="card-url" title="${escapeAttr(s.url)}">${escapeHtml(shortUrl(s.url))}</div>
      <div class="q-row hidden"></div>
    </div>
    <div class="card-actions"><button class="dl-btn">다운로드</button></div>
  `;

  const img = card.querySelector('img.thumb');
  if (img) img.onerror = () => { img.style.visibility = 'hidden'; };
  card.querySelector('.dl-btn').onclick = (e) => onDownloadClick(s, card, e.target);
  return card;
}

const bg = (msg) => chrome.runtime.sendMessage(msg);
const titleFor = (s) => pageMeta.title || urlName(s.url) || '';

/* ---------- 이 페이지 영상 (경쟁사처럼 카드로 바로 표시) ----------
 * YouTube 등 yt-dlp 지원 페이지면 헬퍼로 자동 분석해서 썸네일·제목·화질·다운로드를 보여준다. */
function isSupportedVideoPage(url) {
  try {
    const u = new URL(url);
    if (u.hostname === 'youtu.be') return u.pathname.length > 1;
    if (/(^|\.)youtube\.com$/.test(u.hostname))
      return u.pathname === '/watch' || u.pathname.startsWith('/shorts/') || u.pathname.startsWith('/embed/');
    return false;
  } catch { return false; }
}

async function maybeProbePage(tab) {
  if (!tab || !isSupportedVideoPage(tab.url)) return;
  const sec = $('page-video-sec'), box = $('page-video');
  sec.classList.remove('hidden');
  box.innerHTML = '<div class="empty">영상 분석 중…</div>';

  // 1) 헬퍼가 켜져 있으면 헬퍼(yt-dlp)로 전체 화질 조회 → 1080p/720p/… 선택 가능
  let info = null;
  try { info = await bg({ cmd: 'pageProbe', url: tab.url }); } catch { info = null; }
  if (info && !info.error && (info.formats || []).length) {
    box.innerHTML = '';
    box.appendChild(helperVideoCard(info, tab));
    return;
  }
  if (info && /DRM/.test(info.error || '')) {
    box.innerHTML = '<div class="q-note">DRM 보호 콘텐츠는 지원하지 않습니다.</div>';
    return;
  }

  // 2) 헬퍼 없음/실패 → 브라우저 내 muxed(360p 등) 추출로 폴백
  let yt = null;
  try { yt = await chrome.tabs.sendMessage(tab.id, { cmd: 'ytExtract' }); } catch { yt = null; }
  box.innerHTML = '';
  box.appendChild(ytCard(yt, tab));
}

// 헬퍼(yt-dlp) 조회 결과로 풀 화질 선택 카드를 만든다 (1080p/720p/480p/…)
function helperVideoCard(info, tab) {
  const card = document.createElement('div');
  card.className = 'card';
  const title = info.title || tab.title || '영상';
  const thumb = info.thumbnail
    ? `<img class="thumb" src="${escapeAttr(info.thumbnail)}" alt="">`
    : `<div class="thumb"></div>`;
  const meta = [info.duration ? fmtDur(info.duration) : '', info.uploader || ''].filter(Boolean);
  card.innerHTML = `
    ${thumb}
    <div class="card-body">
      <div class="card-title" title="${escapeAttr(title)}">${escapeHtml(title)}</div>
      <div class="card-meta">${meta.map((m) => `<span class="size">${escapeHtml(m)}</span>`).join('')}</div>
      <div class="q-row"></div>
    </div>
    <div class="card-actions"><button class="dl-btn">다운로드</button></div>`;
  const img = card.querySelector('img.thumb');
  if (img) img.onerror = () => { img.style.visibility = 'hidden'; };

  const row = card.querySelector('.q-row');
  const sel = document.createElement('select');
  sel.className = 'q-select';
  sel.appendChild(new Option('최고화질(자동)', ''));
  for (const f of (info.formats || [])) sel.appendChild(new Option(f.label, f.selector));
  row.appendChild(sel);

  card.querySelector('.dl-btn').onclick = (e) => {
    const btn = e.target; btn.disabled = true; btn.textContent = '요청…';
    bg({ cmd: 'pageDownload', url: tab.url, title: info.title || '', format: sel.value })
      .then((r) => {
        if (!r || r.error || !r.jobId) { btn.disabled = false; btn.textContent = '다운로드'; row.insertAdjacentHTML('beforeend', '<span class="q-note">헬퍼 오류</span>'); }
        else { btn.textContent = '대기열 ✓'; tick(); }
      })
      .catch(() => { btn.disabled = false; btn.textContent = '다운로드'; });
  };
  return card;
}

function fmtDur(s) {
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return (h ? h + ':' : '') + String(m).padStart(h ? 2 : 1, '0') + ':' + String(x).padStart(2, '0');
}

function ytCard(yt, tab) {
  const card = document.createElement('div');
  card.className = 'card';
  const title = (yt && yt.title) || tab.title || '영상';
  const thumb = (yt && yt.thumbnail)
    ? `<img class="thumb" src="${escapeAttr(yt.thumbnail)}" alt="">`
    : `<div class="thumb"></div>`;
  card.innerHTML = `
    ${thumb}
    <div class="card-body">
      <div class="card-title" title="${escapeAttr(title)}">${escapeHtml(title)}</div>
      <div class="card-meta"></div>
      <div class="q-row"></div>
    </div>
    <div class="card-actions"><button class="dl-btn">다운로드</button></div>`;
  const img = card.querySelector('img.thumb');
  if (img) img.onerror = () => { img.style.visibility = 'hidden'; };

  const formats = (yt && yt.formats) || [];
  const row = card.querySelector('.q-row');
  const sel = document.createElement('select');
  sel.className = 'q-select';
  formats.forEach((f, i) => sel.appendChild(new Option(f.label, 'd' + i)));   // 직링크 muxed(헬퍼 없이)
  sel.appendChild(new Option('고화질·기타 — 헬퍼로', 'h'));                    // 헬퍼 폴백
  row.appendChild(sel);

  card.querySelector('.dl-btn').onclick = (e) => {
    const btn = e.target; btn.disabled = true; btn.textContent = '요청…';
    const done = (ok, note) => {
      btn.disabled = ok; btn.textContent = ok ? '대기열 ✓' : '다운로드';
      if (ok) tick();
      else if (note) row.insertAdjacentHTML('beforeend', `<span class="q-note">${note}</span>`);
    };
    if (sel.value === 'h') {
      bg({ cmd: 'pageDownload', url: tab.url, title: (yt && yt.title) || '' })
        .then((r) => done(!!(r && r.jobId), '헬퍼가 꺼져 있어요 — install_autostart.bat 한 번 실행'))
        .catch(() => done(false));
    } else {
      const f = formats[+sel.value.slice(1)];
      bg({ cmd: 'ibProgressive', url: f.url, title: (yt && yt.title) || title, ext: 'mp4' })
        .then((r) => done(!!(r && r.id))).catch(() => done(false));
    }
  };
  return card;
}

/* ---------- 다운로드 라우팅 (하이브리드) ----------
 *  - hls       : 브라우저 안에서 화질 목록 조회 → 선택 → 엔진으로 받기 (헬퍼 X)
 *  - mp4/webm  : 브라우저에서 바로 받기 (헬퍼 X)
 *  - dash      : 헬퍼로 (브라우저 처리 어려움)
 *  어떤 경우든 안 되면 '헬퍼로 받기' 폴백 제공. */
async function onDownloadClick(stream, card, btn) {
  // 헬퍼가 켜져 있으면 전부 헬퍼(yt-dlp)로 — 형식 상관없이 가장 안정적 (DASH 포함)
  if (helperOn) return chooseQualityHelper(stream, card, btn);
  // 헬퍼 OFF: HLS/MP4 는 브라우저로, DASH 는 헬퍼 필요
  if (stream.type === 'hls') return chooseQualityInBrowser(stream, card, btn);
  if (stream.type === 'dash') return chooseQualityHelper(stream, card, btn);
  // progressive (mp4/webm) → 브라우저에서 바로
  btn.disabled = true; btn.textContent = '받는 중…';
  try {
    await bg({ cmd: 'ibProgressive', url: stream.url, title: titleFor(stream), ext: stream.type === 'webm' ? 'webm' : 'mp4' });
    btn.textContent = '시작됨 ✓'; tick();
  } catch {
    btn.disabled = false; btn.textContent = '다운로드'; showNote(card, '실패 — 아래 헬퍼로 시도하세요.');
  }
  addHelperFallback(card, stream);
}

// HLS: 브라우저 안에서 화질 변형 목록을 받아 고르게 한다 (헬퍼 불필요)
async function chooseQualityInBrowser(stream, card, btn) {
  btn.disabled = true; btn.textContent = '화질 확인…';
  let res;
  try { res = await bg({ cmd: 'ibVariants', url: stream.url, headers: stream.headers || {} }); }
  catch { res = { error: '엔진 오류' }; }

  if (!res || res.error) {
    btn.disabled = false; btn.textContent = '다운로드';
    showNote(card, res && /DRM/.test(res.error) ? res.error : '브라우저 처리 실패 — 아래 헬퍼로 시도하세요.');
    addHelperFallback(card, stream);
    return;
  }
  const variants = res.variants || [];
  const start = (mediaUrl) => startIbHls(stream, card, mediaUrl);
  if (variants.length <= 1) { start(variants[0] ? variants[0].url : stream.url); return; }

  btn.style.display = 'none';
  const row = card.querySelector('.q-row');
  row.classList.remove('hidden'); row.innerHTML = '';
  const sel = document.createElement('select');
  sel.className = 'q-select';
  for (const v of variants) sel.appendChild(new Option(v.label, v.url));   // 화질 높은 순
  const go = document.createElement('button');
  go.className = 'dl-btn small'; go.textContent = '받기';
  go.onclick = () => { go.disabled = true; start(sel.value); };
  row.appendChild(sel); row.appendChild(go);
  addHelperFallback(card, stream);
}

async function startIbHls(stream, card, mediaUrl) {
  try { await bg({ cmd: 'ibDownload', mediaUrl, headers: stream.headers || {}, title: titleFor(stream) }); tick(); }
  catch { showNote(card, '실패 — 아래 헬퍼로 시도하세요.'); }
}

// DASH/폴백: 헬퍼로 화질 조회 후 받기 (yt-dlp)
async function chooseQualityHelper(stream, card, btn) {
  btn.disabled = true; btn.textContent = '화질 확인…';
  let res;
  try {
    res = await api('/probe', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: stream.url, headers: stream.headers || {} }) });
  } catch {
    btn.disabled = false; btn.textContent = '다운로드';
    showNote(card, '헬퍼가 꺼져 있습니다. 헬퍼를 켜거나 다른 스트림을 받으세요.');
    return;
  }
  if (res.error) { btn.disabled = false; btn.textContent = '다운로드'; showNote(card, res.error); return; }
  const fmts = res.formats || [];
  if (fmts.length <= 1) return startDownload(stream, btn, '');

  btn.style.display = 'none';
  const row = card.querySelector('.q-row');
  row.classList.remove('hidden'); row.innerHTML = '';
  const sel = document.createElement('select');
  sel.className = 'q-select';
  sel.appendChild(new Option('최고화질(자동)', ''));
  for (const f of fmts) sel.appendChild(new Option(f.label, f.selector));
  const go = document.createElement('button');
  go.className = 'dl-btn small'; go.textContent = '받기';
  go.onclick = () => startDownload(stream, go, sel.value);
  row.appendChild(sel); row.appendChild(go);
}

function addHelperFallback(card, stream) {
  if (card.querySelector('.helper-fallback')) return;
  const a = document.createElement('a');
  a.href = '#'; a.className = 'helper-fallback'; a.textContent = '안 되면: 헬퍼로 받기';
  a.onclick = (e) => { e.preventDefault(); a.remove(); chooseQualityHelper(stream, card, card.querySelector('.dl-btn')); };
  card.querySelector('.card-body').appendChild(a);
}

function showNote(card, text) {
  const row = card.querySelector('.q-row');
  row.classList.remove('hidden');
  row.innerHTML = `<span class="q-note">${escapeHtml(text)}</span>`;
}

// 현재 탭 주소를 통째로 yt-dlp(헬퍼)에 넘긴다. YouTube 등 sniffing 안 되는 사이트용.
async function startPageDownload(btn) {
  btn.disabled = true;
  btn.textContent = '요청…';
  $('page-note').textContent = '';
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    await api('/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: tab.url, type: 'page', headers: {}, title: tab.title || '', format: '' })
    });
    btn.textContent = '대기열 ✓';
    tick();
  } catch {
    btn.disabled = false;
    btn.textContent = '이 페이지 받기';
    $('page-note').textContent = '헬퍼(yt-dlp)를 켜야 합니다. YouTube 등은 헬퍼로만 받을 수 있어요. → helper/start_helper.bat 실행';
  }
}

/* ---------- 다운로드 요청 ---------- */

async function startDownload(stream, btn, format) {
  btn.disabled = true;
  btn.textContent = '요청…';
  try {
    await api('/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: stream.url,
        type: stream.type,
        headers: stream.headers || {},
        title: pageMeta.title || urlName(stream.url) || '',
        format: format || ''                       // 화질 selector (빈값=best 자동)
      })
    });
    btn.disabled = true;
    btn.textContent = '대기열 ✓';
    tick();   // 즉시 진행률 갱신
  } catch (e) {
    btn.disabled = false;
    btn.textContent = '실패 · 재시도';
    setHelperStatus(false);
  }
}

/* ---------- 헬퍼 상태 + 진행률 폴링 ---------- */

async function tick() {
  // 1) 브라우저 내 작업 (헬퍼와 무관하게 항상)
  let ibJobs = [];
  try { const r = await bg({ cmd: 'ibJobs' }); ibJobs = (r && r.jobs) || []; } catch { /* 무시 */ }

  // 2) 헬퍼 상태 + 헬퍼 작업 (있으면 보너스, 없어도 정상)
  let helperJobs = [], helperOk = false;
  try {
    const h = await api('/health');
    helperOk = true;
    $('ffmpeg-warn').classList.toggle('hidden', !!h.ffmpeg);
    try { const r = await api('/jobs'); helperJobs = r.jobs || []; } catch { /* 무시 */ }
  } catch {
    $('ffmpeg-warn').classList.add('hidden');
  }
  setHelperStatus(helperOk);
  renderJobs([...ibJobs, ...helperJobs]);
}

function setHelperStatus(ok) {
  helperOn = ok;     // 켜져 있으면 onDownloadClick 이 전부 헬퍼로 보냄
  const pill = $('helper-status');
  pill.textContent = ok ? '헬퍼 연결됨' : '브라우저 모드';
  pill.className = 'pill ' + (ok ? 'pill-on' : 'pill-off');
  $('helper-warn').classList.add('hidden');
}

function renderJobs(jobs) {
  const box = $('jobs');
  if (!jobs.length) {
    box.innerHTML = '<div class="empty" id="jobs-empty">진행 중인 다운로드가 없습니다.</div>';
    return;
  }
  box.innerHTML = '';
  for (const j of jobs) box.appendChild(jobCard(j));
}

function jobCard(j) {
  const el = document.createElement('div');
  el.className = 'job ' + (j.status === 'done' ? 'done' : j.status === 'error' ? 'error' : '');
  const pct = Math.max(0, Math.min(100, j.percent || (j.status === 'done' ? 100 : 0)));
  const stageText = {
    queued: '대기 중', downloading: '다운로드 중', merging: '합치는 중',
    done: '완료', error: '실패', canceled: '취소됨'
  }[j.status] || j.status;

  el.innerHTML = `
    <div class="job-top">
      <span class="job-title" title="${escapeAttr(j.title || '')}">${escapeHtml(j.title || j.url || '')}</span>
      <span class="job-stage">${stageText}</span>
    </div>
    <div class="bar"><i style="width:${pct}%"></i></div>
    <div class="job-info">
      <span>${pct ? pct.toFixed(1) + '%' : ''} ${j.speed ? '· ' + j.speed : ''}</span>
      <span>${j.eta != null && j.status === 'downloading' ? 'ETA ' + j.eta + 's' : (j.filename ? j.filename : '')}</span>
    </div>
    ${j.error ? `<div class="job-err">${escapeHtml(j.error)}</div>` : ''}
  `;
  return el;
}

/* ---------- 작은 유틸 ---------- */

function urlName(url) {
  try {
    const p = new URL(url).pathname.split('/').filter(Boolean).pop() || '';
    return decodeURIComponent(p.split('.')[0] || '');
  } catch { return ''; }
}
function shortUrl(url) {
  try { const u = new URL(url); return u.host + (u.pathname.length > 28 ? u.pathname.slice(0, 28) + '…' : u.pathname); }
  catch { return url.slice(0, 48); }
}
function fmtSize(b) {
  if (b > 1e9) return (b / 1e9).toFixed(2) + ' GB';
  if (b > 1e6) return (b / 1e6).toFixed(1) + ' MB';
  if (b > 1e3) return (b / 1e3).toFixed(0) + ' KB';
  return b + ' B';
}
function escapeHtml(s) { return String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
function escapeAttr(s) { return String(s).replace(/"/g, '&quot;').replace(/</g, '&lt;'); }
function emptyNode(id, text) { const d = document.createElement('div'); d.className = 'empty'; d.id = id; d.textContent = text; return d; }

init();
