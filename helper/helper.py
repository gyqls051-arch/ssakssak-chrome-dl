#!/usr/bin/env python3
# =============================================================================
# 싹싹김치 — 로컬 헬퍼 (다운로드/합치기 담당)
# -----------------------------------------------------------------------------
# 크롬 확장은 샌드박스라 ffmpeg 를 못 돌린다. 그래서 실제 다운로드(yt-dlp)와
# HLS/DASH 합치기(ffmpeg)는 이 파이썬 헬퍼가 맡는다.
#
# 통신: 127.0.0.1(루프백)에만 바인딩하는 작은 HTTP 서버.
#       외부에서 접근 불가 + 공유 토큰(X-SSAK-Token)으로 다른 프로그램 차단.
#
# 왜 Native Messaging 이 아니라 루프백 HTTP 인가:
#   - 긴 다운로드 + 진행률 폴링이 HTTP 에서 훨씬 자연스럽다(작업ID로 폴링).
#   - 헬퍼를 독립 실행/자동시작/콘솔확인하기 쉽고 디버깅이 편하다.
#   - 레지스트리 등록이 필요 없다.
#   - 보안은 "루프백 only + 랜덤 토큰" 으로 충분(포트가 외부에 안 열림).
#
# 핵심 가치: 확장이 가로챈 실제 요청 헤더(Referer/Origin/Cookie/User-Agent)를
#           yt-dlp 의 http_headers 로 1:1 그대로 넘긴다. 토큰 서명 스트림은
#           이게 정확해야만 열린다. (Chrome 127+ 에서 --cookies-from-browser 가
#           App-Bound Encryption 으로 깨졌기 때문에 이 방식이 더 정확하다.)
# =============================================================================

import json
import os
import re
import sys
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# ---- yt-dlp (필수) -----------------------------------------------------------
try:
    import yt_dlp
except ImportError:
    print("[오류] yt-dlp 가 없습니다.  설치:  pip install -r requirements.txt", file=sys.stderr)
    sys.exit(1)

APP_VERSION = "1.0.0"

# 설정/토큰/ffmpeg 가 저장되는 폴더
CONFIG_DIR = os.path.join(os.path.expanduser("~"), ".ssakssak")
CONFIG_PATH = os.path.join(CONFIG_DIR, "config.json")

# ---- 전역 상태 ---------------------------------------------------------------
CONFIG = {}
JOBS = {}                         # jobId -> job dict
JOBS_LOCK = threading.Lock()
SEM = None                        # 동시 다운로드 제한 세마포어 (설정 후 초기화)


class JobCancelled(Exception):
    """진행률 훅에서 던져서 다운로드를 중단시키는 신호."""


# =============================================================================
# 설정 / 토큰
# =============================================================================
def load_config():
    """설정을 읽고, 없으면 랜덤 토큰과 기본값으로 새로 만든다."""
    os.makedirs(CONFIG_DIR, exist_ok=True)
    cfg = {}
    if os.path.exists(CONFIG_PATH):
        try:
            with open(CONFIG_PATH, "r", encoding="utf-8") as f:
                cfg = json.load(f)
        except Exception:
            cfg = {}

    changed = False
    if not cfg.get("token"):
        import secrets
        cfg["token"] = secrets.token_urlsafe(24)   # 다른 프로그램이 못 부르게 하는 공유 비밀
        changed = True
    cfg.setdefault("port", 8787)
    cfg.setdefault("download_dir", os.path.join(os.path.expanduser("~"), "Downloads", "SsakSsakKimchi"))
    cfg.setdefault("max_concurrent", 3)
    cfg.setdefault("ffmpeg_location", "")           # 비우면 자동 탐색

    if changed:
        save_config(cfg)
    return cfg


def save_config(cfg):
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2, ensure_ascii=False)


# =============================================================================
# ffmpeg 탐색 / 설치
# =============================================================================
def find_ffmpeg():
    """ffmpeg 경로(폴더)를 찾는다. 순서: 설정값 → PATH → 헬퍼 전용 폴더."""
    import shutil
    loc = CONFIG.get("ffmpeg_location")
    if loc and os.path.isdir(loc) and _has_ffmpeg(loc):
        return loc
    p = shutil.which("ffmpeg")
    if p:
        return os.path.dirname(p)
    bundled = os.path.join(CONFIG_DIR, "ffmpeg")
    if _has_ffmpeg(bundled):
        return bundled
    return None


