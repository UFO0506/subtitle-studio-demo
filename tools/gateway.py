"""字幕服務的對外關卡。

字幕服務本身沒有登入機制，不能直接對外。這個程式只綁在本機，由通道連到外面，並且：
- 每天和同時處理的數量有上限；影片長度上限 10 分鐘。
- 訪客只能用自己拿到的憑證查自己的工作，查不到工作清單、別人的影片或原始檔。
- 回傳前只留展示需要的欄位，並濾掉可能含伺服器路徑的文字。

設定檔放在資料夾 %LOCALAPPDATA%\\subtitle-gateway\\gateway.json，不進版本庫：
{"upstream": "http://<內網位址>:<埠>"}
"""
import datetime
import http.client
import json
import os
import re
import secrets
import struct
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

MAX_SECONDS = 600
MAX_BYTES = 1024 * 1024 * 1024
CHUNK_BYTES = 20 * 1024 * 1024
DAILY_LIMIT = 10
JOB_DAYS = 7
ACTIVE_HOURS = 3
UPLOAD_IDLE_MINUTES = 20
PORT = 8096
ORIGINS = {"https://ufo0506.github.io", "http://localhost:8124"}
PRIVATE_TEXT = re.compile(r"[A-Za-z]:\\|\\\\|/(nas|mnt|home|root|tmp|opt|srv|var|media|data)\b|\d+\.\d+\.\d+\.\d+", re.I)

DATA_DIR = Path(os.environ.get("SUBTITLE_GATEWAY_DIR") or Path(os.environ["LOCALAPPDATA"]) / "subtitle-gateway")
CONFIG = json.loads((DATA_DIR / "gateway.json").read_text(encoding="utf8"))
UPSTREAM = urllib.parse.urlsplit(CONFIG["upstream"])
UPLOAD_DIR = DATA_DIR / "uploads"
UPLOAD_DIR.mkdir(exist_ok=True)
STATE_FILE = DATA_DIR / "state.json"

lock = threading.Lock()
uploads = {}


def load_state():
    try:
        return json.loads(STATE_FILE.read_text(encoding="utf8"))
    except (OSError, ValueError):
        return {"jobs": {}, "day": "", "count": 0, "active": None}


state = load_state()


def save_state():
    temp = STATE_FILE.with_suffix(".tmp")
    temp.write_text(json.dumps(state), encoding="utf8")
    temp.replace(STATE_FILE)


def today():
    return datetime.date.today().isoformat()


def remaining():
    if state["day"] != today():
        state["day"] = today()
        state["count"] = 0
    return max(0, DAILY_LIMIT - state["count"])


def upstream_json(path):
    with urllib.request.urlopen(f"{CONFIG['upstream']}{path}", timeout=30) as response:
        return json.loads(response.read())


def active_busy():
    token = state.get("active")
    if not token:
        return False
    entry = state["jobs"].get(token)
    if not entry or time.time() - entry["created"] > ACTIVE_HOURS * 3600:
        state["active"] = None
        return False
    try:
        job = upstream_json(f"/api/jobs/{entry['job']}")
    except (OSError, ValueError):
        return True
    if job.get("stage") in ("完成", "失敗"):
        state["active"] = None
        return False
    return True


def clear_old():
    now = time.time()
    for key, item in list(uploads.items()):
        if now - item["touched"] > UPLOAD_IDLE_MINUTES * 60:
            remove_upload(key)
    for token, entry in list(state["jobs"].items()):
        if now - entry["created"] > JOB_DAYS * 86400:
            del state["jobs"][token]


def remove_upload(key):
    item = uploads.pop(key, None)
    if item:
        try:
            Path(item["path"]).unlink(missing_ok=True)
        except OSError:
            pass


def mp4_duration(path):
    """讀 MP4/MOV 的 mvhd 取得影片長度；不是這兩種格式就回傳 None。"""
    with open(path, "rb") as f:
        size = os.fstat(f.fileno()).st_size
        pos = 0
        first = True
        while pos + 8 <= size:
            f.seek(pos)
            length, kind = struct.unpack(">I4s", f.read(8))
            header = 8
            if length == 1:
                length = struct.unpack(">Q", f.read(8))[0]
                header = 16
            elif length == 0:
                length = size - pos
            if length < header:
                return None
            if first and kind not in (b"ftyp", b"moov", b"mdat", b"wide", b"free", b"skip"):
                return None
            first = False
            if kind == b"moov":
                end = pos + length
                inner = pos + header
                while inner + 8 <= end:
                    f.seek(inner)
                    sub, name = struct.unpack(">I4s", f.read(8))
                    if sub < 8:
                        return None
                    if name == b"mvhd":
                        version = f.read(1)[0]
                        f.read(3)
                        if version == 1:
                            f.read(16)
                            scale, ticks = struct.unpack(">IQ", f.read(12))
                        else:
                            f.read(8)
                            scale, ticks = struct.unpack(">II", f.read(8))
                        return ticks / scale if scale else None
                    inner += sub
                return None
            pos += length
    return None


