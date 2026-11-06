// 展示版只讀取預先產生的結果：examples/<名稱>/ 裡的影片、字幕與 result.json。
const app = document.getElementById("app");
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const clock = (t) => { const s = Math.floor(t || 0); return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`; };
const span = (sec) => (sec >= 60 ? `${Math.floor(sec / 60)} 分 ${Math.round(sec % 60)} 秒` : `${Math.round(sec)} 秒`);

const ui = {
  base: "", example: null, data: null, media: null, view: "example", tab: "subs", onlyChanged: true, mode: "final", term: null,
  gateway: "", status: null, file: null, fileSeconds: null, token: null, job: null, phase: "form", sent: 0, error: "", poll: null,
};
const JOB_KEY = "subtitle-demo-job";

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
    const thumbs = n.thumbs.map((t) => `<button data-t="${t.t}" aria-label="跳到 ${clock(t.t)}"><img loading="lazy" src="${esc(t.url)}" alt="${clock(t.t)} 的畫面"></button>`).join("");
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
            ${ui.media.video ? `<source src="${esc(ui.media.video)}">` : ""}
            <track kind="subtitles" srclang="zh-Hant" label="AI 修正後" src="${esc(ui.media.final)}" default>
            <track kind="subtitles" srclang="zh" label="Whisper 初稿" src="${esc(ui.media.whisper)}">
          </video>
          <div class="modes"><span class="label">影片字幕</span>
            <div class="seg"><button data-mode="final" aria-pressed="true">AI 修正後</button><button data-mode="whisper" aria-pressed="false">Whisper 初稿</button></div>
          </div>
          ${ui.view === "mine" ? mineActions() : ""}
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
      <h2>${ui.view === "mine" ? "關於這個結果" : "關於這個範例"}</h2>
      <ul>
        <li>這裡的字幕和紀錄都是字幕服務實際跑出來的結果，沒有手動修改。</li>
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

// ---- 切換範例與自己的影片 ----

function showExample() {
  ui.view = "example";
  ui.data = ui.example;
  ui.media = { video: `${ui.base}/source.mp4`, final: `${ui.base}/final.vtt`, whisper: `${ui.base}/whisper.vtt` };
  resetPlayerState();
  renderViewTabs();
  renderPage();
}

function resetPlayerState() {
  ui.tab = "subs";
  ui.onlyChanged = true;
  ui.mode = "final";
  ui.term = null;
  lastSeg = -2;
  lastWin = -2;
}

function renderViewTabs() {
  document.querySelectorAll("[data-view]").forEach((b) => {
    if (b.closest(".views")) b.setAttribute("aria-pressed", b.dataset.view === ui.view);
  });
}

// ---- 用自己的影片 ----

const plain = (t) => String(t || "").replace(/[，。、？！：；,.!?\s…\-「」]/g, "");
const stamp = (t, comma) => {
  const ms = Math.round((t % 1) * 1000) % 1000;
  const s = Math.floor(t);
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}${comma ? "," : "."}${p(ms, 3)}`;
};
const oneLine = (t) => String(t).replace(/\s*\n\s*/g, " ");
const toVtt = (segs, key) => `WEBVTT\n\n${segs.map((s) => `${stamp(s.start)} --> ${stamp(s.end)}\n${oneLine(s[key])}\n`).join("\n")}`;
const toSrt = (segs) => segs.map((s, i) => `${i + 1}\n${stamp(s.start, true)} --> ${stamp(s.end, true)}\n${oneLine(s.final)}\n`).join("\n");
const textUrl = (text) => URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));

function fromJob(job) {
  const segments = job.segments.map((s) => ({ ...s, changed: plain(s.whisper) !== plain(s.final) }));
  const notes = job.notes.map((n) => {
    const len = n.end - n.start;
    const thumbs = [0.125, 0.375, 0.625, 0.875].map((f) => {
      const t = Math.round((n.start + len * f) * 10) / 10;
      return { t, url: `${ui.gateway}/api/jobs/${ui.token}/thumb?t=${t}` };
    });
    return { ...n, thumbs };
  });
  return { ...job, title: job.title || (ui.file ? ui.file.name : "你的影片"), segments, notes };
}

function mineActions() {
  const reselect = ui.media.video ? "" : `<p class="note" style="margin-top:8px">影片只在選取它的分頁裡播放。重新選取同一支影片就能對照字幕：</p><input type="file" id="reselect" accept="video/mp4,video/quicktime,.mp4,.mov,.m4v">`;
  return `<div class="modes"><span class="label">下載字幕</span><a class="btn" href="${esc(ui.media.final)}" download="subtitles.vtt">VTT</a><a class="btn" href="${esc(textUrl(toSrt(ui.data.segments)))}" download="subtitles.srt">SRT</a><button class="btn" data-new-video>換一支影片</button></div>${reselect}`;
}

function showResult(job) {
  ui.data = fromJob(job);
  ui.media = {
    video: ui.file ? URL.createObjectURL(ui.file) : "",
    final: textUrl(toVtt(ui.data.segments, "final")),
    whisper: textUrl(toVtt(ui.data.segments, "whisper")),
  };
  resetPlayerState();
  renderPage();
}