def _has_ffmpeg(folder):
    exe = "ffmpeg.exe" if os.name == "nt" else "ffmpeg"
    return os.path.isfile(os.path.join(folder, exe))


def setup_ffmpeg():
    """yt-dlp 권장 정적 빌드에서 ffmpeg/ffprobe 를 받아 ~/.ssakssak/ffmpeg 에 넣는다."""
    import urllib.request
    import zipfile
    import io

    if os.name != "nt":
        print("자동 설치는 Windows 전용입니다. Linux/Mac 은 패키지 매니저로 ffmpeg 설치 후 PATH 등록.")
        return
    url = ("https://github.com/yt-dlp/FFmpeg-Builds/releases/latest/download/"
           "ffmpeg-master-latest-win64-gpl.zip")
    dest = os.path.join(CONFIG_DIR, "ffmpeg")
    os.makedirs(dest, exist_ok=True)
    print(f"ffmpeg 다운로드 중… (수십 MB)\n  {url}")
    data = urllib.request.urlopen(url).read()
    print("압축 해제 중…")
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        for name in z.namelist():
            base = os.path.basename(name)
            if base in ("ffmpeg.exe", "ffprobe.exe"):
                with z.open(name) as src, open(os.path.join(dest, base), "wb") as out:
                    out.write(src.read())
    if _has_ffmpeg(dest):
        print(f"[완료] ffmpeg 설치됨 → {dest}")
    else:
        print("[오류] 압축 안에서 ffmpeg.exe 를 못 찾았습니다.")


# =============================================================================
# 다운로드 작업 (yt-dlp)
# =============================================================================
def sanitize_filename(name):
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "", name or "").strip()
    name = name.replace("%", "_")            # outtmpl 의 % 충돌 방지
    name = re.sub(r"\s+", " ", name)
    return (name[:150] or "video").strip()


def fmt_speed(bps):
    if not bps:
        return ""
    if bps > 1e6:
        return f"{bps/1e6:.1f} MB/s"
    if bps > 1e3:
        return f"{bps/1e3:.0f} KB/s"
    return f"{bps:.0f} B/s"


def fmt_bytes(n):
    n = n or 0
    if not n:
        return ""
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024:
            return f"{n:.0f}{unit}" if unit == "B" else f"{n:.1f}{unit}"
        n /= 1024
    return f"{n:.1f}TB"


def probe_formats(url, headers):
    """yt-dlp 로 화질 변형 목록을 조회한다(다운로드 X). 화질 선택 UI 용.
       각 항목에 yt-dlp 가 이해하는 'selector' 를 미리 만들어 확장은 그대로 보내기만 하면 됨."""
    opts = {
        "quiet": True, "no_warnings": True, "noplaylist": True,
        "http_headers": {k: v for k, v in (headers or {}).items() if v},
    }
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=False)
    if info.get("entries"):                      # 혹시 플레이리스트면 첫 항목
        info = info["entries"][0]

    seen = {}                                    # (height, ext) -> (tbr, entry)  같은 화질은 비트레이트 높은 것만
    for f in info.get("formats") or []:
        if f.get("vcodec") in (None, "none"):    # 영상 없는(오디오/이미지) 포맷 제외
            continue
        h = f.get("height") or 0
        ext = f.get("ext") or ""
        tbr = f.get("tbr") or 0
        key = (h, ext)
        if key in seen and seen[key][0] >= tbr:
            continue
        size = f.get("filesize") or f.get("filesize_approx") or 0
        muxed = f.get("acodec") not in (None, "none")        # 영상+소리 한 덩어리인지
        fid = f.get("format_id")
        selector = fid if muxed else f"{fid}+bestaudio/best"  # 영상만이면 최적 오디오 합치기
        label = (f"{h}p" if h else (f.get("format_note") or fid or "?"))
        if ext:
            label += f" · {ext}"
        if size:
            label += f" · {fmt_bytes(size)}"
        seen[key] = (tbr, {"format_id": fid, "height": h, "ext": ext,
                           "filesize": size, "selector": selector, "label": label})

    vids = [e for _, e in seen.values()]
    vids.sort(key=lambda x: (x["height"], x.get("filesize", 0)), reverse=True)
    return {
        "title": info.get("title") or "",
        "thumbnail": info.get("thumbnail") or "",
        "duration": info.get("duration") or 0,      # 초
        "uploader": info.get("uploader") or "",
        "formats": vids,
    }


