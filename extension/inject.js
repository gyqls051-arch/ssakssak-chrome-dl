/* =============================================================================
 * 싹싹김치 — inject.js (유튜브: 페이지에 다운로드 버튼 + 브라우저 내 추출)
 * -----------------------------------------------------------------------------
 * 1) 유튜브 watch 페이지의 ytInitialPlayerResponse 에서 '직링크(url)가 박힌'
 *    muxed 포맷(보통 360p)을 뽑아 헬퍼 없이 바로 받는다.
 * 2) 고화질(1080p 등, 암호서명/분리스트림)은 헬퍼(yt-dlp)로 폴백.
 * 3) 팝업이 'ytExtract' 로 물어보면 같은 추출 결과를 돌려준다.
 * ========================================================================== */
'use strict';

(function () {
  if (window.__ssakInjected) return;
  window.__ssakInjected = true;

  /* ---------- ytInitialPlayerResponse 추출 ---------- */
  // 중괄호 균형으로 JSON 객체만 안전하게 잘라낸다(정규식보다 견고).
  function extractJSONAfter(text, key) {
    let i = text.indexOf(key);
    if (i < 0) return null;
    i = text.indexOf('{', i);
    if (i < 0) return null;
    let depth = 0, inStr = false, esc = false;
    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}') {
        if (--depth === 0) { try { return JSON.parse(text.slice(i, j + 1)); } catch { return null; } }
      }
    }
    return null;
  }

  // 현재 영상의 '바로 받을 수 있는' 포맷 목록을 만든다.
  async function getMuxedFormats() {
    try {
      const html = await (await fetch(location.href, { credentials: 'include' })).text();
      const pr = extractJSONAfter(html, 'ytInitialPlayerResponse');
      if (!pr || !pr.streamingData) return { error: 'no-data' };
      const vd = pr.videoDetails || {};
      const title = (vd.title || document.title.replace(/\s*-\s*YouTube\s*$/, '')).trim();
      const thumbs = (vd.thumbnail && vd.thumbnail.thumbnails) || [];
      const thumbnail = thumbs.length ? thumbs[thumbs.length - 1].url : '';

      const list = [];
      // streamingData.formats = 영상+소리가 합쳐진(muxed) 포맷. url 이 직접 있으면 바로 받기 가능.
      for (const f of (pr.streamingData.formats || [])) {
        if (!f.url) continue;                         // 암호서명만 있는 건 제외(헬퍼 필요)
        const q = f.qualityLabel || (f.height ? f.height + 'p' : f.quality || '?');
        list.push({ label: `${q} · mp4 (헬퍼 없이)`, url: f.url, height: f.height || 0, bytes: Number(f.contentLength || 0) });
      }
      list.sort((a, b) => b.height - a.height);
      return { title, thumbnail, formats: list };
    } catch (e) { return { error: String(e.message || e) }; }
  }

  // 팝업 → content script 추출 요청
  chrome.runtime.onMessage.addListener((msg, sender, send) => {
    if (msg && msg.cmd === 'ytExtract') { getMuxedFormats().then(send); return true; }
  });

  /* ---------- 페이지 위 플로팅 버튼 UI ---------- */
  function isVideoPage() {
    const h = location.hostname, p = location.pathname;
    if (h.endsWith('youtu.be')) return p.length > 1;
    if (h.endsWith('youtube.com')) return p === '/watch' || p.startsWith('/shorts/') || p.startsWith('/embed/');
    return false;
  }
  const cleanTitle = () => (document.title || '').replace(/\s*-\s*YouTube\s*$/, '').trim();

  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:2147483647;';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>
      * { box-sizing:border-box; font-family:"Segoe UI","Malgun Gothic",system-ui,sans-serif; }
      .wrap { display:flex; flex-direction:column; align-items:flex-end; gap:8px; }
      .btn { display:flex; align-items:center; gap:7px; cursor:pointer; border:none; background:#1f6feb;
             color:#fff; font-size:14px; font-weight:700; padding:11px 16px; border-radius:999px;
             box-shadow:0 4px 14px rgba(0,0,0,.35); }
      .btn:hover { background:#388bfd; }
      .panel { max-width:300px; background:#161b22; color:#e6edf3; border:1px solid #30363d;
               border-radius:12px; padding:10px; box-shadow:0 6px 18px rgba(0,0,0,.4); font-size:12.5px; }
      .panel.hidden { display:none; }
      .mh { color:#8b949e; font-size:11px; margin:6px 2px 4px; }
      .opt { display:block; width:100%; text-align:left; cursor:pointer; margin:3px 0; padding:8px 10px;
             border:1px solid #30363d; border-radius:8px; background:#1c2330; color:#e6edf3; font-size:12.5px; }
      .opt:hover { border-color:#388bfd; }
      .opt.hp { background:#1f6feb; border-color:#1f6feb; color:#fff; font-weight:600; }
      .status { font-size:12px; margin:6px 2px 2px; }
      .status.err { color:#ff7b72; } .status.ok { color:#7ee787; }
      .bar { height:5px; background:#0d1117; border-radius:999px; overflow:hidden; margin-top:6px; }
      .bar > i { display:block; height:100%; width:0; background:#1f6feb; transition:width .3s; }
    </style>
    <div class="wrap">
      <div class="panel hidden" id="panel"></div>
      <button class="btn" id="dl"><span style="font-size:16px">⬇</span><span>다운로드</span></button>
    </div>`;
  document.documentElement.appendChild(host);

  const panel = root.getElementById('panel');
  root.getElementById('dl').onclick = openMenu;

  function refresh() { host.style.display = isVideoPage() ? 'block' : 'none'; }
  refresh(); setInterval(refresh, 1000);

  function setPanel(html) { panel.className = 'panel'; panel.innerHTML = html; }
  function status(msg, cls, withBar, pct) {
    setPanel(`<div class="status ${cls || ''}">${msg}</div>` +
             (withBar ? `<div class="bar"><i style="width:${pct || 0}%"></i></div>` : ''));
  }

  async function openMenu() {
    status('영상 분석 중…');
    const res = await getMuxedFormats();
    let html = '';
    if (res && res.formats && res.formats.length) {
      html += `<div class="mh">바로 받기 (설치 없이)</div>`;
      res.formats.forEach((f, i) => { html += `<button class="opt" data-i="${i}">${f.label}</button>`; });
    } else {
      html += `<div class="mh">직접 받을 수 있는 화질이 없어요(암호화됨).</div>`;
    }
    html += `<div class="mh">고화질·기타는 헬퍼(yt-dlp)로</div><button class="opt hp">헬퍼로 받기 (모든 화질)</button>`;
    setPanel(html);
    panel.querySelectorAll('.opt').forEach((b) => {
      b.onclick = () => {
        if (b.classList.contains('hp')) startHelper(res && res.title);
        else startDirect(res.formats[+b.dataset.i], res && res.title);
      };
    });
  }

  // 직링크(muxed) → chrome.downloads 로 바로 (헬퍼 없이)
  async function startDirect(f, title) {
    status('다운로드 시작…', '', true, 0);
    let r;
    try { r = await chrome.runtime.sendMessage({ cmd: 'ibProgressive', url: f.url, title: title || cleanTitle(), ext: 'mp4' }); }
    catch { r = null; }
    if (!r || r.error || !r.id) return status('실패 — 헬퍼로 시도해보세요.', 'err');
    poll('ibJobs', r.id);
  }

  // 헬퍼(yt-dlp) → 페이지 주소 통째로 (고화질 가능)
  async function startHelper(title) {
    status('헬퍼로 요청…');
    let r;
    try { r = await chrome.runtime.sendMessage({ cmd: 'pageDownload', url: location.href, title: title || cleanTitle() }); }
    catch { r = null; }
    if (!r || r.error || !r.jobId)
      return status('헬퍼가 꺼져 있어요. helper의 <b>install_autostart.bat</b> 한 번 실행.', 'err');
    poll('helperJobs', r.jobId);
  }

  function poll(source, id) {
    const t = setInterval(async () => {
      let jobs = [];
      try { const r = await chrome.runtime.sendMessage({ cmd: source }); jobs = (r && r.jobs) || []; }
      catch { return; }
      const j = jobs.find((x) => x.id === id);
      if (!j) return;
      if (j.status === 'downloading') status(`다운로드 중 ${Math.round(j.percent || 0)}%`, '', true, j.percent || 0);
      else if (j.status === 'merging') status('합치는 중…', '', true, 100);
      else if (j.status === 'done') { status('완료 ✓ 다운로드 폴더 확인', 'ok'); clearInterval(t); }
      else if (j.status === 'error') { status('실패: ' + (j.error || ''), 'err'); clearInterval(t); }
    }, 1500);
  }
})();