async function api(path, options = {}) {
  const response = await fetch(`${ui.gateway}${path}`, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || "連線失敗，請稍後再試。");
  return payload;
}

function renderMine() {
  if (ui.phase === "working") { renderWorking(); return; }
  if (ui.phase === "offline") {
    app.innerHTML = `<section class="panel upload"><h2>字幕服務目前沒有開啟</h2><p class="note">完整處理需要作者的主機開著。你可以先看範例，或稍後再回來。</p><div class="actions"><button class="btn primary" data-view="example">看範例</button><button class="btn" data-retry>重新連線</button></div></section>`;
    return;
  }
  const st = ui.status;
  const full = st.remainingToday <= 0;
  const note = full ? "今天的處理額度用完了，請明天再試。" : st.busy ? "目前有另一支影片正在處理，請稍後再試。" : `今天還能處理 ${st.remainingToday} 支。`;
  app.innerHTML = `<section class="panel upload">
    <h2>用你的影片試試看</h2>
    <p class="note">${esc(note)}處理時間約為影片長度的 1～3 倍。</p>
    <form id="upload-form">
      <label for="file">影片（MP4 或 MOV，${Math.floor(st.maxSeconds / 60)} 分鐘以內，最大 1 GB）</label>
      <input type="file" id="file" name="file" accept="video/mp4,video/quicktime,.mp4,.mov,.m4v" required>
      <p class="note" id="file-info" role="status"></p>
      <label for="context">影片說明與自訂名詞（選填，用來教 AI）</label>
      <textarea id="context" name="context" rows="4" maxlength="2000" placeholder="例如：這是我的系上專題發表，說話的人有小明和阿凱。常講的詞：卷積、資料增強。"></textarea>
      <label class="check"><input type="checkbox" name="think" checked> 審核時開啟思考（較準確、較慢）</label>
      <div class="warn"><strong>上傳前請注意</strong>
        <ul>
          <li>影片會傳到作者的私人伺服器處理，處理後會留在伺服器上，作者看得到。</li>
          <li>請不要上傳機密、私人或你沒有權利使用的影片。</li>
        </ul>
        <label class="check"><input type="checkbox" name="agree" required> 我了解，也有權使用這支影片</label>
      </div>
      ${ui.error ? `<p class="err" role="alert">${esc(ui.error)}</p>` : ""}
      <div class="actions"><button class="btn primary" type="submit" ${full || st.busy ? "disabled" : ""}>上傳並開始處理</button></div>
    </form>
  </section>`;
}

function renderWorking() {
  const job = ui.job;
  const total = ui.file ? ui.file.size : 0;
  let title = "上傳中";
  let detail = total ? `已傳 ${Math.round((ui.sent / total) * 100)}%，請不要關閉這個分頁。` : "";
  let progress = total ? ui.sent / total : 0;
  if (job) {
    title = job.stage || "處理中";
    detail = job.queue_position > 1 ? `前面還有 ${job.queue_position - 1} 個工作。` : job.detail || "";
    progress = job.progress;
  }
  app.innerHTML = `<section class="panel upload" aria-live="polite"><h2>${esc(title)}</h2>
    <div class="progress"><span style="width:${Math.round(progress * 100)}%"></span></div>
    <p class="note">${esc(detail)}</p>
    ${job ? `<p class="note">可以先離開，用同一個瀏覽器回到這裡就能看到結果。</p>` : ""}
    ${job && job.log.length ? `<ol class="joblog">${job.log.slice(-6).map((l) => `<li>${esc(l.text)}</li>`).join("")}</ol>` : ""}
  </section>`;
}

async function openMine() {
  ui.view = "mine";
  renderViewTabs();
  stopPoll();
  app.innerHTML = `<section class="panel upload"><p class="note">連線中…</p></section>`;
  const hasJob = loadJobToken();
  await refreshGateway();
  if (hasJob) { startPolling(); return; }
  ui.phase = "form";
  try {
    if (!ui.gateway) throw new Error("off");
    ui.status = await api("/api/status");
  } catch {
    ui.phase = "offline";
  }
  if (ui.view === "mine") renderMine();
}

// 通道重開後網址會變，所以每次都讀最新的 config.json。
async function refreshGateway() {
  try {
    const config = await (await fetch(`config.json?t=${Date.now()}`, { cache: "no-store" })).json();
    ui.gateway = config.gateway || "";
  } catch { /* 讀不到就沿用目前的位址 */ }
}

function loadJobToken() {
  try {
    const saved = JSON.parse(localStorage.getItem(JOB_KEY) || "null");
    if (saved && saved.token && saved.gateway) {
      ui.token = saved.token;
      ui.gateway = saved.gateway;
      return true;
    }
  } catch { /* 瀏覽器不允許儲存時，就當作沒有進行中的工作 */ }
  return false;
}
function saveJobToken() {
  try { localStorage.setItem(JOB_KEY, JSON.stringify({ token: ui.token, gateway: ui.gateway })); } catch { /* 同上 */ }
}
function clearJobToken() {
  try { localStorage.removeItem(JOB_KEY); } catch { /* 同上 */ }
  ui.token = null;
  ui.job = null;
}
function stopPoll() {
  if (ui.poll) clearTimeout(ui.poll);
  ui.poll = null;
}