def build_ydl_opts(job, ffmpeg_dir):
    base = sanitize_filename(job.get("title")) if job.get("title") else "%(title).150B"
    outtmpl = os.path.join(CONFIG["download_dir"], base + ".%(ext)s")

    def progress_hook(d):
        if job.get("_cancel"):
            raise JobCancelled()
        st = d.get("status")
        if st == "downloading":
            job["status"] = "downloading"
            total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
            done = d.get("downloaded_bytes") or 0
            if total:
                job["percent"] = round(done / total * 100, 1)
            job["speed"] = fmt_speed(d.get("speed"))
            job["eta"] = d.get("eta")
            fn = d.get("filename")
            if fn:
                job["filename"] = os.path.basename(fn)
        elif st == "finished":
            job["percent"] = 100
            job["speed"] = ""

    def pp_hook(d):
        if d.get("status") == "started":
            pp = d.get("postprocessor", "")
            if "Merger" in pp or "FFmpeg" in pp or "Fixup" in pp:
                job["status"] = "merging"
        elif d.get("status") == "finished":
            info = d.get("info_dict") or {}
            fp = info.get("filepath")
            if fp:
                job["filename"] = os.path.basename(fp)

    opts = {
        "outtmpl": outtmpl,
        "http_headers": {k: v for k, v in (job.get("headers") or {}).items() if v},  # ★ 헤더 1:1 전달
        "progress_hooks": [progress_hook],
        "postprocessor_hooks": [pp_hook],
        "merge_output_format": "mp4",
        "concurrent_fragment_downloads": 5,     # HLS/DASH 세그먼트 병렬
        "retries": 10,
        "fragment_retries": 10,
        "noprogress": True,
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "overwrites": True,
        **({"format": job["format"]} if job.get("format") else {}),  # 화질 선택 시 selector 적용
        "restrictfilenames": False,
        "consoletitle": False,
        "logger": _SilentLogger(job),
    }
    if ffmpeg_dir:
        opts["ffmpeg_location"] = ffmpeg_dir
    return opts


class _SilentLogger:
    """yt-dlp 내부 로그를 콘솔에 쏟지 않고, 마지막 에러만 job 에 담아둔다."""
    def __init__(self, job):
        self.job = job
    def debug(self, msg):
        pass
    def info(self, msg):
        pass
    def warning(self, msg):
        pass
    def error(self, msg):
        self.job["_last_error"] = str(msg)


def friendly_error(msg):
    low = (msg or "").lower()
    if "drm" in low or "this video is protected" in low:
        return "DRM 보호 콘텐츠는 지원하지 않습니다. (Widevine/PlayReady 등)"
    if "ffmpeg" in low and ("not found" in low or "install" in low or "merging" in low):
        return "ffmpeg 가 필요합니다. helper 폴더의 setup_ffmpeg.bat 를 실행하세요."
    if "403" in low or "forbidden" in low:
        return "403 거부됨 — 헤더/쿠키가 만료됐을 수 있습니다. 페이지를 새로고침하고 다시 시도하세요."
    if "404" in low:
        return "404 — 스트림 URL 이 만료됐습니다. 다시 재생 후 시도하세요."
    return msg[:300]


def run_job(job):
    """세마포어로 동시 실행 수를 제한하며 한 건을 다운로드한다(스레드에서 호출)."""
    job["status"] = "queued"
    with SEM:
        if job.get("_cancel"):
            job["status"] = "canceled"
            return
        ffmpeg_dir = find_ffmpeg()
        os.makedirs(CONFIG["download_dir"], exist_ok=True)
        job["status"] = "downloading"
        try:
            opts = build_ydl_opts(job, ffmpeg_dir)
            with yt_dlp.YoutubeDL(opts) as ydl:
                ydl.download([job["url"]])
            if job["status"] != "canceled":
                job["status"] = "done"
                job["percent"] = 100
        except JobCancelled:
            job["status"] = "canceled"
        except Exception as e:
            job["status"] = "error"
            job["error"] = friendly_error(job.get("_last_error") or str(e))


