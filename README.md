# 싹싹김치 — 웹 비디오 다운로더

브라우저에서 **재생 중인 영상의 실제 스트림**(URL + 헤더)을 가로채 저장하는 오픈소스 도구.
Video DownloadHelper 류와 같은 원리다. 무료 · MIT 라이선스.

**하이브리드 구조** — 흔한 경우는 헬퍼 없이 브라우저 안에서 끝내고, 어려운 경우만 헬퍼로:
- **HLS(.m3u8)** → 확장이 직접 화질 목록 파싱 + 세그먼트 받아 mp4 변환(mux.js) → **헬퍼 불필요**
- **단순 mp4/webm** → 브라우저가 바로 저장 → **헬퍼 불필요**
- **DASH(.mpd) · Referer 막힌 스트림 · 실패한 경우** → **헬퍼(yt-dlp)로 폴백**

> **왜 브라우저 안에서 잡나** — 단독 다운로더가 못 받는 이유는 난독화 JS·토큰 서명
> URL·iframe·로그인 쿠키를 "브라우저가 이미 다 풀어놓은 상태"에 접근하지 못해서다.
> 이 도구는 **크롬 확장**이라 페이지가 실제 재생되는 그 세션에서 진짜 스트림 주소·헤더·
> 쿠키를 그대로 쓴다. (HLS는 확장이 직접 받고, 헬퍼로 넘길 땐 헤더를 1:1 전달)

---

## ⚠️ 사용 전 안내 (꼭 읽기)
- **다운로드 권한이 있는 콘텐츠에만 사용하세요.** 본인이 만든/소유한 영상, 공개도메인,
  Creative Commons, 또는 권리자의 허락이 있는 콘텐츠 등. **저작권·약관 준수 책임은
  전적으로 사용자 본인에게 있으며, 제작자/배포자는 사용자의 사용에 대해 책임지지 않습니다.**
- **DRM(Widevine/PlayReady/FairPlay) 보호 콘텐츠는 지원하지 않습니다.** 우회 시도도 하지 않습니다.
- 범용 도구입니다. 특정 사이트의 약관을 위반하는 용도로 사용하지 마세요.
- 크롬 웹스토어 미등록 — **개발자 모드(압축해제 로드)** 로 설치하는 오픈소스 프로젝트입니다.

---

## 구성 (2부분)

```
싹싹김치/
├── README.md                ← 이 문서
├── .gitignore
├── extension/               ← A) 크롬 확장 (Manifest V3)
│   ├── manifest.json        ·  권한 선언 (webRequest, storage, downloads, offscreen, <all_urls>)
│   ├── background.js        ·  ★ 스트림 감지(webRequest) + 다운로드 오케스트레이션
│   ├── content.js           ·  페이지 제목/og:image(썸네일) 수집
│   ├── popup.html/.css/.js  ·  팝업 UI: 스트림 목록 + 화질선택 + 진행률
│   ├── options.html/.js     ·  설정: 헬퍼 주소(토큰 불필요)
│   ├── offscreen.html/.js   ·  ★ 보이지 않는 작업창: HLS 엔진 실행(Blob/DOM 필요)
│   ├── lib/hls-engine.js    ·  ★ HLS 파싱/세그먼트/AES-128 복호화/합치기 (브라우저·Node 공용)
│   ├── lib/mux.min.js       ·  TS→mp4 리먹서 (mux.js, Apache-2.0, 벤더)
│   └── icons/               ·  아이콘 PNG (+ 재생성 스크립트)
└── helper/                  ← B) 로컬 헬퍼 (Python) : DASH/폴백 전용 (선택)
    ├── helper.py            ·  루프백 HTTP 서버 + yt-dlp 호출 + 진행률
    ├── requirements.txt     ·  yt-dlp
    ├── start_helper.bat     ·  헬퍼 실행(콘솔) / start_hidden.vbs  ·  무창 실행
    ├── stop_helper.bat      ·  헬퍼 종료
    ├── setup_ffmpeg.bat     ·  ffmpeg 설치 (헬퍼가 DASH 합칠 때)
    └── install_autostart.bat·  로그인 시 헬퍼 무창 자동 실행 등록(선택)
```

**확장만으로 HLS·MP4 는 받힌다.** 헬퍼(B)는 **DASH 나 Referer 가 꼭 필요한 스트림** 같은
어려운 경우에만 쓰는 선택 요소다. 확장↔헬퍼는 `127.0.0.1` 루프백으로 통신하며 **토큰 없이**
Origin 검사로 웹페이지의 오·남용만 막는다.

