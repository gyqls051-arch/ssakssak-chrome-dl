/* =============================================================================
 * 싹싹김치 — content script (페이지 메타 수집)
 * -----------------------------------------------------------------------------
 * 팝업이 요청하면 현재 페이지의 제목 / og:image(썸네일) / og:title 을 돌려준다.
 * 파일명 스마트 네이밍과 썸네일 표시에 쓰인다. (DOM 만 읽고 아무것도 바꾸지 않음)
 * ========================================================================== */

'use strict';

function meta(prop) {
  const el = document.querySelector(`meta[property="${prop}"]`) ||
             document.querySelector(`meta[name="${prop}"]`);
  return el ? el.getAttribute('content') : '';
}

function collect() {
  const ogTitle = meta('og:title');
  const ogImage = meta('og:image');
  return {
    title: (ogTitle || document.title || '').trim(),
    ogImage: ogImage || '',
    pageUrl: location.href
  };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.cmd === 'getPageMeta') {
    sendResponse(collect());
    return true;        // 우리가 처리한 메시지만 채널 유지(다른 메시지엔 간섭 안 함)
  }
});
