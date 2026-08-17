/* News Stack v3 (PWA) — dashboard.
 *
 * This is v3's PAGE script. The only substantive change is that
 * `fetch('/api/...')` became a call into engine.js, because there is no server
 * on the other side of it any more. Everything below the fold — the card
 * markup, the mark handling, the tab rules, the 30s poll — is the same code.
 *
 * The additions at the end (service worker, install hint, foreground refresh,
 * extraction loop) are the parts a phone needs and a localhost server does not.
 */
const $ = s => document.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g,
  m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
let tab = 'stories', timer = null;

function ago(sec){
  if(!sec) return '';
  const d = Math.max(0, Date.now()/1000 - sec);
  if(d < 60) return 'just now';
  if(d < 3600) return Math.floor(d/60) + 'm ago';
  if(d < 86400) return Math.floor(d/3600) + 'h ago';
  return Math.floor(d/86400) + 'd ago';
}
function clock(sec){
  return sec ? new Date(sec*1000).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}) : '—';
}
// "2h ago" answers how fresh a story is and not what day it came out, which is
// the thing you need when you come back to a saved item or widen the window.
function datestamp(sec){
  if(!sec) return '';
  const d = new Date(sec*1000), p = n => String(n).padStart(2, '0');
  return `${p(d.getMonth()+1)}/${p(d.getDate())}/${d.getFullYear()}`;
}

// v3 keeps reading state on the server so it is the same list on every device.
// Here it is in IndexedDB, so it is per-device — see README. "Hide read" was
// already local in v3 and stays local.
const hideRead = () => localStorage.getItem('hideread') === '1';

async function mark(body){
  try{ return await NEWSSTACK.mark(body); }catch(e){ return false; }
}

function card(s, opts){
  const o = opts || {};
  return `<article class="${s.read ? 'read' : ''}" data-url="${esc(s.url)}">
    <div class="row">
      <input class="tick" type="checkbox" ${s.read ? 'checked' : ''}
             aria-label="Mark as read" title="Mark as read">
      <div class="body">
        <div>
          <span class="tag">${esc(s.source)}</span>
          ${(s.topics || []).map(t =>
            `<span class="tag topic" data-topic="${esc(t)}">${esc(t)}</span>`).join('')}
          ${s.corroboration > 1 ? `<span class="tag corr">${s.corroboration} sources</span>` : ''}
          ${s.trend >= 12 ? '<span class="tag hot">trending</span>' : ''}
          <span class="tag">${esc(ago(s.published_ts))}</span>
          ${s.published_ts ? `<span class="tag">${esc(datestamp(s.published_ts))}</span>` : ''}
          ${o.savedAt ? `<span class="tag">saved ${esc(ago(s.saved_ts))}</span>` : ''}
          ${o.archived === false ? '<span class="tag warn">no longer in the archive</span>' : ''}
        </div>
        <h2><a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.title)}</a></h2>
        ${s.summary ? `<p class="sum">${esc(s.summary.slice(0,320))}${s.summary.length > 320 ? '…' : ''}</p>` : ''}
        ${(s.related || []).length ? `<details class="rel"><summary>Also reported by ${s.related.length} other ${s.related.length === 1 ? 'source' : 'sources'}</summary>
          ${s.related.map(r => `<a href="${esc(r.url)}" target="_blank" rel="noopener noreferrer">${esc(r.source)} — ${esc(r.title)}</a>`).join('')}
        </details>` : ''}
      </div>
      <button class="save ${s.saved ? 'on' : ''}" title="${s.saved ? 'Remove from Saved' : 'Save for later'}"
              aria-label="Save for later">${s.saved ? '★' : '☆'}</button>
    </div>
  </article>`;
}

function wireTopics(root){
  // Clicking a topic pivots to everything sharing it, which is how related
  // stories link to each other across the feed that happened to carry them.
  root.querySelectorAll('.topic').forEach(el => {
    el.onclick = () => { $('#cat').value = el.dataset.topic; setTab('stories'); };
  });
}

