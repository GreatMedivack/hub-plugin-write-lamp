// «Лампа записи»: мигает в верхней полосе, когда агент пишет наружу (MR/PR, push, инфраструктура, база, MCP с записью).
// Только сигнал — агентов не останавливает. Источник — ленты сессий (/api/timeline, как у страницы): живой снимок ленты
// не везёт, только их правки (timeline_rev); плагин дотягивает изменившиеся сам. Шаг виден в момент, когда объявлен, а не
// после результата; лампа гаснет через 30 с после конца шага, в истории — сутки.
import { classify } from "./classify.js";

const AFTER = 30, DAY = 86400;
const ended = new Map();          // id шага → когда мы увидели его конец (время на этой странице)
let open = false, hist = false;   // «За сутки» — свёрнуто по умолчанию (владелец 07.10)
// сессия → {epoch, rev, items, busy}; items — только шаги-записи (classify), не вся лента: лампа держала до 300 шагов
// каждой сессии и разбирала их все заново на каждом снимке (23.10: половина памяти страницы и ~1 с из 30 на 57 сессиях)
const tl = {};
const hits = new WeakMap();       // шаг → classify(шаг); правленый шаг приходит новым объектом — разбирается заново
const hitOf = (st) => { let h = hits.get(st); if (h === undefined) hits.set(st, h = classify(st)); return h; };
let redraw = () => {};
// запросов ленты сразу — не больше PULLS: у браузера шесть соединений к хабу, а первый снимок звал все сессии разом —
// лента открытой сессии (тот же /api/timeline) ждала в очереди за ними
const PULLS = 2, queue = [];
let pulling = 0, snapNow = null;

function pull(name, snap) {
  const want = (snap.timeline_rev || {})[name] || 0, t = tl[name] || (tl[name] = { epoch: null, rev: 0, items: [] });
  if (t.busy || (t.epoch === snap.epoch && t.rev >= want)) return;
  t.busy = true;
  queue.push(name);
  next();
}
function next() {
  while (pulling < PULLS && queue.length) {
    pulling++;
    load(queue.shift()).finally(() => { pulling--; next(); });
  }
}
async function load(name) {
  const t = tl[name];
  try {
    const since = t.epoch === snapNow?.epoch ? t.rev : 0;
    const q = new URLSearchParams({ session: name, since: String(since), epoch: t.epoch || "" });
    const r = await (await fetch(`/api/timeline?${q}`)).json();
    const mine = r.items.filter((x) => x.kind === "tool" && hitOf(x));
    if (r.full) t.items = mine.slice(-300);
    else {
      const at = new Map(t.items.map((x, i) => [x.k, i]));
      for (const x of mine) at.has(x.k) ? (t.items[at.get(x.k)] = x) : t.items.push(x);
      t.items = t.items.slice(-300);
    }
    t.epoch = r.epoch; t.rev = r.rev;
    redraw();
  } catch { /* сеть — со следующим снимком */ } finally { t.busy = false; }
}

const plural = (n, a, b, c) => (n % 10 === 1 && n % 100 !== 11 ? a : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? b : c);
const ago = (s) => (s < 60 ? `${Math.max(1, Math.round(s))} с` : s < 3600 ? `${Math.round(s / 60)} мин` : `${Math.round(s / 3600)} ч`);

function scan(snap) {
  const now = Date.now() / 1000, live = [], day = [];
  const sessions = new Map((snap.sessions || []).map((s) => [s.name, s]));
  snapNow = snap;
  for (const name of Object.keys(snap.timeline_rev || {})) {
    // свободна или спит дольше суток — шагов за сутки у неё нет (шаги идут только в ходе), ленту не тянуть
    const s = sessions.get(name);
    if (!tl[name] && s && ["idle", "asleep", "failed", "closed"].includes(s.state) && now - (s.since || now) > DAY) continue;
    pull(name, snap);
  }
  for (const [name, { items }] of Object.entries(tl)) {
    if (!sessions.has(name)) continue;
    for (const st of items || []) {
      if (st.kind !== "tool" || now - (st.ts || 0) > DAY) continue;
      const hit = hitOf(st);
      if (!hit) continue;
      const running = st.status === "running" || st.status == null && st.result == null;
      if (!running && !ended.has(st.id)) ended.set(st.id, Math.min(now, (st.ts || now) + AFTER));   // конец до загрузки — по старту
      const sess = sessions.get(name) || {};
      const asks = (sess.pending || []).some((p) => JSON.stringify(p).includes(st.id)) || sess.state === "dialog";
      const rec = { ...hit, id: st.id, session: name, ts: st.ts || now, running, asks: running && asks, end: ended.get(st.id) };
      day.push(rec);
      if (running || now - rec.end < AFTER) live.push(rec);
    }
  }
  const byTs = (a, b) => b.ts - a.ts;
  return { live: live.sort(byTs), day: day.sort(byTs) };
}

