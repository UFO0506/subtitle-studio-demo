// 展示版只讀取預先產生的結果：examples/<名稱>/ 裡的影片、字幕與 result.json。
const app = document.getElementById("app");
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const clock = (t) => { const s = Math.floor(t || 0); return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`; };
const span = (sec) => (sec >= 60 ? `${Math.floor(sec / 60)} 分 ${Math.round(sec % 60)} 秒` : `${Math.round(sec)} 秒`);

const ui = { base: "", data: null, tab: "subs", onlyChanged: true, mode: "final", term: null };

function noteHtml(text) {
  let html = "";
  let open = false;
  const inline = (x) => esc(x).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  for (const raw of String(text || "").split("\n")) {
    const line = raw.trim();
    if (!line || /^[*\-•]$/.test(line)) continue;
    const item = line.match(/^[*\-•]\s+(.*)/);
    const head = line.match(/^\d+\.\s*(.*)/);
    if (item) {
      if (!open) { html += "<ul>"; open = true; }
      html += `<li>${inline(item[1])}</li>`;
      continue;
    }
    if (open) { html += "</ul>"; open = false; }
    html += head ? `<h4>${esc(head[1].replace(/\*\*/g, ""))}</h4>` : `<div>${inline(line)}</div>`;
  }
  return html + (open ? "</ul>" : "");
}

// 把處理紀錄歸成四個階段，時間都由紀錄算出，不是手寫的。
function stages(d) {
  const at = (word) => { const hit = d.log.find((l) => l.text.includes(word)); return hit ? hit.at : null; };
  const listen = at("擷取音訊") ?? 0;
  const see = at("看畫面");
  const sum = at("整理全片");
  const review = at("審核字幕");
  const end = at("產生字幕檔") ?? d.elapsed;
  const changed = d.segments.filter((s) => s.changed).length;
  return [
    { name: "聽", tool: "Whisper", text: `把語音聽寫成 ${d.segments.length} 句初稿，這時還會有同音錯字。`, sec: see - listen },
    { name: "看", tool: "Qwen", text: `把影片切成 ${d.notes.length} 段，看畫面裡的場景、人物和文字。`, sec: sum - see },
    { name: "想", tool: "Qwen", text: `整理全片在講什麼，列出 ${d.glossary.length} 個名詞和可能聽錯的寫法。`, sec: review - sum },
    { name: "改", tool: "Qwen", text: `逐句對照畫面和名詞表審核，真正改字 ${changed} 句，並寫下每句的理由。`, sec: end - review },
  ];
}

function rowHtml(s, i) {
  const old = s.changed ? `<div class="old">${esc(s.whisper)}</div>` : "";
  const why = s.reason ? `<div class="why">${esc(s.reason)}</div>` : "";
  return `<div class="row ${s.changed ? "" : "same"}" data-i="${i}"><button class="time" data-t="${s.start}">${clock(s.start)}</button><div>${old}<div class="fin">${esc(s.final)}</div>${why}</div></div>`;
}

function subsTab(d) {
  const list = d.segments.map((s, i) => [s, i]).filter(([s]) => !ui.onlyChanged || s.changed);
  const changed = d.segments.filter((s) => s.changed).length;
  return `<div class="bar"><span class="note">刪除線是 Whisper 初稿，粗體是 AI 修正後的字幕。點時間可跳到該處。</span>
    <div class="seg"><button data-filter="1" aria-pressed="${ui.onlyChanged}">改字 ${changed} 句</button><button data-filter="0" aria-pressed="${!ui.onlyChanged}">全部 ${d.segments.length} 句</button></div></div>
    <div class="scroller" id="scroll">${list.map(([s, i]) => rowHtml(s, i)).join("")}</div>`;
}

function seeTab(d) {
  const rows = d.notes.map((n, i) => {
    const fixes = d.segments.filter((s) => s.changed && s.start < n.end && s.end > n.start);
    const thumbs = n.thumbs.map((t) => `<button data-t="${t.t}" aria-label="跳到 ${clock(t.t)}"><img loading="lazy" src="${ui.base}/${t.src}" alt="${clock(t.t)} 的畫面"></button>`).join("");
    const fixText = fixes.length
      ? `<div class="fixes"><b>這段時間改了 ${fixes.length} 句</b>${fixes.map((s) => `<div>${clock(s.start)}　${esc(s.whisper)} → ${esc(s.final)}</div>`).join("")}</div>`
      : "";
    return `<article class="win" data-a="${n.start}" data-b="${n.end}"><h3><button class="time" data-t="${n.start}">${clock(n.start)}–${clock(n.end)}</button><span class="note">第 ${i + 1} / ${d.notes.length} 段</span></h3>
      <div class="thumbs">${thumbs}</div><div class="notes">${noteHtml(n.note)}</div>${fixText}</article>`;
  }).join("");
  return `<p class="note" style="margin-bottom:8px">這是 AI 看完每段畫面後自己寫下的紀錄，可能有認錯的地方，這裡不做修改。</p><div class="scroller" id="scroll">${rows}</div>`;
}

function thinkTab(d) {
  const steps = stages(d).map((s, i) => `<li><div class="n">${s.name}</div><div><strong>${i + 1}. ${esc(s.tool)}・花了 ${span(s.sec)}</strong><span>${esc(s.text)}</span></div></li>`).join("");
  const chips = d.glossary.map((g, i) => `<button class="chip" data-term="${i}" aria-pressed="${ui.term === i}">${esc(g.term)}</button>`).join("");
  const term = ui.term !== null ? d.glossary[ui.term].note : "點一個名詞，看 AI 替自己記下的提醒。";
  return `<div class="scroller" id="scroll"><ol class="steps">${steps}</ol>
    <div class="section"><h3>AI 對整支影片的理解</h3><p>${esc(d.summary)}</p></div>
    <div class="section"><h3>AI 替自己整理的名詞表</h3><div class="chips">${chips}</div><p class="term-note" role="status">${esc(term)}</p></div></div>`;
}

function renderTab() {
  const box = document.getElementById("tab");
  box.innerHTML = { subs: subsTab, see: seeTab, think: thinkTab }[ui.tab](ui.data);
  document.querySelectorAll("[data-tab]").forEach((b) => b.setAttribute("aria-selected", b.dataset.tab === ui.tab));
  sync(true);
}

// 影片播到哪，「AI 此刻的判斷」和右邊清單就跟到哪。
let lastSeg = -2;
let lastWin = -2;
function sync(force) {
  const video = document.getElementById("video");
  const d = ui.data;
  const t = video.currentTime;
  document.getElementById("live-time").textContent = clock(t);
  const i = d.segments.findIndex((s) => t >= s.start && t < s.end);
  if (i !== lastSeg || force) {
    lastSeg = i;
    const live = document.getElementById("live");
    if (i < 0) {
      live.innerHTML = `<p class="note">這一刻沒有字幕。按下播放，這裡會顯示 AI 對當下這句的判斷。</p>`;
    } else {
      const s = d.segments[i];
      live.innerHTML = s.changed
        ? `<div class="pair"><div class="from">${esc(s.whisper)}</div><div class="to">${esc(s.final)}</div></div><div class="why">${esc(s.reason)}</div>`
        : `<div class="same">${esc(s.final)}</div><div class="why">${esc(s.reason || "初稿的字沒有問題。")}</div>`;
    }
    document.querySelectorAll(".row.now").forEach((r) => r.classList.remove("now"));
    const row = document.querySelector(`.row[data-i="${i}"]`);
    const scroll = document.getElementById("scroll");
    if (row) {
      row.classList.add("now");
      if (scroll && !video.paused) scroll.scrollTo({ top: row.offsetTop - 40, behavior: "smooth" });
    }
  }
  const wins = [...document.querySelectorAll(".win")];
  const w = wins.findIndex((el) => t >= +el.dataset.a && t < +el.dataset.b);
  if (w !== lastWin || force) {
    lastWin = w;
    wins.forEach((el, k) => el.classList.toggle("now", k === w));
    const scroll = document.getElementById("scroll");
    if (w >= 0 && scroll && !video.paused) scroll.scrollTo({ top: wins[w].offsetTop, behavior: "smooth" });
  }
}

function setMode(mode) {
  ui.mode = mode;
  const video = document.getElementById("video");
  for (const track of video.textTracks) {
    track.mode = track.language === (mode === "final" ? "zh-Hant" : "zh") ? "showing" : "disabled";
  }
  document.querySelectorAll("[data-mode]").forEach((b) => b.setAttribute("aria-pressed", b.dataset.mode === mode));
}

function renderPage() {
  const d = ui.data;
  const changed = d.segments.filter((s) => s.changed).length;
  const punct = d.segments.filter((s) => !s.changed && s.final !== s.whisper).length;
  app.innerHTML = `
    <section class="panel intro">
      <div><h2>${esc(d.title)}</h2><p class="summary">${esc(d.summary)}</p></div>
      <div class="stats">
        <div><b>${d.segments.length}</b><span>句字幕</span></div>
        <div><b>${changed}</b><span>句真正改字</span></div>
        <div><b>${punct}</b><span>句只補標點</span></div>
        <div><b>${span(d.elapsed)}</b><span>處理 ${span(d.duration)} 的影片</span></div>
      </div>
    </section>
    <div class="studio">
      <div class="left">
        <section class="panel">
          <video id="video" controls playsinline preload="metadata">
            <source src="${ui.base}/source.mp4" type="video/mp4">
            <track kind="subtitles" srclang="zh-Hant" label="AI 修正後" src="${ui.base}/final.vtt" default>
            <track kind="subtitles" srclang="zh" label="Whisper 初稿" src="${ui.base}/whisper.vtt">
          </video>
          <div class="modes"><span class="label">影片字幕</span>
            <div class="seg"><button data-mode="final" aria-pressed="true">AI 修正後</button><button data-mode="whisper" aria-pressed="false">Whisper 初稿</button></div>
          </div>
        </section>
        <section class="panel live" aria-label="AI 此刻的判斷">
          <h2>AI 此刻的判斷 <small id="live-time">00:00</small></h2>
          <div id="live"></div>
        </section>
      </div>
      <section class="panel">
        <div class="tabs" role="tablist">
          <button role="tab" data-tab="subs" aria-selected="true">修正的字幕</button>
          <button role="tab" data-tab="see" aria-selected="false">AI 看到的畫面</button>
          <button role="tab" data-tab="think" aria-selected="false">AI 的思考過程</button>
        </div>
        <div id="tab"></div>
      </section>
    </div>
    <footer class="panel">
      <h2>關於這個展示版</h2>
      <ul>
        <li>這裡的字幕和紀錄都是完整服務實際跑出來的結果，沒有手動修改。</li>
        <li>展示版不能上傳新影片。完整服務需要 GPU，跑在私人伺服器上，所以這裡展示預先跑好的範例。</li>
        <li>AI 可能出錯，例如畫面紀錄裡的錯字，所以字幕仍應由人確認。</li>
        ${d.credit ? `<li>範例影片：${esc(d.credit)}。</li>` : ""}
      </ul>
    </footer>`;
  const video = document.getElementById("video");
  video.addEventListener("timeupdate", () => sync(false));
  video.addEventListener("seeked", () => sync(true));
  video.addEventListener("loadedmetadata", () => setMode(ui.mode));
  setMode(ui.mode);
  renderTab();
}

document.addEventListener("click", (event) => {
  const el = event.target.closest("button");
  if (!el) return;
  const d = el.dataset;
  const video = document.getElementById("video");
  if (d.t !== undefined) {
    video.currentTime = +d.t;
    video.play().catch(() => {});
  } else if (d.tab) {
    ui.tab = d.tab;
    renderTab();
  } else if (d.filter !== undefined) {
    ui.onlyChanged = d.filter === "1";
    renderTab();
  } else if (d.mode) {
    setMode(d.mode);
  } else if (d.term !== undefined) {
    ui.term = +d.term;
    renderTab();
  }
});

async function boot() {
  try {
    const names = await (await fetch("examples/index.json")).json();
    ui.base = `examples/${names[0]}`;
    const response = await fetch(`${ui.base}/result.json`);
    if (!response.ok) throw new Error("result");
    ui.data = await response.json();
    renderPage();
  } catch {
    app.innerHTML = `<section class="panel"><h2>資料載入失敗</h2><p class="note">請重新整理一次。</p></section>`;
  }
}
boot();
