// JPlay web UI. No build step: plain ES modules talking to /api/v1.

// ------------------------------------------------------------------ helpers
const $ = (id) => document.getElementById(id);

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "dataset") Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

// Element.append() would print "null"; drop empty children first.
const kids = (...a) => a.flat().filter((x) => x !== null && x !== undefined && x !== false);

function fmt(sec) {
  if (sec === null || sec === undefined || isNaN(sec)) return "";
  sec = Math.max(0, Math.floor(sec));
  const hh = Math.floor(sec / 3600), mm = Math.floor((sec % 3600) / 60), ss = sec % 60;
  return hh ? `${hh}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}` : `${mm}:${String(ss).padStart(2, "0")}`;
}

let toastTimer;
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 4000);
}

async function api(method, path, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(`/api/v1${path}`, opts);
  } catch {
    toast("The player can't be reached. Check that it is switched on.");
    throw new Error("offline");
  }
  if (!res.ok) {
    let detail = res.statusText;
    try { detail = (await res.json()).detail || detail; } catch {}
    toast(typeof detail === "string" ? detail : "That didn't work");
    throw new Error(detail);
  }
  const type = res.headers.get("content-type") || "";
  return type.includes("json") ? res.json() : res;
}

function img(src, cls, alt = "") {
  if (!src) return h("div", { class: `${cls || ""} ph`.trim(), "aria-hidden": "true" });
  const el = h("img", { src, class: cls, alt, loading: "lazy", decoding: "async" });
  el.addEventListener("error", () => el.replaceWith(h("div", { class: `${cls || ""} ph`.trim() })), { once: true });
  return el;
}

// ------------------------------------------------------------------ state
let S = null; // latest snapshot from the player
let pos = { value: 0, at: 0 };
let seeking = false;
let tab = localStorage.getItem("jplay.tab") || null;

const source = (id) => S?.sources.find((s) => s.id === id);
const isActive = (id) => S?.active === id;

// ------------------------------------------------------------------ deck (now playing)
function renderDeck() {
  const np = S.now_playing;
  const caps = S.capabilities || {};
  $("player-name").textContent = S.player;
  document.title = np.title && np.state === "playing" ? `${np.title} – ${S.player}` : S.player;

  const art = $("np-art");
  if (np.art_url) {
    if (art.getAttribute("src") !== np.art_url) art.src = np.art_url;
    art.hidden = false;
  } else art.hidden = true;

  const title = $("np-title");
  const newTitle = np.title || (S.active ? source(S.active)?.name : "Nothing playing");
  if (title.textContent !== newTitle) {
    title.textContent = newTitle;
    title.classList.remove("changed");
    void title.offsetWidth;
    title.classList.add("changed");
  }
  $("np-artist").textContent = np.artist || "";
  $("np-album").textContent = np.album && np.album !== np.title ? np.album : "";
  $("np-track").textContent = np.track_number ? String(np.track_number).padStart(2, "0") : "";
  $("np-status").replaceChildren(...statusLine(np).map((t) => h("span", {}, t)));

  $("btn-toggle").classList.toggle("playing", np.state === "playing" || np.state === "loading");
  $("btn-toggle").setAttribute("aria-label", np.state === "playing" ? "Pause" : "Play");
  $("btn-toggle").disabled = !(caps.play || caps.pause);
  $("btn-next").disabled = !caps.next;
  $("btn-previous").disabled = !caps.previous;
  $("btn-stop").disabled = !caps.stop;

  pos = { value: np.position || 0, at: performance.now() };
  $("dur").textContent = np.duration ? fmt(np.duration) : (np.state === "playing" && !np.duration ? "Live" : "");
  const seek = $("seek");
  seek.disabled = !(caps.seek && np.duration);
  if (np.duration) seek.max = np.duration;

  const vol = S.volume_available;
  $("volume-row").hidden = !vol;
  if (vol && document.activeElement !== $("volume") && S.volume !== null) {
    $("volume").value = S.volume;
    $("volume").style.setProperty("--fill", `${S.volume}%`);
    $("volume-out").textContent = S.volume;
  }
  tick();
}

