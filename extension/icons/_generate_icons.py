"""아이콘 PNG 생성기 — 파란 원 + 흰 다운로드 화살표. 순수 표준 라이브러리(zlib).
   재생성: python _generate_icons.py   (extension/icons 폴더에서 실행)"""
import struct, zlib, os

BLUE = (31, 111, 235)
WHITE = (240, 246, 252)
SS = 4  # 슈퍼샘플링(안티앨리어싱)


def in_circle(x, y):
    dx, dy = x - 0.5, y - 0.5
    return dx * dx + dy * dy <= 0.46 * 0.46


def in_arrow(x, y):
    # 화살대(세로 막대)
    if 0.42 <= x <= 0.58 and 0.22 <= y <= 0.52:
        return True
    # 화살촉(아래로 향한 삼각형): (0.30,0.48)-(0.70,0.48)-(0.50,0.74)
    if 0.48 <= y <= 0.74:
        t = (y - 0.48) / (0.74 - 0.48)        # 0(위)~1(아래 꼭짓점)
        half = 0.20 * (1 - t)                  # 위에서 폭 0.40 → 아래 0
        if abs(x - 0.50) <= half:
            return True
    return False


def pixel(i, j, size):
    # 슈퍼샘플링으로 픽셀 1개의 (색, 알파) 계산.
    # 서브샘플 오프셋은 "픽셀 1개" 범위 안에서만 움직여야 한다 → size 로 나눈다.
    cov_circle = cov_arrow = 0
    for sy in range(SS):
        for sx in range(SS):
            fx = (i + (sx + 0.5) / SS) / size
            fy = (j + (sy + 0.5) / SS) / size
            if in_circle(fx, fy):
                cov_circle += 1
                if in_arrow(fx, fy):
                    cov_arrow += 1
    total = SS * SS
    a = cov_circle / total
    if a == 0:
        return (0, 0, 0, 0)
    mix = cov_arrow / cov_circle if cov_circle else 0
    r = round(BLUE[0] * (1 - mix) + WHITE[0] * mix)
    g = round(BLUE[1] * (1 - mix) + WHITE[1] * mix)
    b = round(BLUE[2] * (1 - mix) + WHITE[2] * mix)
    return (r, g, b, round(a * 255))


def make_png(size, path):
    raw = bytearray()
    for j in range(size):
        raw.append(0)  # 필터 타입 0
        for i in range(size):
            raw += bytes(pixel(i, j, size))
    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xffffffff)
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)  # RGBA 8bit
    png = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) +
           chunk(b"IDAT", zlib.compress(bytes(raw), 9)) + chunk(b"IEND", b""))
    with open(path, "wb") as f:
        f.write(png)
    print("wrote", path, size, "x", size)


if __name__ == "__main__":
    here = os.path.dirname(os.path.abspath(__file__))
    for s in (16, 32, 48, 128):
        make_png(s, os.path.join(here, f"icon{s}.png"))
