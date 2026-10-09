/* 싹싹김치 — 설정 (토큰 없음: 헬퍼 주소만, 연결 확인용) */
'use strict';

const $ = (id) => document.getElementById(id);
const DEFAULT_URL = 'http://127.0.0.1:8787';

async function load() {
  const c = await chrome.storage.local.get(['helperUrl']);
  if ($('helperUrl')) $('helperUrl').value = c.helperUrl || DEFAULT_URL;
}

async function save() {
  await chrome.storage.local.set({
    helperUrl: (($('helperUrl') && $('helperUrl').value) || DEFAULT_URL).trim().replace(/\/+$/, '')
  });
  setStatus('저장됨', 'ok');
}

async function test() {
  setStatus('확인 중…', '');
  const url = (($('helperUrl') && $('helperUrl').value) || DEFAULT_URL).trim().replace(/\/+$/, '');
  try {
    const res = await fetch(url + '/health');       // 토큰 없이 (확장 Origin 이라 헬퍼가 허용)
    if (!res.ok) return setStatus('연결 실패 (HTTP ' + res.status + ')', 'bad');
    const h = await res.json();
    setStatus(`연결됨 · yt-dlp ${h.ytdlp || '?'} · ffmpeg ${h.ffmpeg ? 'OK' : '없음'} · 저장폴더: ${h.download_dir || '?'}`, 'ok');
  } catch {
    setStatus('헬퍼 미연결 (선택 — HLS·MP4는 헬퍼 없이도 됩니다)', 'muted');
  }
}

function setStatus(msg, cls) {
  const el = $('status');
  if (el) { el.textContent = msg; el.className = 'status ' + (cls || ''); }
}

if ($('save')) $('save').onclick = save;
if ($('test')) $('test').onclick = test;
load();