function statusLine(np) {
  const src = S.active ? source(S.active)?.name : "";
  const x = np.extra || {};
  const parts = [];
  if (np.state === "loading") parts.push("Loading");
  else if (np.state === "paused") parts.push("Paused");
  else if (np.state === "stopped" && S.active) parts.push("Stopped");
  if (src) parts.push(src);
  if (x.samplerate) parts.push(`${(x.samplerate / 1000).toString().replace(/\.0$/, "")} kHz`);
  if (x.codec) parts.push(String(x.codec).toUpperCase() + (x.bitrate ? ` ${x.bitrate} kbps` : ""));
  if (x.device) parts.push(x.device);
  if (x.preemphasis) parts.push("Pre-emphasis");
  if (x.error) parts.push(x.error);
  return parts;
}

function currentPosition() {
  if (!S) return 0;
  const np = S.now_playing;
  let p = pos.value;
  if (np.state === "playing") p += (performance.now() - pos.at) / 1000;
  if (np.duration) p = Math.min(p, np.duration);
  return p;
}

function tick() {
  if (!S) return;
  const np = S.now_playing;
  const p = currentPosition();
  const live = np.state !== "stopped" && np.position !== null;
  $("np-time").textContent = live ? fmt(p) : "--:--";
  $("pos").textContent = live ? fmt(p) : "";
  if (!seeking) {
    const seek = $("seek");
    seek.value = np.duration ? p : 0;
    seek.style.setProperty("--fill", np.duration ? `${(p / np.duration) * 100}%` : "0%");
  }
}
setInterval(tick, 250);

// transport
const cmd = (c) => api("POST", `/player/${c}`).catch(() => {});
$("btn-toggle").onclick = () => cmd("toggle");
$("btn-next").onclick = () => cmd("next");
$("btn-previous").onclick = () => cmd("previous");
$("btn-stop").onclick = () => cmd("stop");
$("seek").addEventListener("input", (e) => {
  seeking = true;
  const v = Number(e.target.value);
  $("pos").textContent = fmt(v);
  e.target.style.setProperty("--fill", `${(v / Number(e.target.max)) * 100}%`);
});
$("seek").addEventListener("change", async (e) => {
  const v = Number(e.target.value);
  pos = { value: v, at: performance.now() };
  try { await api("POST", "/player/seek", { position: v }); } catch {}
  seeking = false;
});
let volTimer;
$("volume").addEventListener("input", (e) => {
  const v = Number(e.target.value);
  $("volume-out").textContent = v;
  e.target.style.setProperty("--fill", `${v}%`);
  clearTimeout(volTimer);
  volTimer = setTimeout(() => api("PUT", "/volume", { volume: v }).catch(() => {}), 120);
});

// ------------------------------------------------------------------ source selector
function renderSelector() {
  const nav = $("selector");
  const ids = S.sources.map((s) => s.id).join();
  if (nav.dataset.ids !== ids) {
    nav.dataset.ids = ids;
    nav.replaceChildren(
      ...S.sources.map((s) =>
        h("button", { class: "sel", role: "tab", id: `tab-${s.id}`, dataset: { id: s.id }, onclick: () => openTab(s.id) }, s.name)
      )
    );
  }
  for (const btn of nav.children) {
    const s = source(btn.dataset.id);
    btn.classList.toggle("live", isActive(s.id));
    btn.classList.toggle("off", !s.available);
    btn.setAttribute("aria-selected", String(btn.dataset.id === tab));
    btn.title = s.available ? (isActive(s.id) ? `${s.name} is playing through the DAC` : s.name) : s.reason;
  }
}

function openTab(id) {
  tab = id;
  localStorage.setItem("jplay.tab", id);
  renderSelector();
  const panel = $("panel");
  panel.replaceChildren();
  panel.setAttribute("aria-labelledby", `tab-${id}`);
  const p = panels[id];
  p.sig = null;
  p.mount(panel);
  p.update();
}

