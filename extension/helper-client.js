/* Local helper transport. The pairing token never leaves loopback. */
'use strict';
globalThis.SsakHelper = {
  base(value) {
    const u = new URL(value || 'http://127.0.0.1:8787');
    if (u.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) ||
        u.username || u.password || u.pathname !== '/' || u.search || u.hash) {
      throw new Error('헬퍼는 로컬 주소만 사용할 수 있습니다.');
    }
    return u.origin;
  },
  async request(path, options = {}, config) {
    const c = config || await chrome.storage.local.get(['helperUrl', 'helperToken']);
    const base = this.base(c.helperUrl);
    if (!/^\/[a-z0-9/-]+$/i.test(path)) throw new Error('Invalid helper route');
    if (typeof c.helperToken !== 'string' || c.helperToken.length < 24) {
      throw new Error('설정에서 헬퍼 연결 토큰을 입력해 주세요.');
    }
    const headers = new Headers(options.headers || {});
    headers.set('X-SSAK-Token', c.helperToken);
    const response = await fetch(base + path, {...options, headers, redirect:'error', signal:AbortSignal.timeout(30000)});
    if (!response.ok) throw new Error('헬퍼 연결 실패: HTTP ' + response.status);
    return response.json();
  }
};