def forward(item):
    """把暫存影片交給字幕服務，回傳工作編號。"""
    boundary = secrets.token_hex(16)
    fields = {"think_review": "1" if item["think"] else "0", "user_context": item["context"]}
    head = b""
    for name, value in fields.items():
        head += f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode("utf8")
    filename = f"visitor-{int(time.time())}.mp4"
    head += f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{filename}"\r\nContent-Type: video/mp4\r\n\r\n'.encode("utf8")
    tail = f"\r\n--{boundary}--\r\n".encode("utf8")
    size = os.path.getsize(item["path"])
    conn = http.client.HTTPConnection(UPSTREAM.hostname, UPSTREAM.port, timeout=600)
    conn.putrequest("POST", "/api/upload")
    conn.putheader("Content-Type", f"multipart/form-data; boundary={boundary}")
    conn.putheader("Content-Length", str(len(head) + size + len(tail)))
    conn.endheaders()
    conn.send(head)
    with open(item["path"], "rb") as f:
        while True:
            block = f.read(1024 * 1024)
            if not block:
                break
            conn.send(block)
    conn.send(tail)
    response = conn.getresponse()
    body = response.read()
    conn.close()
    if response.status >= 300:
        raise OSError("upstream refused")
    return json.loads(body)["id"]


def clean(text):
    text = str(text or "")
    return "" if PRIVATE_TEXT.search(text) else text


