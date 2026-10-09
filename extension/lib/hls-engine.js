/* =============================================================================
 * 싹싹김치 — HLS 엔진 (브라우저·Node 공용, 의존성: fetch + crypto.subtle + mux.js)
 * -----------------------------------------------------------------------------
 * 브라우저 안에서 헬퍼 없이 HLS 를 직접 받아 mp4 로 만든다.
 *   1) 마스터 m3u8 파싱 → 화질 변형 목록(화질 선택)
 *   2) 미디어 m3u8 파싱 → 세그먼트 URL / 암호화(AES-128) / fMP4 여부
 *   3) 세그먼트 다운로드(진행률) → 필요시 AES-128(CBC) 복호화
 *   4) 합치기: TS → mux.js 로 mp4 리먹스 / fMP4 → init+세그먼트 이어붙여 mp4
 *
 * DRM(SAMPLE-AES + Widevine/FairPlay 키포맷)은 감지만 하고 거부한다.
 * fetchFn 을 주입받아(브라우저=window.fetch, Node=undici) 양쪽에서 동일하게 쓴다.
 * ========================================================================== */
(function (root) {
  'use strict';

  // ---- URL 해석 ----
  function absUrl(base, rel) {
    try { return new URL(rel, base).href; } catch { return rel; }
  }

  // ---- 속성 파싱: KEY=VALUE,KEY="V,V" ----
  function parseAttrs(s) {
    const out = {};
    const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
    let m;
    while ((m = re.exec(s))) {
      let v = m[2];
      if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
      out[m[1]] = v;
    }
    return out;
  }

  function hexToBytes(hex) {
    hex = hex.replace(/^0x/i, '');
    const a = new Uint8Array(hex.length / 2);
    for (let i = 0; i < a.length; i++) a[i] = parseInt(hex.substr(i * 2, 2), 16);
    return a;
  }

  function concat(arrs) {
    let n = 0;
    for (const a of arrs) n += a.length;
    const o = new Uint8Array(n);
    let p = 0;
    for (const a of arrs) { o.set(a, p); p += a.length; }
    return o;
  }

  // 시퀀스 번호 → 16바이트 빅엔디안 IV (IV 미지정 HLS 의 기본 규칙)
  function ivFromSequence(seq) {
    const iv = new Uint8Array(16);
    let n = BigInt(seq);
    for (let i = 15; i >= 0; i--) { iv[i] = Number(n & 0xffn); n >>= 8n; }
    return iv;
  }

  // ---- 마스터 플레이리스트 파싱 → 변형(화질) 목록 ----
  function parseMaster(text, baseUrl) {
    const lines = text.split(/\r?\n/);
    const variants = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith('#EXT-X-STREAM-INF')) {
        const a = parseAttrs(line.slice(line.indexOf(':') + 1));
        let url = '';
        for (let j = i + 1; j < lines.length; j++) {
          const u = lines[j].trim();
          if (u && !u.startsWith('#')) { url = u; i = j; break; }
        }
        if (!url) continue;
        let w = 0, h = 0;
        if (a.RESOLUTION) { const r = a.RESOLUTION.split('x'); w = +r[0] || 0; h = +r[1] || 0; }
        const bw = +(a.BANDWIDTH || a['AVERAGE-BANDWIDTH'] || 0);
        variants.push({
          url: absUrl(baseUrl, url),
          width: w, height: h, bandwidth: bw,
          codecs: a.CODECS || '',
          label: (h ? h + 'p' : (a.NAME || '?')) + (bw ? ` · ${(bw / 1e6).toFixed(1)}Mbps` : ''),
        });
      }
    }
    // 화질 높은 순
    variants.sort((x, y) => (y.height - x.height) || (y.bandwidth - x.bandwidth));
    return variants;
  }

  // ---- 미디어 플레이리스트 파싱 → 세그먼트/키/맵 ----
  function parseMedia(text, baseUrl) {
    const lines = text.split(/\r?\n/);
    const segments = [];
    let key = null, mapUri = null, drm = false, isFmp4 = false;
    let startSeq = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      if (line.startsWith('#EXT-X-MEDIA-SEQUENCE')) {
        startSeq = parseInt(line.split(':')[1], 10) || 0;
      } else if (line.startsWith('#EXT-X-KEY')) {
        const a = parseAttrs(line.slice(line.indexOf(':') + 1));
        const method = (a.METHOD || '').toUpperCase();
        const kf = (a.KEYFORMAT || '').toLowerCase();
        if (method === 'NONE') { key = null; continue; }
        // DRM 판별: SAMPLE-AES + Widevine/FairPlay/PlayReady 키포맷
        if (method === 'SAMPLE-AES' || method === 'SAMPLE-AES-CTR' ||
            kf.includes('widevine') || kf.includes('playready') ||
            kf.includes('com.apple.streamingkeydelivery')) {
          drm = true;
        }
        key = {
          method,
          uri: a.URI ? absUrl(baseUrl, a.URI) : '',
          iv: a.IV ? hexToBytes(a.IV) : null,
          keyformat: kf,
        };
      } else if (line.startsWith('#EXT-X-MAP')) {
        const a = parseAttrs(line.slice(line.indexOf(':') + 1));
        if (a.URI) { mapUri = absUrl(baseUrl, a.URI); isFmp4 = true; }
      } else if (line.startsWith('#EXTINF')) {
        const dur = parseFloat(line.split(':')[1]) || 0;
        for (let j = i + 1; j < lines.length; j++) {
          const u = lines[j].trim();
          if (u && !u.startsWith('#')) {
            if (/\.(m4s|mp4)(\?|$)/i.test(u)) isFmp4 = true;
            segments.push({ url: absUrl(baseUrl, u), duration: dur });
            i = j; break;
          }
        }
      }
    }
    return { segments, key, mapUri, isFmp4, drm, startSeq };
  }

  // ---- AES-128 (CBC, PKCS7) 복호화 ----
  async function decryptAES128(data, keyBytes, iv) {
    const cryptoObj = (typeof crypto !== 'undefined' && crypto.subtle) ? crypto
      : (root.crypto || globalThis.crypto);
    const k = await cryptoObj.subtle.importKey('raw', keyBytes, { name: 'AES-CBC' }, false, ['decrypt']);
    const dec = await cryptoObj.subtle.decrypt({ name: 'AES-CBC', iv }, k, data);
    return new Uint8Array(dec);
  }

  // ---- TS 세그먼트들 → mux.js 로 fragmented MP4 ----
  function transmuxTS(segments, muxjs) {
    return new Promise((resolve, reject) => {
      try {
        const tx = new muxjs.mp4.Transmuxer({ keepOriginalTimestamps: true });
        let init = null;
        const parts = [];
        tx.on('data', (e) => { if (init === null) init = e.initSegment; parts.push(e.data); });
        tx.on('done', () => {
          if (init === null) return reject(new Error('mux 실패(빈 TS)'));
          resolve(concat([init, ...parts]));
        });
        for (const s of segments) tx.push(s instanceof Uint8Array ? s : new Uint8Array(s));
        tx.flush();
      } catch (e) { reject(e); }
    });
  }

  // ---- 변형(화질) 목록 조회 ----
  async function listVariants(fetchFn, url) {
    const res = await fetchFn(url);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const text = await res.text();
    if (!text.includes('#EXTM3U')) throw new Error('m3u8 아님');
    if (text.includes('#EXT-X-STREAM-INF')) {
      return { isMaster: true, variants: parseMaster(text, url) };
    }
    // 마스터가 아니라 바로 미디어 플레이리스트면 단일 변형
    return { isMaster: false, variants: [{ url, height: 0, label: '기본' }] };
  }

  // ---- 선택한 변형(미디어 m3u8) 다운로드 → mp4/ts 바이트 ----
  async function downloadVariant({ fetchFn, mediaUrl, muxjs, onProgress }) {
    const res = await fetchFn(mediaUrl);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const media = parseMedia(await res.text(), mediaUrl);
    if (media.drm) { const e = new Error('DRM'); e.code = 'DRM'; throw e; }
    if (!media.segments.length) throw new Error('세그먼트 없음');

    // 키 로드
    let keyBytes = null;
    if (media.key && media.key.method === 'AES-128') {
      if (!media.key.uri) throw new Error('암호화 키 URI 없음');
      const kr = await fetchFn(media.key.uri);
      if (!kr.ok) throw new Error('키 다운로드 실패 ' + kr.status);
      keyBytes = new Uint8Array(await kr.arrayBuffer());
    }

    // fMP4 init
    let initSeg = null;
    if (media.mapUri) initSeg = new Uint8Array(await (await fetchFn(media.mapUri)).arrayBuffer());

    const total = media.segments.length;
    const buffers = [];
    for (let i = 0; i < total; i++) {
      const sr = await fetchFn(media.segments[i].url);
      if (!sr.ok) throw new Error(`세그먼트 ${i + 1}/${total} 실패 ${sr.status}`);
      let buf = new Uint8Array(await sr.arrayBuffer());
      if (keyBytes) {
        const iv = media.key.iv || ivFromSequence(media.startSeq + i);
        buf = await decryptAES128(buf, keyBytes, iv);
      }
      buffers.push(buf);
      if (onProgress) onProgress({ done: i + 1, total, ratio: (i + 1) / total });
    }

    if (media.isFmp4) {
      return { bytes: concat(initSeg ? [initSeg, ...buffers] : buffers), ext: 'mp4', container: 'fmp4' };
    }
    if (muxjs) {
      return { bytes: await transmuxTS(buffers, muxjs), ext: 'mp4', container: 'mux-ts' };
    }
    return { bytes: concat(buffers), ext: 'ts', container: 'ts' };   // mux.js 없으면 .ts
  }

  const HlsEngine = {
    absUrl, parseAttrs, parseMaster, parseMedia, hexToBytes, ivFromSequence, concat,
    decryptAES128, transmuxTS, listVariants, downloadVariant,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = HlsEngine;
  else root.HlsEngine = HlsEngine;
})(typeof self !== 'undefined' ? self : globalThis);