async function loadStories(){
  const d = await NEWSSTACK.stories({
    query: $('#q').value.trim() || null,
    category: $('#cat').value || null,
    hours: $('#win').value ? Number($('#win').value) : null,
    sort: $('#sort').value,
    limit: 200,
  });
  const st = await NEWSSTACK.stats();
  const shown = hideRead() ? d.items.filter(s => !s.read) : d.items;
  const readCount = d.items.length - d.items.filter(s => !s.read).length;
  $('#stories').innerHTML = shown.length ? shown.map(s => card(s)).join('')
    : `<article><p class="sum">${d.items.length
        ? 'Every story in this filter is already read.'
        : 'No stories match this filter yet.'}</p></article>`;
  wireTopics($('#stories'));
  $('#bar').innerHTML = `<span>${shown.length} clusters shown</span>
    ${readCount ? `<span>${readCount} read${hideRead() ? ' (hidden)' : ''}</span>` : ''}
    ${d.widened ? '<span class="warn">no matches in this window — showing all time</span>' : ''}
    <span>${st.stories} stories stored</span>
    <span>updated ${st.state.last_refresh ? esc(ago(st.state.last_refresh)) : 'first refresh running…'}</span>`;
}

async function loadSaved(){
  const d = await NEWSSTACK.saved(500);
  // Hide read deliberately does not apply here. Opening a story marks it read,
  // so filtering this list would empty the bookmarks of everything you have
  // actually looked at, which is the opposite of what saving one is for. A read
  // bookmark is dimmed and stays put; only ★ removes it.
  const read = d.items.filter(s => s.read).length;
  $('#saved').innerHTML = d.items.length
    ? d.items.map(s => card(Object.assign({saved:true, corroboration:1, trend:0}, s),
                            {savedAt:true, archived:s.in_archive})).join('')
    : '<article><p class="sum">Nothing saved yet. Tap ☆ on a story to keep it here'
      + ' — saved stories stay even after they age out of the archive.</p></article>';
  wireTopics($('#saved'));
  $('#bar').innerHTML = `<span>${d.items.length} saved</span>
    ${read ? `<span>${read} already read</span>` : ''}`;
}

async function loadSources(){
  const d = await NEWSSTACK.feeds();
  const s = d.stats;
  const counts = {online:0, idle:0, delayed:0, throttled:0, blocked:0,
                  error:0, pending:0, unknown:0};
  d.feeds.forEach(f => counts[f.status] = (counts[f.status] || 0) + 1);
  $('#sources').innerHTML = `
    <div class="grid">
      <div class="kpi"><b>${counts.online}</b><span>Online</span></div>
      <div class="kpi"><b>${counts.idle}</b><span>Idle</span></div>
      <div class="kpi"><b>${counts.throttled}</b><span>Throttled</span></div>
      <div class="kpi"><b>${counts.delayed}</b><span>Delayed</span></div>
      <div class="kpi"><b>${counts.blocked}</b><span>Blocked</span></div>
      <div class="kpi"><b>${counts.error}</b><span>Failing</span></div>
      <div class="kpi"><b>${s.stories}</b><span>Stories</span></div>
      <div class="kpi"><b>${s.corroborated_clusters}</b><span>Corroborated</span></div>
      <div class="kpi"><b>${s.state.last_duration}s</b><span>Cycle time</span></div>
    </div>
    <table><thead><tr><th>Source</th><th>Status</th><th>Last ok</th><th>Items</th></tr></thead>
    <tbody>${d.feeds.map(f => `<tr>
      <td>${esc(f.name)}<br><span class="tag">${esc(f.category)}</span>
        ${f.error ? `<div class="err">${esc(f.error)}</div>` : ''}</td>
      <td><span class="dot ${esc(f.status)}"></span>${esc(f.status)}</td>
      <td>${clock(f.last_ok)}<br><span class="tag">${esc(ago(f.last_ok))}</span></td>
      <td>${f.items}</td></tr>`).join('')}</tbody></table>
    <p class="sum"><b>Idle</b> — the feed answered correctly but published nothing
    (arXiv does this at weekends). <b>Throttled</b> — the source returned 429; stored
    stories are still current, Reddit is polled a few subreddits per cycle for this
    reason. <b>Blocked</b> — the server answered but sent no feed, which is bot
    mitigation rather than a bug at this end. <b>Delayed</b> — no successful fetch
    for three of that feed's own cycles.
    <a href="#" id="opml" style="color:var(--accent)">Export OPML</a> ·
    <a href="#" id="dump" style="color:var(--accent)">Export archive</a></p>`;
  $('#opml').onclick = ev => { ev.preventDefault(); download('newsstack.opml', NEWSSTACK.opml(), 'text/xml'); };
  $('#dump').onclick = async ev => {
    ev.preventDefault();
    const data = await NEWSSTACK.exportAll();
    download('newsstack-archive.json', JSON.stringify(data), 'application/json');
  };
  const healthy = counts.online + counts.idle;
  $('#sub').textContent = `${healthy}/${d.feeds.length} sources healthy`;
}