def public_job(job):
    brief = job.get("brief") or {}
    log = []
    first = None
    for line in job.get("log") or []:
        match = re.match(r"(\d\d):(\d\d):(\d\d)\s+(.*)", line)
        text = clean(match[4]) if match else ""
        if not text:
            continue
        seconds = int(match[1]) * 3600 + int(match[2]) * 60 + int(match[3])
        first = seconds if first is None else first
        log.append({"at": seconds - first, "text": text})
    return {
        "stage": job.get("stage"),
        "progress": job.get("progress") or 0,
        "detail": clean(job.get("detail")),
        "queue_position": job.get("queue_position"),
        "duration": job.get("duration"),
        "elapsed": job.get("elapsed"),
        "language": job.get("language"),
        "title": clean(brief.get("title")),
        "summary": clean(brief.get("summary")),
        "glossary": [{"term": g.get("term", ""), "note": g.get("note", "")} for g in brief.get("glossary") or []],
        "segments": [{"start": s["start"], "end": s["end"], "whisper": s["whisper"], "final": s["final"], "reason": s.get("reason") or ""} for s in job.get("segments") or []],
        "notes": [{"start": n["start"], "end": n["end"], "note": n.get("note", "")} for n in job.get("visual_notes") or []],
        "log": log,
    }


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    timeout = 300
    server_version = "gateway"
    sys_version = ""

    def log_message(self, *args):
        pass

    def cors(self):
        origin = self.headers.get("Origin")
        if origin in ORIGINS:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")

    def reply(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf8")
        self.send_response(status)
        self.cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def deny(self, status, message):
        self.close_connection = True
        self.reply(status, {"error": message})

    def read_body(self, limit):
        length = int(self.headers.get("Content-Length") or -1)
        if length < 0 or length > limit:
            return None
        return self.rfile.read(length)

    def do_OPTIONS(self):
        self.send_response(204)
        self.cors()
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Max-Age", "600")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        url = urllib.parse.urlsplit(self.path)
        if url.path == "/api/status":
            with lock:
                clear_old()
                busy = active_busy() or bool(uploads)
                left = remaining()
                save_state()
            self.reply(200, {"maxSeconds": MAX_SECONDS, "maxBytes": MAX_BYTES, "chunkBytes": CHUNK_BYTES, "remainingToday": left, "busy": busy})
            return
        match = re.fullmatch(r"/api/jobs/([\w-]{32,})(?:/(thumb))?", url.path)
        if not match:
            self.deny(404, "找不到。")
            return
        with lock:
            entry = state["jobs"].get(match[1])
        if not entry:
            self.deny(404, "這個工作不存在或已過期。")
            return
        try:
            if match[2] == "thumb":
                query = urllib.parse.parse_qs(url.query)
                at = float(query.get("t", ["0"])[0])
                if not 0 <= at <= MAX_SECONDS + 60:
                    self.deny(400, "時間不正確。")
                    return
                with urllib.request.urlopen(f"{CONFIG['upstream']}/api/jobs/{entry['job']}/thumb?t={at:.1f}", timeout=60) as response:
                    image = response.read()
                self.send_response(200)
                self.cors()
                self.send_header("Content-Type", "image/jpeg")
                self.send_header("Content-Length", str(len(image)))
                self.send_header("Cache-Control", "private, max-age=86400")
                self.end_headers()
                self.wfile.write(image)
                return
            self.reply(200, public_job(upstream_json(f"/api/jobs/{entry['job']}")))
        except (OSError, ValueError):
            self.deny(502, "暫時連不到字幕服務，請稍後再試。")

    def do_POST(self):
        path = urllib.parse.urlsplit(self.path).path
        if path == "/api/uploads":
            self.start_upload()
            return
        match = re.fullmatch(r"/api/uploads/([\w-]{32,})/finish", path)
        if match:
            self.finish_upload(match[1])
            return
        self.deny(404, "找不到。")

    def start_upload(self):
        body = self.read_body(20000)
        try:
            info = json.loads(body or b"")
            size = int(info["size"])
        except (ValueError, KeyError, TypeError):
            self.deny(400, "資料不正確。")
            return
        if not 0 < size <= MAX_BYTES:
            self.deny(413, "影片不能超過 1 GB。")
            return
        with lock:
            clear_old()
            if remaining() <= 0:
                self.deny(429, "今天的處理額度用完了，請明天再試。")
                return
            if uploads or active_busy():
                self.deny(429, "目前有另一支影片正在處理，請稍後再試。")
                return
            key = secrets.token_urlsafe(32)
            target = UPLOAD_DIR / f"{secrets.token_hex(16)}.bin"
            target.touch()
            uploads[key] = {
                "path": str(target), "size": size, "received": 0, "touched": time.time(),
                "context": str(info.get("context") or "")[:2000], "think": bool(info.get("think", True)),
            }
        self.reply(200, {"uploadId": key})

    def do_PUT(self):
        url = urllib.parse.urlsplit(self.path)
        match = re.fullmatch(r"/api/uploads/([\w-]{32,})", url.path)
        if not match:
            self.deny(404, "找不到。")
            return
        with lock:
            item = uploads.get(match[1])
        if not item:
            self.deny(404, "上傳已過期，請重新開始。")
            return
        try:
            offset = int(urllib.parse.parse_qs(url.query).get("offset", ["-1"])[0])
        except ValueError:
            offset = -1
        block = self.read_body(CHUNK_BYTES)
        if block is None:
            self.deny(413, "分段太大。")
            return
        with lock:
            if match[1] not in uploads:
                self.deny(404, "上傳已過期，請重新開始。")
                return
            if offset == item["received"] - len(block) and block:
                self.reply(200, {"received": item["received"]})  # 同一段重送
                return
            if offset != item["received"] or item["received"] + len(block) > item["size"]:
                self.deny(409, "上傳順序不正確，請重新開始。")
                return
            with open(item["path"], "ab") as f:
                f.write(block)
            item["received"] += len(block)
            item["touched"] = time.time()
            received = item["received"]
        self.reply(200, {"received": received})

    def finish_upload(self, key):
        with lock:
            item = uploads.get(key)
        if not item:
            self.deny(404, "上傳已過期，請重新開始。")
            return
        if item["received"] != item["size"]:
            self.deny(409, "影片還沒傳完。")
            return
        try:
            seconds = mp4_duration(item["path"])
        except (OSError, struct.error, IndexError):
            seconds = None
        if seconds is None:
            with lock:
                remove_upload(key)
            self.deny(415, "目前只接受 MP4 或 MOV 影片。")
            return
        if seconds > MAX_SECONDS + 1:
            with lock:
                remove_upload(key)
            self.deny(413, "影片不能超過 10 分鐘。")
            return
        try:
            job = forward(item)
        except (OSError, ValueError, KeyError):
            with lock:
                remove_upload(key)
            self.deny(502, "暫時連不到字幕服務，請稍後再試。")
            return
        with lock:
            remove_upload(key)
            token = secrets.token_urlsafe(32)
            state["jobs"][token] = {"job": job, "created": time.time()}
            state["active"] = token
            remaining()
            state["count"] += 1
            save_state()
        self.reply(200, {"token": token, "duration": seconds})


def main():
    for leftover in UPLOAD_DIR.glob("*.bin"):
        leftover.unlink(missing_ok=True)
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    server.daemon_threads = True
    server.serve_forever()


if __name__ == "__main__":
    main()