function line(hub, r, now) {
  const it = hub.el("button", "wlamp-it");
  it.type = "button";
  it.append(hub.el("span", `wlamp-k${r.danger ? " danger" : ""}`, r.kind));
  it.append(hub.el("b", null, `${r.session}${r.where ? " → " + r.where : ""}`));
  const state = r.asks ? "ждёт подтверждения" : r.running ? ago(now - r.ts) : `готово · ${ago(now - (r.end || r.ts))} назад`;
  it.append(hub.el("span", "wlamp-w", `${r.what.slice(0, 140)} · ${state}`));
  it.title = r.what;
  it.addEventListener("click", () => { open = false; location.hash = `#/s/${encodeURIComponent(r.session)}`; });
  return it;
}

export default function register(hub) {
  hub.addStyle("web/style.css");
  let last = null, tick = null, hintW = 0, lampW = 0, lampH = 0;
  // место (владелец 14.10): где есть поле ввода — в нём, слева от скрепки, всегда, а не только когда шапка тесная; где
  // поля нет («Поток», виды плагинов) — в строке заголовка вида, в её самом широком пустом промежутке у правого края; не влезла —
  // над нижним краем колонки. Считается от колонки с лентой (main): слева список сессий переменной ширины
  const place = (root) => {
    const main = document.querySelector("main"), m = main?.getBoundingClientRect();
    if (!m) return;
    // в поле ввода лампа стоит поверх конца строки — текст поля до неё не доходит (отступ справа на её ширину)
    const pad = (px) => main.style.setProperty("--wlamp-pad", `${px}px`);
    if (!root.firstElementChild) return pad(0);
    // ширина — последняя ненулевая: в момент перерисовки слота лампа бывает ещё не выложена (0 → было 140 по умолчанию),
    // и отступ поля скакал на 28px раз в секунду — текст в поле перепрыгивал на другие строки (владелец 16.10)
    const lamp = root.firstElementChild, lw = lamp?.getBoundingClientRect().width;
    if (lw) lampW = lw;
    const w = lampW || 140, lh = lamp?.offsetHeight || lampH || 20;
    if (lamp?.offsetHeight) lampH = lamp.offsetHeight;
    let clip = main.querySelector(".composer .attach, .attach")?.getBoundingClientRect();
    // левее подсказки «Ctrl I» у скрепки (её видно, пока поле без фокуса): место под неё держится и при фокусе,
    // чтобы лампа не прыгала (владелец 14.10: «наезжает на этот элемент»)
    const hk = main.querySelector(".composer .kbd-hint")?.getBoundingClientRect();
    if (hk?.width && clip?.width) hintW = clip.left - hk.left;
    if (clip?.width && main.querySelector(".composer .kbd-hint"))
      clip = { left: clip.left - hintW, bottom: clip.bottom, height: clip.height, width: clip.width };
    let bar = null, gap = null;
    if (!clip?.width) {
      bar = main.querySelector(":scope > .head") || main.querySelector(":scope > .ext-view > * > :first-child");
      const r = bar?.getBoundingClientRect();
      if (r?.width && r.height < 90) {   // самый широкий промежуток между элементами строки, куда лампа влезает
        const xs = [...bar.querySelectorAll("*")].filter((x) => !x.children.length).map((x) => x.getBoundingClientRect())
          .filter((x) => x.width).sort((a, b) => a.left - b.left);
        let edge = r.left;
        for (const x of [...xs, { left: r.right - 4, right: r.right }]) {
          if (x.left - edge >= w + 32 && (!gap || x.left - edge > gap[1] - gap[0])) gap = [edge, x.left];
          edge = Math.max(edge, x.right);
        }
      }
      if (!gap) bar = null;
    }
    root.dataset.pos = bar ? "top" : "bottom";
    pad(!bar && clip?.width ? Math.round(w + 12 + (main.querySelector(".composer .kbd-hint") ? hintW : 0)) : 0);
    if (bar) {
      const r = bar.getBoundingClientRect();
      root.style.setProperty("--wlamp-x", `${Math.round(gap[1] - 16)}px`);   // у правого края промежутка
      root.style.setProperty("--wlamp-y", `${Math.round(r.top + r.height / 2)}px`);
    } else if (clip?.width) {
      root.style.setProperty("--wlamp-r", `${Math.round(innerWidth - clip.left + 8)}px`);
      root.style.setProperty("--wlamp-b", `${Math.round(innerHeight - clip.bottom + (clip.height - lh) / 2)}px`);
    } else {
      const d = main.querySelector(":scope > .dock")?.getBoundingClientRect();
      root.style.setProperty("--wlamp-r", `${Math.round(innerWidth - m.right + 24)}px`);
      root.style.setProperty("--wlamp-b", `${Math.round(innerHeight - (d ? d.top : m.bottom) + 10)}px`);
    }
  };
  window.addEventListener("resize", () => last && place(last[0]));
  for (const ev of ["focusin", "focusout"]) document.addEventListener(ev, () => last && setTimeout(() => place(last[0])));
  const draw = (root, snap) => {
    const { live, day } = scan(snap), now = Date.now() / 1000;
    place(root);
    root.classList.toggle("on", live.length > 0);
    // гаснуть через 30 с и обновлять «N с» — без нового снимка: пока горит или открыт список, раз в секунду
    clearTimeout(tick);
    if (live.length || open) tick = setTimeout(() => last && draw(...last), 1000);
    // лампа видна всегда: пока никто не пишет — тусклая и не мигает, клик — история за сутки (владелец 19.10: «сделать
    // немигающей, а не убирать, когда ничего нет»)
    // лампа — та же кнопка, меняется только текст: новая кнопка раз в секунду начинала мигание заново и подменяла
    // элемент под мышью (владелец 19.10: «появляется какой-то курсор при мигании»)
    let lamp = root.querySelector(":scope > .wlamp");
    if (!lamp) {
      lamp = hub.el("button", "wlamp");
      lamp.type = "button";
      const n = hub.el("span", "wlamp-n");
      n.append(hub.el("span", "wlamp-t"));
      lamp.append(hub.el("i"), n);
      lamp.title = "Агенты пишут наружу — кто и что";
      lamp.addEventListener("click", (e) => { e.stopPropagation(); open = !open; if (last) draw(...last); });
    }
    lamp.className = `wlamp${!live.length ? " idle" : live.some((r) => r.danger) ? " danger" : ""}`;
    lamp.setAttribute("aria-expanded", String(open));
    const txt = live.length ? `${live.length} ${plural(live.length, "запись", "записи", "записей")}` : "записей нет", n = lamp.querySelector(".wlamp-t");
    if (n.textContent !== txt) n.textContent = txt;
    const nodes = [lamp];
    if (open) {
      const pop = hub.el("div", "wlamp-pop");
      pop.addEventListener("click", (e) => e.stopPropagation());
      pop.append(hub.el("b", "wlamp-h", "Сейчас пишут наружу"));
      if (!live.length) pop.append(hub.el("div", "wlamp-f", "сейчас — никто"));
      for (const r of live) pop.append(line(hub, r, now));
      const old = day.filter((r) => !live.includes(r)).slice(0, 15);
      if (old.length) {
        const t = hub.el("button", "wlamp-h wlamp-hist", `${hist ? "▾" : "▸"} За сутки · ${old.length}`);
        t.type = "button";
        t.setAttribute("aria-expanded", String(hist));
        t.addEventListener("click", (e) => { e.stopPropagation(); hist = !hist; draw(root, snap); });
        pop.append(t);
        if (hist) for (const r of old) pop.append(line(hub, r, now));
      }
      pop.append(hub.el("div", "wlamp-f", "клик по строке — открыть сессию · только сигнал, агенты не останавливаются"));
      nodes.push(pop);
    }
    if (root.firstElementChild !== lamp) root.replaceChildren(...nodes);
    else { while (lamp.nextSibling) lamp.nextSibling.remove(); root.append(...nodes.slice(1)); }
    place(root);   // по размеру уже нарисованной лампы
  };
  document.addEventListener("click", () => { if (open) { open = false; if (last) draw(...last); } });
  // пришла лента — перерисовать раз в кадр, а не на каждый ответ (первый снимок — десятки ответов подряд)
  let frame = 0;
  redraw = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; if (last) draw(...last); }); };
  hub.addSlot("topbar", {
    id: "write-lamp",
    order: 100,
    render(root, snap) {
      last = [root, snap];
      draw(root, snap);
    },
  });
}
