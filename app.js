// The page around dream.js: the gallery, opening local files, and passing the
// canvas size through. A world's files go into the in-memory file system as
// /world/<name>.dmb and /world/<name>.rsc; the loader finds the .rsc by name.
'use strict';

const $ = (id) => document.getElementById(id);
const canvas = $('canvas');
const overlay = $('overlay');
let ready = false;
let busy = false;
let games = [];

function log(line) {
  const el = $('log');
  el.textContent += line + '\n';
  el.scrollTop = el.scrollHeight;
}

function show(message) {
  overlay.textContent = message;
  overlay.hidden = !message;
}

var Module = {
  canvas,
  print: log,
  printErr: log,
  onSelect: showSelection,
  onRuntimeInitialized() {
    ready = true;
    Module.FS.mkdir('/world');
    startFromHash();
  },
};

// SDL writes the world's name and the view's state to document.title, as
// "<world> - BYOND map viewer[ studio] - z 1 of 2, centre (8,8), ...". Show
// them under the map instead, and keep the tab's title plain.
new MutationObserver(() => {
  const m = document.title.match(/^(.*) - BYOND map viewer(?: studio)? - (.*)$/);
  if (!m) return;
  $('status').textContent = [m[1], ...m[2].split(', ')].join('   ');
  document.title = 'BYOND map viewer';
}).observe(document.querySelector('title'), { childList: true });

function showSelection(sel) {
  const panel = $('inspector');
  if (!sel) { panel.hidden = true; return; }
  const vars = Object.fromEntries(sel.vars);
  const unquote = (v) => (v && v.startsWith('"') ? v.slice(1, -1) : v);
  $('insp-kind').textContent = vars.kind || '';
  $('insp-name').textContent = unquote(vars.name) || vars.type || '';
  const table = $('insp-vars');
  table.textContent = '';
  for (const [name, value] of sel.vars) {
    if (name === 'kind' || name === 'name') continue;
    const tr = table.insertRow();
    if (value === 'null' || value === '""') tr.className = 'default';
    tr.insertCell().textContent = name;
    tr.insertCell().textContent = value;
  }
  panel.hidden = false;
}

$('insp-close').addEventListener('click', () => {
  if (ready) Module._web_select(-1);
  canvas.focus();
});

function stageSize() {
  const r = $('stage').getBoundingClientRect();
  return [Math.max(1, Math.floor(r.width)), Math.max(1, Math.floor(r.height))];
}

new ResizeObserver(() => {
  if (ready) Module._web_resize(...stageSize());
}).observe($('stage'));

// Lets the page paint the message before a long synchronous load.
const nextPaint = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

function clearWorld() {
  for (const name of Module.FS.readdir('/world')) {
    if (name !== '.' && name !== '..') Module.FS.unlink('/world/' + name);
  }
}

async function loadWorld(name, dmb, rsc, opts = {}) {
  clearWorld();
  Module.FS.writeFile(`/world/${name}.dmb`, dmb);
  if (rsc) Module.FS.writeFile(`/world/${name}.rsc`, rsc);
  show(`Building the map for ${name}...`);
  await nextPaint();
  const at = opts.at || [0, 0];
  const ok = Module.ccall('web_load', 'number',
    ['string', 'number', 'number', 'number', 'number', 'number'],
    [`/world/${name}.dmb`, opts.z || 1, at[0], at[1], ...stageSize()]);
  if (!ok) {
    show(`Could not show ${name}. The log has the reason.`);
    $('logbox').open = true;
    return;
  }
  show('');
  canvas.focus();
}

async function fetchBytes(url, label) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const total = Number(res.headers.get('Content-Length')) || 0;
  const reader = res.body.getReader();
  const parts = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    got += value.length;
    const mb = (got / 1048576).toFixed(1);
    show(total ? `Downloading ${label}: ${mb} of ${(total / 1048576).toFixed(1)} MB` : `Downloading ${label}: ${mb} MB`);
  }
  const out = new Uint8Array(got);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

async function openGame(game) {
  if (busy || !ready) return;
  busy = true;
  document.querySelectorAll('#gallery button').forEach((b) => b.classList.toggle('active', b.dataset.id === game.id));
  try {
    const dmb = await fetchBytes(game.dmb, game.name);
    const rsc = game.rsc ? await fetchBytes(game.rsc, game.name) : null;
    const base = game.dmb.split('/').pop().replace(/\.dmb$/i, '');
    await loadWorld(base, dmb, rsc, game);
    if (location.hash !== '#' + game.id) history.replaceState(null, '', '#' + game.id);
  } catch (e) {
    log(String(e));
    show(`Could not download ${game.name}.`);
    $('logbox').open = true;
  } finally {
    busy = false;
  }
}

$('files').addEventListener('change', async (ev) => {
  const files = [...ev.target.files];
  ev.target.value = '';
  const dmb = files.find((f) => /\.dmb$/i.test(f.name));
  const rsc = files.find((f) => /\.rsc$/i.test(f.name));
  if (!dmb) { show('Pick a .dmb, and its .rsc with it for the icons.'); return; }
  if (busy || !ready) return;
  busy = true;
  try {
    if (!rsc) log(`no .rsc picked with ${dmb.name}; nothing will have an icon`);
    const base = dmb.name.replace(/\.dmb$/i, '');
    await loadWorld(base, new Uint8Array(await dmb.arrayBuffer()),
                    rsc ? new Uint8Array(await rsc.arrayBuffer()) : null);
    history.replaceState(null, '', location.pathname);
    document.querySelectorAll('#gallery button').forEach((b) => b.classList.remove('active'));
  } finally {
    busy = false;
  }
});

function startFromHash() {
  const id = location.hash.slice(1);
  const game = games.find((g) => g.id === id);
  if (game) openGame(game);
}

fetch('games.json')
  .then((r) => r.json())
  .then((list) => {
    games = list;
    const ul = $('gallery');
    ul.textContent = '';
    ul.hidden = !list.length;
    if (!busy && !overlay.hidden) show(list.length ? 'Pick a world, or open your own.' : 'Open a .dmb and its .rsc to see its map.');
    for (const g of list) {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.dataset.id = g.id;
      b.textContent = g.name;
      b.addEventListener('click', () => openGame(g));
      li.append(b);
      ul.append(li);
    }
    if (ready) startFromHash();
  })
  .catch((e) => {
    $('gallery').hidden = true;
    if (!busy && !overlay.hidden) show('Open a .dmb and its .rsc to see its map.');
    log(String(e));
  });

window.addEventListener('hashchange', startFromHash);
