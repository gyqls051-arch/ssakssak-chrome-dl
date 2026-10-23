/* 싹싹김치 — 설정 (로컬 헬퍼 연결 설정) */
'use strict';

const $ = (id) => document.getElementById(id);
const DEFAULT_URL = 'http://127.0.0.1:8787';

async function load() {
  const c = await chrome.storage.local.get(['helperUrl', 'helperToken']);
  $('helperToken').value = c.helperToken || '';
  if ($('helperUrl')) $('helperUrl').value = c.helperUrl || DEFAULT_URL;
}

async function save() {
  try {
    const helperUrl = SsakHelper.base($('helperUrl').value || DEFAULT_URL);
    const helperToken = $('helperToken').value.trim();
    if (helperToken.length < 24) throw new Error('헬퍼 연결 토큰을 입력해 주세요.');
    await chrome.storage.local.set({helperUrl, helperToken});
    setStatus('저장됨', 'ok');
  } catch (error) { setStatus(error.message, 'bad'); }
}

async function test() {
  setStatus('확인 중…', '');
  const url = (($('helperUrl') && $('helperUrl').value) || DEFAULT_URL).trim().replace(/\/+$/, '');
  try {
    const h = await SsakHelper.request('/health', {}, {helperUrl:url,helperToken:$('helperToken').value.trim()});
    setStatus(`연결됨 · yt-dlp ${h.ytdlp || '?'} · ffmpeg ${h.ffmpeg ? 'OK' : '없음'} · 저장폴더: ${h.download_dir || '?'}`, 'ok');
  } catch (error) {
    setStatus(error.message, 'bad');
  }
}

function setStatus(msg, cls) {
  const el = $('status');
  if (el) { el.textContent = msg; el.className = 'status ' + (cls || ''); }
}

if ($('save')) $('save').onclick = save;
if ($('test')) $('test').onclick = test;
load();