function unavailable(s) {
  return h("div", { class: "notice" }, h("strong", {}, `${s.name} isn't available`), s.reason);
}

// ------------------------------------------------------------------ radio
const radio = {
  favs: [],
  results: null,
  mount(el) {
    this.el = el;
    this.favList = h("ul", { class: "list" });
    this.resList = h("ul", { class: "list" });
    const q = h("input", { type: "search", placeholder: "Find a station by name", "aria-label": "Station name", enterkeyhint: "search" });
    const form = h("form", { class: "search", onsubmit: (e) => { e.preventDefault(); this.search(q.value.trim()); } }, q, h("button", { class: "btn", type: "submit" }, "Search"));
    const region = (navigator.language.split(/[-@]/)[1] || "").toUpperCase();
    let regionName = region;
    try { regionName = new Intl.DisplayNames(["en"], { type: "region" }).of(region) || region; } catch {}
    this.body = h("div", {},
      h("h2", {}, "Favourites"),
      this.favList,
      h("h2", {}, "Find stations"),
      form,
      region ? h("div", { class: "row" }, h("button", { class: "btn quiet", onclick: () => this.search("", region) }, `Popular stations in ${regionName}`)) : null,
      this.resList,
    );
    el.append(this.body);
    this.loadFavs();
  },
  async loadFavs() {
    try { this.favs = await api("GET", "/radio/favourites"); } catch { this.favs = []; }
    this.sig = null;
    this.update();
  },
  async search(name, country = "") {
    this.resList.replaceChildren(h("li", { class: "empty" }, "Searching…"));
    try {
      this.results = await api("GET", `/radio/search?name=${encodeURIComponent(name)}&country=${country}`);
    } catch { this.results = []; }
    this.drawResults();
  },
  stationRow(st, inFavs) {
    const playing = isActive("radio") && S.now_playing.extra?.station_uuid === st.uuid;
    const meta = [st.country, st.codec && `${st.codec}${st.bitrate ? " " + st.bitrate + " kbps" : ""}`, st.tags?.slice(0, 2).join(", ")].filter(Boolean).join("  ");
    const action = inFavs
      ? h("button", { class: "btn quiet", "aria-label": `Remove ${st.name}`, onclick: async (e) => { e.stopPropagation(); this.favs = await api("DELETE", `/radio/favourites/${encodeURIComponent(st.uuid)}`); this.sig = null; this.update(); } }, "Remove")
      : h("button", { class: "btn quiet", disabled: this.favs.some((f) => f.uuid === st.uuid), onclick: async (e) => { e.stopPropagation(); this.favs = await api("POST", "/radio/favourites", st); toast(`${st.name} added to favourites`); this.sig = null; this.update(); this.drawResults(); } }, this.favs.some((f) => f.uuid === st.uuid) ? "Saved" : "Save");
    return h("li", { class: `item tap${playing ? " now" : ""}`, onclick: () => api("POST", "/radio/play", { station: st }).catch(() => {}) },
      img(st.favicon, "thumb"),
      h("div", { class: "body" }, h("div", { class: "name" }, st.name), h("div", { class: "meta" }, meta)),
      h("div", { class: "side" }, action),
    );
  },
  drawResults() {
    if (this.results === null) return;
    this.resList.replaceChildren(
      ...(this.results.length ? this.results.map((st) => this.stationRow(st, false)) : [h("li", { class: "empty" }, "No stations found. Try another name.")])
    );
  },
  update() {
    const s = source("radio");
    if (!s.available) { this.el.replaceChildren(unavailable(s)); return; }
    const sig = JSON.stringify([this.favs.map((f) => f.uuid), S.active, S.now_playing.extra?.station_uuid]);
    if (sig === this.sig) return;
    this.sig = sig;
    this.favList.replaceChildren(
      ...(this.favs.length ? this.favs.map((st) => this.stationRow(st, true)) : [h("li", { class: "empty" }, "No favourites yet. Search for a station and save it.")])
    );
    this.drawResults();
  },
};