async function startPolling() {
  ui.phase = "working";
  stopPoll();
  try {
    const job = await api(`/api/jobs/${ui.token}`);
    ui.job = job;
    if (ui.view !== "mine") return;
    if (job.stage === "完成") { showResult(job); return; }
    if (job.stage === "失敗") {
      clearJobToken();
      ui.error = "處理失敗，請換一支影片再試。";
      await openMine();
      return;
    }
    renderWorking();
    ui.poll = setTimeout(startPolling, 4000);
  } catch (error) {
    if (ui.view !== "mine") return;
    if (/不存在|過期/.test(error.message)) {
      clearJobToken();
      await openMine();
      return;
    }
    // 通道重開後舊網址會失效；保留憑證，稍後再試。
    app.innerHTML = `<section class="panel upload"><h2>暫時連不到字幕服務</h2><p class="note">你的工作沒有遺失，會自動重試。</p></section>`;
    ui.poll = setTimeout(async () => { await refreshGateway(); startPolling(); }, 15000);
  }
}

function checkFile(file) {
  return new Promise((resolve) => {
    const probe = document.createElement("video");
    const url = URL.createObjectURL(file);
    const done = (value) => { URL.revokeObjectURL(url); resolve(value); };
    probe.preload = "metadata";
    probe.onloadedmetadata = () => done(probe.duration);
    probe.onerror = () => done(null);
    probe.src = url;
  });
}

async function onPick(input) {
  const file = input.files[0];
  const info = document.getElementById("file-info");
  ui.file = file || null;
  ui.fileSeconds = null;
  if (!file) { info.textContent = ""; return; }
  const seconds = await checkFile(file);
  ui.fileSeconds = seconds;
  if (seconds === null) info.textContent = "瀏覽器無法預覽這支影片，仍可以試著上傳；伺服器會再檢查格式和長度。";
  else if (seconds > ui.status.maxSeconds) info.textContent = `這支影片有 ${clock(seconds)}，超過 10 分鐘，請換一支或先剪短。`;
  else info.textContent = `影片長度 ${clock(seconds)}，大小 ${(file.size / 1048576).toFixed(1)} MB。`;
}

async function submitUpload(form) {
  const file = ui.file;
  const fail = (message) => { ui.error = message; ui.phase = "form"; renderMine(); };
  if (!file) return;
  if (file.size > ui.status.maxBytes) { ui.error = "影片不能超過 1 GB。"; renderMine(); return; }
  if (ui.fileSeconds !== null && ui.fileSeconds > ui.status.maxSeconds) { ui.error = "影片不能超過 10 分鐘。"; renderMine(); return; }
  const context = form.elements.context.value;
  const think = form.elements.think.checked;
  ui.error = "";
  ui.phase = "working";
  ui.job = null;
  ui.sent = 0;
  renderWorking();
  try {
    const { uploadId } = await api("/api/uploads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ size: file.size, context, think }),
    });
    const chunk = ui.status.chunkBytes;
    for (let offset = 0; offset < file.size; offset += chunk) {
      const part = file.slice(offset, offset + chunk);
      for (let attempt = 1; ; attempt += 1) {
        try {
          await api(`/api/uploads/${uploadId}?offset=${offset}`, { method: "PUT", body: part });
          break;
        } catch (error) {
          if (attempt >= 3) throw error;
        }
      }
      ui.sent = Math.min(file.size, offset + chunk);
      renderWorking();
    }
    const { token } = await api(`/api/uploads/${uploadId}/finish`, { method: "POST" });
    ui.token = token;
    saveJobToken();
    startPolling();
  } catch (error) {
    try { ui.status = await api("/api/status"); } catch { /* 保留舊狀態 */ }
    fail(error.message);
  }
}

document.addEventListener("change", (event) => {
  if (event.target.id === "file") onPick(event.target);
  if (event.target.id === "reselect" && event.target.files[0]) {
    ui.file = event.target.files[0];
    if (ui.job) showResult(ui.job);
  }
});

document.addEventListener("submit", (event) => {
  if (event.target.id !== "upload-form") return;
  event.preventDefault();
  submitUpload(event.target);
});

document.addEventListener("click", (event) => {
  const el = event.target.closest("button");
  if (!el) return;
  const d = el.dataset;
  const video = document.getElementById("video");
  if (d.view) {
    if (d.view === "example") { stopPoll(); showExample(); } else openMine();
  } else if ("retry" in d) {
    openMine();
  } else if ("newVideo" in d) {
    clearJobToken();
    ui.file = null;
    openMine();
  } else if (d.t !== undefined) {
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
    const example = await response.json();
    example.notes.forEach((n) => n.thumbs.forEach((t) => { t.url = `${ui.base}/${t.src}`; }));
    ui.example = example;
    showExample();
  } catch {
    app.innerHTML = `<section class="panel"><h2>資料載入失敗</h2><p class="note">請重新整理一次。</p></section>`;
  }
}
boot();