def prune_jobs(limit=60):
    """JOBS 가 무한히 커지지 않게: 한도를 넘으면 오래된 '끝난' 작업부터 제거.
       (호출자가 JOBS_LOCK 을 잡은 상태에서 부른다.)"""
    if len(JOBS) <= limit:
        return
    for jid in [k for k, v in JOBS.items() if v["status"] in ("done", "error", "canceled")]:
        if len(JOBS) <= limit:
            break
        del JOBS[jid]


def public_job(job):
    """확장에 보낼 안전한 필드만 추린다(헤더/쿠키 같은 민감정보 제외)."""
    return {
        "id": job["id"],
        "title": job.get("title") or "",
        "url": job.get("url"),
        "type": job.get("type"),
        "status": job.get("status"),
        "percent": job.get("percent", 0),
        "speed": job.get("speed", ""),
        "eta": job.get("eta"),
        "filename": job.get("filename", ""),
        "error": job.get("error", ""),
    }


# =============================================================================
# HTTP 서버
# =============================================================================
class Handler(BaseHTTPRequestHandler):
    server_version = "SsakSsak-helper/" + APP_VERSION

    # ---- 공통 응답 ----
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "X-SSAK-Token, Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _allowed(self):
        # 토큰 없이도 안전하게: 웹페이지(http/https Origin)는 차단, 확장/로컬은 허용.
        # 브라우저가 Origin 을 강제로 붙이므로 웹페이지는 이를 못 속인다(CSRF 차단).
        # (예전처럼 토큰을 보내면 웹페이지여도 허용 — 하위호환)
        origin = self.headers.get("Origin", "")
        if origin.startswith("http://") or origin.startswith("https://"):
            import hmac
            return hmac.compare_digest(self.headers.get("X-SSAK-Token", ""), CONFIG.get("token", ""))
        return True   # chrome-extension:// · Origin 없음(로컬) → 허용

    def _read_json(self):
        try:
            n = int(self.headers.get("Content-Length", 0))
            return json.loads(self.rfile.read(n) or b"{}")
        except Exception:
            return {}

    def log_message(self, *a):
        pass  # 기본 액세스 로그 끔(콘솔 깔끔하게)

    # ---- 라우팅 ----
    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        if not self._allowed():
            return self._json(403, {"error": "forbidden"})
        if self.path == "/health":
            return self._json(200, {
                "ok": True,
                "version": APP_VERSION,
                "ytdlp": getattr(yt_dlp.version, "__version__", "?"),
                "ffmpeg": bool(find_ffmpeg()),
                "download_dir": CONFIG["download_dir"],
            })
        if self.path == "/jobs":
            with JOBS_LOCK:
                jobs = [public_job(j) for j in JOBS.values()]
            # 최신이 위로 (오래된 완료건은 뒤로)
            order = {"downloading": 0, "merging": 0, "queued": 1, "error": 2, "done": 3, "canceled": 4}
            jobs.sort(key=lambda j: order.get(j["status"], 9))
            return self._json(200, {"jobs": jobs})
        return self._json(404, {"error": "not found"})

    def do_POST(self):
        if not self._allowed():
            return self._json(403, {"error": "forbidden"})

        if self.path == "/probe":
            data = self._read_json()
            url = (data.get("url") or "").strip()
            if not url:
                return self._json(400, {"error": "url required"})
            try:
                return self._json(200, probe_formats(url, data.get("headers", {})))
            except Exception as e:
                # 조회 실패(DRM/만료 등) → 에러 메시지로 알려주고 확장이 기본 다운로드로 폴백
                return self._json(200, {"error": friendly_error(str(e)), "formats": []})

        if self.path == "/download":
            data = self._read_json()
            url = (data.get("url") or "").strip()
            if not url:
                return self._json(400, {"error": "url required"})
            job = {
                "id": uuid.uuid4().hex[:8],
                "url": url,
                "type": data.get("type", ""),
                "title": data.get("title", ""),
                "headers": data.get("headers", {}) or {},
                "format": (data.get("format") or "").strip(),   # 화질 selector (비면 best 자동)
                "status": "queued",
                "percent": 0,
                "speed": "",
                "eta": None,
                "filename": "",
                "error": "",
            }
            with JOBS_LOCK:
                JOBS[job["id"]] = job
                prune_jobs()
            threading.Thread(target=run_job, args=(job,), daemon=True).start()
            return self._json(200, {"jobId": job["id"]})

        m = re.match(r"^/jobs/([0-9a-f]+)/cancel$", self.path)
        if m:
            with JOBS_LOCK:
                job = JOBS.get(m.group(1))
            if not job:
                return self._json(404, {"error": "no such job"})
            job["_cancel"] = True
            return self._json(200, {"ok": True})

        if self.path == "/clear-finished":
            with JOBS_LOCK:
                for jid in [k for k, v in JOBS.items() if v["status"] in ("done", "error", "canceled")]:
                    del JOBS[jid]
            return self._json(200, {"ok": True})

        if self.path == "/open":
            try:
                os.makedirs(CONFIG["download_dir"], exist_ok=True)
                if os.name == "nt":
                    os.startfile(CONFIG["download_dir"])  # noqa
                return self._json(200, {"ok": True})
            except Exception as e:
                return self._json(500, {"error": str(e)})

        return self._json(404, {"error": "not found"})