// ------------------------------------------------------------------ plex
const plex = {
  stack: [],
  section: localStorage.getItem("jplay.plex.section"),
  seg: localStorage.getItem("jplay.plex.seg") || "recent",
  mount(el) {
    this.el = el;
    if (!this.stack.length) this.stack = [{ view: "home" }];
    this.render();
  },
  update() {
    const s = source("plex");
    if (!s.available) {
      if (this.sig !== "off") { this.sig = "off"; this.el.replaceChildren(unavailable(s)); }
      return;
    }
    if (this.sig === "off") { this.sig = null; this.render(); }
    // highlight the playing track without redrawing
    const key = isActive("plex") ? S.now_playing.extra?.key : null;
    for (const row of this.el.querySelectorAll("[data-key]")) row.classList.toggle("now", row.dataset.key === key);
    const qsig = JSON.stringify([S.active, S.now_playing.queue_length, key]);
    if (this.top().view === "home" && this.seg === "queue" && qsig !== this.qsig) { this.qsig = qsig; this.render(); }
  },
  top() { return this.stack[this.stack.length - 1]; },
  push(entry) { this.stack.push(entry); this.render(); window.scrollTo({ top: 0 }); },
  pop() { this.stack.pop(); this.render(); },
  async render() {
    const s = source("plex");
    if (!s.available) { this.el.replaceChildren(unavailable(s)); this.sig = "off"; return; }
    const v = this.top();
    const token = Symbol();
    this.token = token;
    const body = h("div");
    this.el.replaceChildren(body);
    try {
      if (v.view === "home") await this.home(body, token);
      else await this.detail(body, v, token);
    } catch (err) {
      if (this.token === token) body.replaceChildren(h("div", { class: "notice" }, h("strong", {}, "Plex didn't answer"), String(err.message || err)));
    }
    this.update();
  },
  async home(body, token) {
    const libs = await api("GET", "/plex/libraries");
    if (this.token !== token) return;
    if (!libs.length) { body.append(h("p", { class: "empty" }, "This Plex server has no music library.")); return; }
    if (!libs.some((l) => l.key === this.section)) this.section = libs[0].key;
    const segs = [["recent", "Recently added"], ["albums", "Albums"], ["artists", "Artists"], ["playlists", "Playlists"], ["queue", "Up next"]];
    const seg = h("div", { class: "seg", role: "group", "aria-label": "Browse" },
      ...segs.map(([id, label]) => h("button", { "aria-pressed": String(this.seg === id), onclick: () => { this.seg = id; localStorage.setItem("jplay.plex.seg", id); this.render(); } }, label)));
    const q = h("input", { type: "search", placeholder: "Search artists, albums and tracks", "aria-label": "Search Plex", enterkeyhint: "search", value: this.query || "" });
    const form = h("form", { class: "search", onsubmit: (e) => { e.preventDefault(); if (q.value.trim()) this.push({ view: "search", q: q.value.trim() }); } }, q, h("button", { class: "btn", type: "submit" }, "Search"));
    const libPick = libs.length > 1
      ? h("div", { class: "seg", role: "group", "aria-label": "Library" }, ...libs.map((l) => h("button", { "aria-pressed": String(l.key === this.section), onclick: () => { this.section = l.key; localStorage.setItem("jplay.plex.section", l.key); this.render(); } }, l.title)))
      : null;
    const content = h("div", { style: "margin-top:16px" }, h("p", { class: "empty" }, "Loading…"));
    body.append(...kids(form, libPick ? h("div", { style: "margin-bottom:10px" }, libPick) : null, seg, content));

    if (this.seg === "recent") {
      const items = await api("GET", `/plex/recent?section=${this.section}`);
      if (this.token === token) content.replaceChildren(this.grid(items));
    } else if (this.seg === "albums" || this.seg === "artists") {
      const kind = this.seg === "albums" ? "album" : "artist";
      const grid = h("div", { class: "grid" });
      const more = h("div", { class: "more" });
      content.replaceChildren(grid, more);
      let start = 0;
      const load = async () => {
        more.replaceChildren(h("span", { class: "empty" }, "Loading…"));
        const page = await api("GET", `/plex/sections/${this.section}/${kind}?start=${start}&size=60`);
        if (this.token !== token) return;
        grid.append(...page.items.map((i) => this.tile(i)));
        start += page.items.length;
        more.replaceChildren(start < page.total ? h("button", { class: "btn", onclick: load }, `Show more (${page.total - start} left)`) : "");
      };
      await load();
    } else if (this.seg === "playlists") {
      const items = await api("GET", "/plex/playlists");
      if (this.token === token) content.replaceChildren(items.length ? h("ul", { class: "list" }, ...items.map((p) => this.row(p, () => this.push({ view: "item", key: p.key })))) : h("p", { class: "empty" }, "No music playlists on this server."));
    } else if (this.seg === "queue") {
      const q = await api("GET", "/plex/queue");
      if (this.token !== token) return;
      content.replaceChildren(q.items.length
        ? h("ul", { class: "list" }, ...q.items.map((t, i) => h("li", { class: "item tap", dataset: { key: t.key }, onclick: () => api("POST", `/plex/queue/${i}`).catch(() => {}) },
            h("span", { class: "num" }, i + 1), h("div", { class: "body" }, h("div", { class: "name" }, t.title), h("div", { class: "meta" }, `${t.artist}  ${t.album}`)), h("span", { class: "side" }, fmt(t.duration)))))
        : h("p", { class: "empty" }, "The queue is empty. Play an album or playlist to fill it."));
    }
  },
  async detail(body, v, token) {
    body.append(h("button", { class: "btn quiet back", onclick: () => this.pop() }, "Back"));
    if (v.view === "search") {
      body.append(h("p", { class: "empty" }, "Searching…"));
      const r = await api("GET", `/plex/search?q=${encodeURIComponent(v.q)}`);
      if (this.token !== token) return;
      body.lastChild.remove();
      body.append(h("h2", {}, `Results for “${v.q}”`));
      if (!r.artist.length && !r.album.length && !r.track.length) body.append(h("p", { class: "empty" }, "Nothing found. Check the spelling or try fewer words."));
      if (r.artist.length) body.append(h("h2", {}, "Artists"), this.grid(r.artist));
      if (r.album.length) body.append(h("h2", {}, "Albums"), this.grid(r.album));
      if (r.track.length) body.append(h("h2", {}, "Tracks"), h("ul", { class: "list" }, ...r.track.map((t) => this.row(t, () => api("POST", "/plex/play", { key: t.key }).catch(() => {}), true))));
      return;
    }
    const data = await api("GET", `/plex/items/${v.key}/children`);
    if (this.token !== token) return;
    const it = data.item;
    const play = (opts = {}) => api("POST", "/plex/play", { key: it.key, ...opts }).catch(() => {});
    const total = data.items.reduce((a, t) => a + (t.duration || 0), 0);
    const meta = it.type === "album" ? [it.subtitle, it.year].filter(Boolean).join(", ")
      : it.type === "artist" ? `${data.items.length} albums`
      : `${data.items.length} tracks${total ? `, ${Math.round(total / 60)} min` : ""}`;
    body.append(h("div", { class: "album-head" },
      img(it.thumb && it.thumb.replace("size=300", "size=600"), ""),
      h("div", {}, h("h2", {}, it.title), h("div", { class: "meta" }, meta),
        h("div", { class: "row" }, h("button", { class: "btn primary", onclick: () => play() }, "Play"), h("button", { class: "btn", onclick: () => play({ shuffle: true }) }, "Shuffle")))));
    if (it.type === "artist") body.append(this.grid(data.items));
    else body.append(h("ul", { class: "list" }, ...data.items.map((t, i) =>
      h("li", { class: "item tap", dataset: { key: t.key }, onclick: () => play({ index: i }) },
        h("span", { class: "num" }, it.type === "album" ? t.index ?? i + 1 : i + 1),
        h("div", { class: "body" }, h("div", { class: "name" }, t.title), it.type === "playlist" ? h("div", { class: "meta" }, t.subtitle) : null),
        h("span", { class: "side" }, fmt(t.duration))))));
  },
  tile(i) {
    return h("button", { class: `tile${i.type === "artist" ? " round" : ""}`, onclick: () => this.push({ view: "item", key: i.key }) },
      img(i.thumb, ""), h("div", { class: "name" }, i.title), i.subtitle || i.year ? h("div", { class: "meta" }, [i.subtitle, i.year].filter(Boolean).join(", ")) : null);
  },
  grid(items) {
    return items.length ? h("div", { class: "grid" }, ...items.map((i) => this.tile(i))) : h("p", { class: "empty" }, "Nothing here yet.");
  },
  row(i, onclick, showDuration = false) {
    return h("li", { class: "item tap", dataset: { key: i.key }, onclick },
      img(i.thumb, "thumb"), h("div", { class: "body" }, h("div", { class: "name" }, i.title), h("div", { class: "meta" }, i.subtitle || "")),
      h("span", { class: "side" }, showDuration || i.type === "playlist" ? fmt(i.duration) : ""));
  },
};