---

## 설치

### 1) 확장 로드 (이것만으로 HLS·MP4 다운로드 가능)
1. 크롬 주소창에 `chrome://extensions`
2. 우상단 **개발자 모드** 켜기
3. **압축해제된 확장 프로그램을 로드** → `extension` 폴더 선택
   - 이후 코드를 바꾸면 확장 카드의 **🔄 새로고침**을 눌러 반영.

### 2) 헬퍼 (선택 — YouTube·DASH 받을 때만, **토큰 불필요**)
1. (Python 3.9+) `helper/install_autostart.bat` 를 **한 번** 실행
   → 로그인 시 헬퍼가 **창 없이 자동 실행** (토큰 입력 없음, 이후 안 건드려도 됨)
2. ffmpeg 가 PATH에 없으면 `helper/setup_ffmpeg.bat` 1회.
3. 끝. YouTube 는 팝업의 **"이 페이지 받기"**, DASH 는 카드의 **"헬퍼로 받기"**.

### 3) 사용
1. 받고 싶은 영상이 있는 페이지에서 영상을 **재생**한다.
2. 툴바의 확장 아이콘 배지에 감지된 스트림 개수가 표시됨 → 클릭.
3. 목록에서 **다운로드** 클릭 → (HLS면) 화질 고르고 **받기**. 브라우저가 받아 기본
   다운로드 폴더에 저장(헬퍼 쓰면 `~/Downloads/SsakSsakKimchi`).
4. 진행률/완료/실패가 팝업에 표시됨. 안 되면 카드의 **"헬퍼로 받기"** 로 폴백.

---

## 동작 원리 (단계별)

1. **감지** — `background.js` 가 `chrome.webRequest`(관찰 모드)로 현재 탭의 미디어 요청을
   잡는다. `.m3u8`(HLS)/`.mpd`(DASH)/`.mp4`/`.webm` 및 `Content-Type` 이
   `video/*` · `application/vnd.apple.mpegurl` · `application/dash+xml` 인 응답.
   - 한 요청의 3개 이벤트(`onBeforeRequest`→`onBeforeSendHeaders`→`onHeadersReceived`)를
     `requestId` 로 합쳐 **URL + 실제 요청 헤더 + Content-Type** 을 한 레코드로 만든다.
   - 민감 헤더(Cookie/Referer)는 `extraInfoSpec` 에 `'extraHeaders'` 를 넣어야 보인다(MV3에서도 관찰은 가능).
2. **화질 선택** — HLS면 확장이 **마스터 m3u8 을 직접 파싱**해 1080p/720p/… 를 드롭다운으로
   보여준다(헬퍼 불필요). DASH면 헬퍼가 yt-dlp 로 조회.
3. **다운로드 (하이브리드)**
   - **HLS** → `offscreen.html` 의 엔진이 세그먼트를 `fetch`(쿠키 자동 포함)로 받아 필요시
     **AES-128 복호화**하고, TS면 **mux.js 로 mp4 리먹스**, fMP4면 init+세그먼트 이어붙여 mp4 → 저장.
   - **단순 mp4/webm** → `chrome.downloads` 로 바로 저장.
   - **DASH / Referer 막힘 / 실패** → 헬퍼로 `{url, headers, title, format}` 전송 →
     yt-dlp 가 **캡처한 헤더를 1:1** 로 써서 받고 ffmpeg 로 합침.

오류는 어느 단계인지 구분된다: 감지(없으면 목록 비어있음) / 전송(헬퍼 연결 안 됨) /
다운로드·합치기(작업 카드에 빨간 에러 메시지: 403/404/DRM/ffmpeg 없음 등).

---

## 보안 모델

- 헬퍼는 **`127.0.0.1` 루프백에만** 바인딩 → 외부 네트워크에서 접근 불가.
- **토큰 없음 — 대신 `Origin` 검사로 보호.** 헬퍼는 `http(s)://` Origin(웹페이지)이 보낸
  요청을 거부한다. 브라우저가 Origin 을 강제로 붙이므로 **웹페이지는 이를 못 속여**
  헬퍼를 오·남용(CSRF)할 수 없다. 확장(`chrome-extension://`)·로컬 요청은 허용. → 토큰 입력 불필요.
