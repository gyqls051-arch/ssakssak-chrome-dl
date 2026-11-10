import io
from types import SimpleNamespace as NS
import pytest
import helper

@pytest.mark.parametrize("origin", ["null", "", "chrome-extension://"+"a"*32,"https://evil.example"])
def test_all_origins_require_secret(origin):
 helper.CONFIG={"token":"s"*32}
 h=NS(headers={"Origin":origin})
 assert not helper.Handler._allowed(h)
 h.headers["X-SSAK-Token"]="s"*32
 assert helper.Handler._allowed(h)
 helper.CONFIG={}
 h.headers["X-SSAK-Token"]=""
 assert not helper.Handler._allowed(h)

@pytest.mark.parametrize("length,body", [("-1",b""),("262145",b""),("3",b"[] "),("x",b"")])
def test_reject_invalid_request_body(length,body):
 h=NS(headers={"Content-Length":length},rfile=io.BytesIO(body))
 with pytest.raises(ValueError):helper.Handler._read_json(h)


def test_http_consumer_rejects_null_origin_and_accepts_pairing(monkeypatch):
 import threading, http.client
 monkeypatch.setattr(helper,"CONFIG",{"token":"s"*32,"download_dir":"fixture"})
 monkeypatch.setattr(helper,"find_ffmpeg",lambda:None)
 server=helper.ThreadingHTTPServer(("127.0.0.1",0),helper.Handler)
 thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
 try:
  for token,status in [(None,403),("s"*32,200)]:
   conn=http.client.HTTPConnection("127.0.0.1",server.server_port,timeout=2)
   headers={"Origin":"null"}
   if token:headers["X-SSAK-Token"]=token
   conn.request("GET","/health",headers=headers)
   response=conn.getresponse();assert response.status==status;response.read();conn.close()
  for bad_origin in ["https://evil.example", "null"]:
   conn=http.client.HTTPConnection("127.0.0.1",server.server_port,timeout=2)
   conn.request("POST","/clear-finished",body=b"{}",headers={"Origin":bad_origin,"X-SSAK-Token":"s"*32,"Content-Type":"application/json"})
   response=conn.getresponse();assert response.status==403;response.read();conn.close()
 finally:server.shutdown();server.server_close();thread.join(2)


@pytest.mark.parametrize("bad_url", ["-o evil", "--exec=calc", "file:///etc/passwd", "http://127.0.0.1:8787/health", "http://localhost:3000", "http://169.254.169.254/latest"])
def test_validate_target_url_blocks_unsafe_targets(bad_url):
 with pytest.raises(ValueError):
  helper.validate_target_url(bad_url)


def test_build_safe_cli_args_inserts_double_dash():
 assert helper.build_safe_cli_args(["xdg-open"], "-weird-dir") == ["xdg-open", "--", "-weird-dir"]