function download(name, text, type){
  const url = URL.createObjectURL(new Blob([text], {type}));
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function refreshView(){
  try{
    if(tab === 'stories'){ await loadStories(); }
    else if(tab === 'saved'){ await loadSaved(); }
    else { await loadSources(); }
    if(tab === 'stories'){
      const d = await NEWSSTACK.feeds();
      // idle and throttled are expected states and recover on their own.
      // blocked means you are silently not receiving that source, so it counts.
      const bad = d.feeds.filter(f => ['error', 'delayed', 'blocked'].includes(f.status)).length;
      const late = d.feeds.filter(f => f.status === 'delayed');
      // Every feed going delayed at once is one gap - the host slept, or the
      // network dropped - not dozens of broken sources. Say which it is.
      if (late.length > d.feeds.length / 2) {
        const newest = Math.max(...late.map(f => f.last_ok || 0));
        const mins = Math.round((Date.now() / 1000 - newest) / 60);
        $('#sub').textContent = `catching up after a ${mins} min gap`;
      } else {
        $('#sub').textContent = bad ? `${bad} source${bad === 1 ? '' : 's'} need attention`
                                    : 'all sources healthy';
      }
    }
  }catch(e){ $('#sub').textContent = 'connection lost'; }
}

function setTab(name){
  tab = name;
  ['stories', 'saved', 'sources'].forEach(t => {
    $('#tab-' + t).classList.toggle('on', name === t);
    $('#' + t).classList.toggle('hide', name !== t);
  });
  $('#bar').classList.toggle('hide', name === 'sources');
  $('#acts').classList.toggle('hide', name === 'sources');
  // Hide read applies to the story list only, so do not offer it where it has
  // no effect.
  $('#hideread').classList.toggle('hide', name !== 'stories');
  $('#markpage').textContent = name === 'saved' ? 'Mark saved read' : 'Mark page read';
  refreshView();
}

function dropCard(art){
  const host = art.parentElement;
  art.remove();
  // Taking the last card out would otherwise leave a blank panel with nothing
  // saying why it is empty, so re-render to get the empty state and the counts.
  if(!host.querySelector('article[data-url]')) refreshView();
}

// One delegated listener per container rather than handlers rebound on every
// render: the list is replaced wholesale every 30 seconds.
function wireMarks(root){
  root.addEventListener('click', ev => {
    const art = ev.target.closest('article[data-url]');
    if(!art) return;
    const url = art.dataset.url;
    if(ev.target.classList.contains('tick')){
      const on = ev.target.checked;
      art.classList.toggle('read', on);
      mark({url, read: on}).then(ok => { if(!ok) refreshView(); });
      // Never thin the Saved tab: a bookmark leaves it only when unsaved.
      if(on && hideRead() && tab !== 'saved') dropCard(art);
      return;
    }
    if(ev.target.classList.contains('save')){
      const on = !ev.target.classList.contains('on');
      ev.target.classList.toggle('on', on);
      ev.target.textContent = on ? '★' : '☆';
      ev.target.title = on ? 'Remove from Saved' : 'Save for later';
      mark({url, saved: on}).then(ok => { if(!ok) refreshView(); });
      if(!on && tab === 'saved') dropCard(art);
      return;
    }
    // Opening the story is the strongest signal that it has been read, and
    // ticking it by hand afterwards is friction nobody keeps up.
    if(ev.target.closest('h2 a') && !art.classList.contains('read')){
      art.classList.add('read');
      const t = art.querySelector('.tick');
      if(t) t.checked = true;
      mark({url, read: true});
    }
  });
}
wireMarks($('#stories'));
wireMarks($('#saved'));

$('#hideread').classList.toggle('on', hideRead());
$('#hideread').onclick = () => {
  localStorage.setItem('hideread', hideRead() ? '0' : '1');
  $('#hideread').classList.toggle('on', hideRead());
  refreshView();
};
$('#markpage').onclick = async () => {
  const b = $('#markpage');
  const urls = [...document.querySelectorAll(
    (tab === 'saved' ? '#saved' : '#stories') + ' article[data-url]')]
    .filter(a => !a.classList.contains('read'))
    .map(a => a.dataset.url);
  if(!urls.length) return;
  b.disabled = true;
  // MARK_URLS_MAX is 500 and a page is at most 200, so one call.
  await mark({urls, read: true});
  b.disabled = false;
  refreshView();
};

$('#tab-stories').onclick = () => setTab('stories');
$('#tab-saved').onclick = () => setTab('saved');
$('#tab-sources').onclick = () => setTab('sources');
$('#sort').onchange = () => {
  // "Oldest first" inside the default 24h window means the oldest story of
  // today, which is not what anyone picking it wants. Open the window once,
  // on the switch, and leave it under manual control after that.
  if($('#sort').value === 'old' && $('#win').value) $('#win').value = '';
  refreshView();
};
$('#cat').onchange = refreshView;
$('#win').onchange = refreshView;
$('#q').oninput = () => { clearTimeout(timer); timer = setTimeout(refreshView, 250); };
$('#force').onclick = async () => {
  const b = $('#force'); b.disabled = true; b.textContent = 'Refreshing…';
  try{ await NEWSSTACK.refresh(); }
  finally { b.disabled = false; b.textContent = 'Refresh now'; refreshView(); }
};

// --------------------------------------------------------------------------
// Phone-specific wiring. None of this exists in v3.
// --------------------------------------------------------------------------

/** v3 runs a refresh thread forever. A PWA only runs while it is on screen. */
let lastCycle = 0;
async function maybeCycle(force){
  if(NEWSSTACK.state.running) return;
  const due = Date.now()/1000 - lastCycle > NEWSSTACK_CONFIG.REFRESH_SECONDS;
  if(!force && !due) return;
  lastCycle = Date.now()/1000;
  $('#sub').textContent = 'refreshing…';
  await NEWSSTACK.refresh();
  await refreshView();
}

/** Extraction runs between cycles, as v3's content_loop does. */
async function contentTick(){
  try{ if(await NEWSSTACK.contentBatch()) refreshView(); }
  catch(e){ /* an extraction failure costs an article, not the app */ }
}

function setupNotice(){
  if(NEWSSTACK_CONFIG.PROXY_BASE) return false;
  $('#setup').classList.remove('hide');
  $('#setup').innerHTML = `<b>One step left.</b> Every source will report
    <i>blocked</i> until you deploy the proxy and set <code>PROXY_BASE</code> in
    <code>config.js</code>. A browser cannot read a feed that sends no CORS
    header, and almost none of these do — this is not a bug you can configure
    around. See <b>DEPLOY.md</b>.`;
  return true;
}

/** Safari has no beforeinstallprompt; the only install path is the Share menu. */
function installHint(){
  const standalone = window.navigator.standalone === true ||
    window.matchMedia('(display-mode: standalone)').matches;
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if(standalone || !ios || localStorage.getItem('installhint') === 'off') return;
  $('#install').classList.remove('hide');
  $('#install').innerHTML = `<b>Add to Home Screen.</b> Tap the Share button,
    then <b>Add to Home Screen</b>. It opens full screen after that and keeps
    its own archive. <button id="hintoff">Got it</button>`;
  $('#hintoff').onclick = () => {
    localStorage.setItem('installhint', 'off');
    $('#install').classList.add('hide');
  };
}

async function boot(){
  await NEWSSTACK.ready();
  const blocked = setupNotice();
  installHint();

  const s = await NEWSSTACK.stats();
  $('#cat').insertAdjacentHTML('beforeend',
    Object.keys(s.by_category).sort().map(c => `<option>${esc(c)}</option>`).join(''));
  await refreshView();

  if(!blocked){
    // An empty archive means this is the first run: fetch before the timer.
    await maybeCycle(s.stories === 0);
    setInterval(maybeCycle, 30000);
    setInterval(contentTick, NEWSSTACK_CONFIG.CONTENT_INTERVAL * 1000);
    // iOS suspends timers the moment the app leaves the screen, so coming back
    // is the only reliable moment to catch up.
    document.addEventListener('visibilitychange', () => {
      if(document.visibilityState === 'visible') maybeCycle();
    });
  }
  setInterval(refreshView, 30000);
}

if('serviceWorker' in navigator){
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
boot();