- 확장 권한은 최소화: `webRequest`(감지) + `storage`(설정/목록) + `host_permissions: <all_urls>`.
  - `<all_urls>` 가 필요한 이유: 어떤 사이트에서 영상을 볼지 미리 알 수 없으므로
    모든 페이지의 미디어 요청을 **관찰**(변조 아님)해야 하고, 동시에 `127.0.0.1` 헬퍼로
    fetch 하기 위함.
- 캡처한 Cookie 등 민감 헤더는 **로컬에서만** 쓰이고 외부로 나가지 않는다.
  (`/jobs` 응답에는 헤더/쿠키를 포함하지 않음.)

### 왜 Native Messaging 이 아니라 루프백 HTTP 인가
| | 루프백 HTTP (채택) | Native Messaging |
|---|---|---|
| 긴 다운로드 + 진행률 폴링 | 작업ID로 폴링, 자연스러움 | stdio 스트리밍, 다소 번거로움 |
| 설치 | 포트만 열면 됨 | 윈도우 **레지스트리 등록** 필요 |
| 디버깅/독립 실행 | 콘솔로 바로 확인, curl 가능 | Chrome 이 켜야 호스트가 뜸 |
| 보안 | 루프백 only + Origin 검사(토큰 불필요) | 포트를 안 열어 약간 더 안전 |

긴 다운로드 + 진행률 표시라는 요구에는 **루프백 HTTP** 가 단순하고 충분히 안전해 채택.

---

## 참고 / 알려진 제약

- **쿠키 처리**: yt-dlp 의 `--cookies-from-browser chrome` 은 Chrome 127+ 의
  App-Bound Encryption 때문에 Windows 에서 사실상 깨졌다([yt-dlp #15401]).
  이 도구는 대신 **확장이 캡처한 Cookie 헤더를 직접 넘기므로** 그 문제를 우회한다 —
  로그인이 필요한 스트림도 "지금 그 세션 그대로" 받는다.
- **DRM**: 암호화된(DRM) 스트림은 받을 수 없고 시도하지도 않는다. 작업 카드에
  "DRM 보호 콘텐츠는 지원하지 않습니다" 로 표시된다. (AES-128 clear-key HLS 는 DRM 이
  아니라 yt-dlp 가 정상 처리한다.)
- **세그먼트 노이즈**: 개별 `.ts`/`.m4s` 세그먼트와 너무 작은 mp4 는 목록에서 자동 제외하고
  HLS/DASH **매니페스트**와 프로그레시브 파일만 보여준다.
- **파일명**: 페이지 제목으로 저장한다(특수문자 제거).
- **화질 선택**: 다운로드 시 변형 목록에서 고를 수 있다. "최고화질(자동)" 을 고르면 yt-dlp 가 best 로 받는다.

---

## 문제 해결

| 증상 | 확인 |
|---|---|
| 팝업에 "브라우저 모드"(헬퍼 OFF) | 정상 — HLS·MP4는 그래도 됨. YouTube/DASH만 헬퍼 실행 필요 |
| YouTube가 목록에 안 잡힘 | 정상 — YouTube는 sniffing 불가. 팝업 **"이 페이지 받기"**(헬퍼 필요) |
| 스트림이 안 잡힘 | 영상을 실제로 **재생**했는지, 페이지 새로고침 후 재생 |
| 다운로드 403/404 | 쿠키/세션 만료 — 페이지 새로고침하고 다시 재생 후 시도 |
| "ffmpeg 가 필요합니다" | `setup_ffmpeg.bat` 1회 실행 |
| DRM 메시지 | 지원 불가(정상 동작) |

---

## 라이선스 / 서드파티

- 이 프로젝트: **MIT** (`LICENSE` 참고).
- 번들 포함: **mux.js** (Apache-2.0) — `extension/lib/mux.min.js`. 라이선스 헤더 보존.
- 외부 도구(헬퍼가 호출, 소스에 미포함):
  - **yt-dlp** (Unlicense) — DASH/YouTube 등 폴백 다운로드.
  - **ffmpeg** (LGPL/GPL) — 헬퍼의 HLS/DASH 합치기. **배포물에 ffmpeg 바이너리를 함께
    포함**한다면 해당 빌드의 GPL/LGPL 의무(소스 제공 등)를 준수해야 합니다. 기본값은
    번들하지 않고 사용자가 `setup_ffmpeg.bat` 로 받도록 합니다.

[yt-dlp #15401]: https://github.com/yt-dlp/yt-dlp/issues/15401
