/* =============================================================================
 * 싹싹김치 — offscreen 문서 스크립트 (브라우저 안 HLS 다운로드 엔진 실행부)
 * -----------------------------------------------------------------------------
 * background(서비스워커)가 보낸 작업을 받아 HlsEngine 으로 처리한다.
 *  - 'variants'  : 화질 변형 목록 조회 (헬퍼 없이 화질 선택)
 *  - 'download'  : 세그먼트 받아 복호화/합치기 → mp4 Blob → blobURL 반환
 * 진행률은 background 로 메시지를 쏴서 popup 에 표시되게 한다.
 * ========================================================================== */
'use strict';

const muxjs = self.muxjs;                         // lib/mux.min.js 가 전역에 노출
const Engine = self.HlsEngine;                    // lib/hls-engine.js
const blobUrls = new Map();                       // id -> blobURL (나중에 revoke)

// 쿠키는 같은 브라우저 세션이라 credentials:'include' 로 자동 전송된다.
// (fetch 는 Referer/Cookie 를 임의 지정 못 하므로, Referer 가 꼭 필요한 스트림은 헬퍼로 폴백)
const fetchFn = (u) => fetch(u, { credentials: 'include' });

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen') return;

  if (msg.cmd === 'variants') {
    Engine.listVariants(fetchFn, msg.url)
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ error: String(e.message || e) }));
    return true;
  }

  if (msg.cmd === 'download') {
    runDownload(msg).then(sendResponse).catch((e) =>
      sendResponse({ error: e.code === 'DRM' ? 'DRM 보호 콘텐츠는 지원하지 않습니다.' : String(e.message || e) }));
    return true;
  }

  // 폴백 저장: chrome.downloads 가 blob URL 을 못 받을 때 offscreen 에서 직접 a 클릭
  if (msg.cmd === 'save') {
    const u = blobUrls.get(msg.id);
    if (!u) { sendResponse({ error: 'blob 없음' }); return true; }
    try {
      const a = document.createElement('a');
      a.href = u; a.download = msg.filename || 'video.mp4';
      document.body.appendChild(a); a.click(); a.remove();
      sendResponse({ ok: true });
    } catch (e) { sendResponse({ error: String(e.message || e) }); }
    return true;
  }

  if (msg.cmd === 'revoke') {
    const u = blobUrls.get(msg.id);
    if (u) { URL.revokeObjectURL(u); blobUrls.delete(msg.id); }
    sendResponse({ ok: true });
    return true;
  }
});

async function runDownload(msg) {
  const out = await Engine.downloadVariant({
    fetchFn,
    mediaUrl: msg.mediaUrl,
    muxjs,
    onProgress: (p) => {
      chrome.runtime.sendMessage({
        target: 'background', cmd: 'ib_progress', id: msg.id,
        ratio: p.ratio, done: p.done, total: p.total,
        phase: p.ratio >= 1 ? 'merging' : 'downloading',
      });
    },
  });
  const mime = out.ext === 'mp4' ? 'video/mp4' : 'video/mp2t';
  const url = URL.createObjectURL(new Blob([out.bytes], { type: mime }));
  blobUrls.set(msg.id, url);
  return { ok: true, blobUrl: url, ext: out.ext, container: out.container, size: out.bytes.length };
}
