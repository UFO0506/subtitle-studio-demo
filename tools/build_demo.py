"""把字幕服務的一個工作匯出成展示版需要的靜態檔案。

用法：python tools/build_demo.py --server http://<內網位址>:<埠> --job <工作編號> --out examples/<範例名稱>
只保留展示需要的欄位；伺服器位址、內部路徑和處理紀錄的主機資訊都不會寫進輸出。
"""
import argparse
import json
import re
import urllib.request
from pathlib import Path


def fetch(url):
    with urllib.request.urlopen(url, timeout=120) as response:
        return response.read()


def plain(text):
    return re.sub(r"[，。、？！：；,.!?\s…\-「」]", "", text or "")


def stamp(seconds):
    whole = int(seconds)
    ms = int(round((seconds - whole) * 1000))
    return f"{whole // 3600:02d}:{whole % 3600 // 60:02d}:{whole % 60:02d}.{ms:03d}"


def vtt(segments, key):
    rows = ["WEBVTT", ""]
    for seg in segments:
        rows += [f"{stamp(seg['start'])} --> {stamp(seg['end'])}", seg[key], ""]
    return "\n".join(rows)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--server", required=True)
    parser.add_argument("--job", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--credit", default="")
    args = parser.parse_args()

    job = json.loads(fetch(f"{args.server}/api/jobs/{args.job}"))
    if job.get("stage") != "完成":
        raise SystemExit("這個工作還沒完成")
    out = Path(args.out)
    (out / "thumbs").mkdir(parents=True, exist_ok=True)

    (out / "source.mp4").write_bytes(fetch(f"{args.server}/files/{args.job}/source"))

    segments = []
    for seg in job["segments"]:
        changed = plain(seg["whisper"]) != plain(seg["final"])
        segments.append({
            "start": seg["start"], "end": seg["end"], "whisper": seg["whisper"],
            "final": seg["final"], "reason": seg.get("reason") or "", "changed": changed,
        })

    notes = []
    for index, note in enumerate(job.get("visual_notes") or []):
        length = note["end"] - note["start"]
        thumbs = []
        for part, fraction in enumerate((0.125, 0.375, 0.625, 0.875)):
            at = note["start"] + length * fraction
            name = f"thumbs/{index}-{part}.jpg"
            (out / name).write_bytes(fetch(f"{args.server}/api/jobs/{args.job}/thumb?t={at:.1f}"))
            thumbs.append({"t": round(at, 1), "src": name})
        notes.append({"start": note["start"], "end": note["end"], "note": note["note"], "thumbs": thumbs})

    # 處理紀錄只留「做什麼」，時間改成距離開始的秒數，不留主機或路徑資訊。
    log = []
    first = None
    for line in job.get("log") or []:
        match = re.match(r"(\d\d):(\d\d):(\d\d)\s+(.*)", line)
        if not match:
            continue
        seconds = int(match[1]) * 3600 + int(match[2]) * 60 + int(match[3])
        first = seconds if first is None else first
        text = match[4]
        if "/" in text.replace("/3", "") and re.search(r"[A-Za-z]:\\|/nas|/mnt|/home", text, re.I):
            continue
        log.append({"at": seconds - first, "text": text})

    brief = job.get("brief") or {}
    result = {
        "title": brief.get("title") or job.get("filename"),
        "summary": brief.get("summary") or "",
        "credit": args.credit,
        "duration": job.get("duration"),
        "elapsed": job.get("elapsed"),
        "language": job.get("language"),
        "think": bool(job.get("think_review")),
        "glossary": [{"term": g.get("term", ""), "note": g.get("note", "")} for g in brief.get("glossary") or []],
        "segments": segments,
        "notes": notes,
        "log": log,
    }
    (out / "result.json").write_text(json.dumps(result, ensure_ascii=False, indent=1), encoding="utf8")
    (out / "final.vtt").write_text(vtt(segments, "final"), encoding="utf8")
    (out / "whisper.vtt").write_text(vtt(segments, "whisper"), encoding="utf8")
    print(f"{len(segments)} 句，真正改字 {sum(s['changed'] for s in segments)} 句，畫面 {len(notes)} 段，紀錄 {len(log)} 行")


if __name__ == "__main__":
    main()