// ------------------------------------------------------------------ cd
const cd = {
  mount(el) { this.el = el; },
  update() {
    const s = source("cd");
    const d = s.details || {};
    const disc = d.disc;
    const cur = isActive("cd") ? S.now_playing.track_number : null;
    const sig = JSON.stringify([s.available, s.reason, d.status, disc, d.reading, cur, S.active]);
    if (sig === this.sig) return;
    this.sig = sig;
    if (!s.available) { this.el.replaceChildren(unavailable(s)); return; }
    if (!disc) {
      const msg = {
        "reading-toc": ["Reading the disc", "This takes a few seconds."],
        data: ["This isn't an audio CD", "Data discs and DVDs can't be played. Eject it and insert an audio CD."],
        error: ["The disc couldn't be read", "Clean the disc and try again."],
      }[d.status] || ["No disc", s.reason || "Insert an audio CD. It starts playing on its own."];
      this.el.replaceChildren(...kids(h("div", { class: "notice" }, h("strong", {}, msg[0]), msg[1]),
        d.status === "data" ? h("div", { class: "row", style: "margin-top:12px" }, h("button", { class: "btn", onclick: () => api("POST", "/cd/eject").catch(() => {}) }, "Eject")) : null));
      return;
    }
    const inMem = disc.tracks.filter((t) => t.in_memory).length;
    const reading = d.reading?.done ? "The whole disc is in memory; the drive is resting."
      : d.reading?.track ? `Reading track ${d.reading.track} into memory (${inMem} of ${disc.tracks.length} done).` : "";
    const total = disc.tracks.reduce((a, t) => a + (t.duration || 0), 0);
    this.el.replaceChildren(...kids(
      h("div", { class: "album-head" }, img(disc.art_url, ""),
        h("div", {}, h("h2", {}, disc.album), h("div", { class: "meta" }, [disc.artist, disc.year, `${disc.tracks.length} tracks, ${Math.round(total / 60)} min`].filter(Boolean).join(", ")),
          h("div", { class: "row" },
            h("button", { class: "btn primary", onclick: () => api("POST", "/cd/play", { track: cur || disc.tracks[0].number }).catch(() => {}) }, "Play"),
            h("button", { class: "btn", onclick: () => api("POST", "/cd/eject").catch(() => {}) }, "Eject")))),
      reading ? h("p", { class: "hint" }, reading) : null,
      h("ul", { class: "list" }, ...disc.tracks.map((t) =>
        h("li", { class: `item tap${t.number === cur ? " now" : ""}`, onclick: () => api("POST", "/cd/play", { track: t.number }).catch(() => {}) },
          h("span", { class: "num" }, t.number),
          h("div", { class: "body" }, h("div", { class: "name" }, t.title), t.artist && t.artist !== disc.artist ? h("div", { class: "meta" }, t.artist) : null),
          h("span", { class: "side" }, h("span", { class: `mem${t.in_memory ? " in" : ""}`, title: t.in_memory ? "In memory" : "Not read yet" }), fmt(t.duration))))),
    ));
  },
};