# =============================================================================
# 진입점
# =============================================================================
def serve():
    global SEM
    SEM = threading.BoundedSemaphore(int(CONFIG.get("max_concurrent", 3)))
    port = int(CONFIG["port"])
    httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)  # 루프백 only

    ff = find_ffmpeg()
    line = "=" * 64
    print(line)
    print("  싹싹김치 - 로컬 헬퍼 실행 중")
    print(line)
    print(f"  주소        : http://127.0.0.1:{port}")
    print(f"  저장 폴더   : {CONFIG['download_dir']}")
    print(f"  ffmpeg      : {'있음 (' + ff + ')' if ff else '없음 → setup_ffmpeg.bat 실행 권장'}")
    print(f"  yt-dlp      : {getattr(yt_dlp.version, '__version__', '?')}")
    print(line)
    print("  준비 완료. 토큰 입력 필요 없음 — 확장이 자동으로 연결됩니다.")
    print("  (확장: 영상 페이지에서 아이콘 → 다운로드 / YouTube 는 '이 페이지 받기')")
    print(line)
    print("  이 창을 닫으면 헬퍼가 종료됩니다. Ctrl+C 로도 종료.")
    print("  창 없이 자동 실행하려면 install_autostart.bat 를 1회 실행하세요.")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n종료합니다.")
        httpd.shutdown()


def main():
    global CONFIG
    # 무창(pythonw.exe)으로 실행되면 sys.stdout/err 가 None 이라 print() 가 죽는다.
    # → 콘솔이 없으면 로그 파일(~/.ssakssak/helper.log)로 돌려서 안전하게.
    if sys.stdout is None or sys.stderr is None:
        try:
            os.makedirs(CONFIG_DIR, exist_ok=True)
            _log = open(os.path.join(CONFIG_DIR, "helper.log"), "a", encoding="utf-8", buffering=1)
            if sys.stdout is None:
                sys.stdout = _log
            if sys.stderr is None:
                sys.stderr = _log
        except Exception:
            pass
    # 한글 Windows 콘솔(cp949)에서 print 가 UnicodeEncodeError 로 죽지 않게 UTF-8 강제.
    # (start_helper.bat 는 chcp 65001 로 콘솔도 UTF-8 로 맞춰 한글이 정상 표시됨)
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
    CONFIG = load_config()

    if len(sys.argv) > 1:
        cmd = sys.argv[1].lower()
        if cmd in ("setup-ffmpeg", "setup_ffmpeg"):
            setup_ffmpeg()
            return
        if cmd == "token":                 # 토큰만 다시 출력
            print(CONFIG["token"])
            return
        if cmd == "where":                 # 설정 파일 위치
            print(CONFIG_PATH)
            return
        print(f"알 수 없는 명령: {cmd}\n사용법: python helper.py [setup-ffmpeg|token|where]")
        return

    serve()


if __name__ == "__main__":
    main()