// ------------------------------------------------------------------ spotify
const spotify = {
  mount(el) { this.el = el; },
  update() {
    const s = source("spotify");
    const d = s.details || {};
    const sig = JSON.stringify([s.available, s.reason, d, S.active]);
    if (sig === this.sig) return;
    this.sig = sig;
    if (!s.available) { this.el.replaceChildren(unavailable(s)); return; }
    this.el.replaceChildren(
      h("div", { class: "notice" },
        h("strong", {}, d.connected ? `Connected${d.client ? ` to ${d.client}` : ""}` : `Ready as “${d.device_name}”`),
        d.connected ? "Control playback from the Spotify app. Picking another source here ends the Spotify session." : d.hint),
    );
  },
};

// ------------------------------------------------------------------ bluetooth
const bluetooth = {
  mount(el) { this.el = el; },
  update() {
    const s = source("bluetooth");
    const d = s.details || {};
    const sig = JSON.stringify([s.available, s.reason, d, S.active]);
    if (sig === this.sig) return;
    this.sig = sig;
    if (!s.available) { this.el.replaceChildren(unavailable(s)); return; }
    const devs = d.devices || [];
    this.el.replaceChildren(
      h("p", { class: "hint" }, "Phones and tablets play here as ", h("strong", {}, `“${d.alias}”`), ". When one starts playing, this player switches to it."),
      h("div", { class: "row", style: "margin:14px 0 4px" },
        h("button", { class: d.discoverable ? "btn" : "btn primary", onclick: () => api("POST", "/bluetooth/discoverable", { on: !d.discoverable }).catch(() => {}) },
          d.discoverable ? "Stop pairing" : "Pair a new device"),
        d.discoverable ? h("span", { class: "hint" }, `Now visible as “${d.alias}”. Pick it in your phone's Bluetooth settings.`) : null),
      h("h2", {}, "Devices"),
      devs.length
        ? h("ul", { class: "list" }, ...devs.map((dev) => h("li", { class: "item" },
            h("span", { class: `mem${dev.connected ? " in" : ""}` }),
            h("div", { class: "body" }, h("div", { class: "name" }, dev.name), h("div", { class: "meta" }, dev.connected ? "Connected" : "Paired")),
            h("div", { class: "side" },
              h("button", { class: "btn quiet", onclick: () => api("POST", `/bluetooth/devices/${dev.address}/${dev.connected ? "disconnect" : "connect"}`).catch(() => {}) }, dev.connected ? "Disconnect" : "Connect"),
              h("button", { class: "btn quiet", onclick: () => confirm(`Forget ${dev.name}? It will have to pair again.`) && api("DELETE", `/bluetooth/devices/${dev.address}`).catch(() => {}) }, "Forget")))))
        : h("p", { class: "empty" }, "No paired devices yet."),
    );
  },
};

const panels = { radio, plex, cd, spotify, bluetooth };

// ------------------------------------------------------------------ live connection
function applyState(snapshot) {
  const first = !S;
  S = snapshot;
  if (first || !tab || !source(tab)) {
    tab = tab && source(tab) ? tab : S.active || S.sources.find((s) => s.available)?.id || S.sources[0].id;
  }
  renderDeck();
  renderSelector();
  if (first || !$("panel").firstChild) openTab(tab);
  else panels[tab].update();
}

let ws, retry = 0;
function connect() {
  const link = $("link-state");
  ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/v1/events`);
  ws.onopen = () => { retry = 0; link.textContent = "Live"; link.className = "link-state ok"; };
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === "state") applyState(msg.data);
  };
  ws.onclose = () => {
    link.textContent = "Reconnecting";
    link.className = "link-state down";
    setTimeout(connect, Math.min(10000, 1000 * 2 ** retry++));
  };
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && ws && ws.readyState > 1) connect();
});
connect();
