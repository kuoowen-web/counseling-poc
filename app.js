const { CLIENT_ID, API_URL } = window.APP_CONFIG;
const TOKEN_KEY = 'poc_id_token';
const $ = id => document.getElementById(id);

let records = [];      // 伺服器確認過的紀錄
const queue = [];      // 待上傳：{ payload, status: 'waiting'|'sending'|'failed', error }
let draining = false;

// ---------- 登入 ----------

function initGsi() {
  google.accounts.id.initialize({ client_id: CLIENT_ID, callback: onCredential, auto_select: true });
  if (loadToken()) return startApp();
  google.accounts.id.renderButton($('gsi-button'), { theme: 'filled_blue', size: 'large', text: 'signin_with' });
  google.accounts.id.prompt();
}

function onCredential(resp) {
  // PoC：存在 localStorage 以測試「重開 App 不用重新登入」；正式版要改成後端核發的 session
  localStorage.setItem(TOKEN_KEY, resp.credential);
  // 上傳途中登入過期：重新登入後把因此失敗的紀錄放回佇列，不用重填
  queue.filter(q => q.status === 'failed' && /登入|憑證/.test(q.error)).forEach(q => { q.status = 'waiting'; });
  if ($('app').classList.contains('hidden')) startApp(); else drain();
}

function loadToken() {
  const t = localStorage.getItem(TOKEN_KEY);
  if (!t) return null;
  const payload = JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
  return payload.exp * 1000 > Date.now() + 60000 ? t : null;
}

function signOut() {
  if (queue.length) return alertStatus('還有紀錄在上傳，請等上傳完成再登出');
  localStorage.removeItem(TOKEN_KEY);
  google.accounts.id.disableAutoSelect();
  location.reload();
}

// ---------- API ----------

async function api(action, payload) {
  const t0 = performance.now();
  // text/plain 避開 CORS preflight（Apps Script 不處理 OPTIONS）
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ idToken: localStorage.getItem(TOKEN_KEY), action, payload }),
  });
  const json = await res.json();
  const total = Math.round(performance.now() - t0);
  $('log').textContent = `${new Date().toLocaleTimeString()} ${action}: 總共 ${total} ms（伺服器 ${json.serverMs} ms）\n` + $('log').textContent;
  if (!json.ok) throw new Error(json.error);
  return json.data;
}

// ---------- 畫面 ----------

async function startApp() {
  $('login-box').classList.add('hidden');
  try {
    const { user, records: list } = await api('bootstrap');
    $('who').innerHTML = `${escapeHtml(user.name || user.email)} <button class="secondary" onclick="signOut()">登出</button>`;
    $('app').classList.remove('hidden');
    records = list;
    resetForm();
    render();
  } catch (err) {
    if (/登入|憑證/.test(err.message)) localStorage.removeItem(TOKEN_KEY);
    $('login-box').classList.remove('hidden');
    $('login-box').insertAdjacentHTML('beforeend', `<p style="color:#b00">${escapeHtml(err.message)}</p>`);
    google.accounts.id.renderButton($('gsi-button'), { theme: 'filled_blue', size: 'large' });
  }
}

function today() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

// 前端先產生編號：重送同一筆時後端只會更新，不會重複新增
function newRecordId() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `R${stamp}-${Math.random().toString(36).slice(2, 8).padEnd(6, '0')}`;
}

function resetForm() {
  $('form-title').textContent = '新增一筆';
  $('record_id').value = '';
  $('service_date').value = today();
  $('client_code').value = '';
  $('amount').value = '';
  $('note').value = '';
  $('file').value = '';
}

function alertStatus(msg) { $('status').textContent = msg; }

function render() {
  const pending = new Map(queue.map(q => [q.payload.record_id, q]));
  const merged = new Map(records.map(r => [r.record_id, r]));
  queue.forEach(q => merged.set(q.payload.record_id, Object.assign({}, merged.get(q.payload.record_id), q.payload,
    { file_ids: q.payload.attachment ? 'pending' : (merged.get(q.payload.record_id) || {}).file_ids })));

  const rows = [...merged.values()].sort((a, b) => String(b.service_date).localeCompare(String(a.service_date)));
  $('list').innerHTML = rows.length ? rows.map(r => {
    const q = pending.get(r.record_id);
    const badge = !q ? '' : q.status === 'failed'
      ? `<br><small style="color:#b00">⚠ 上傳失敗：${escapeHtml(q.error)}</small>`
      : '<br><small style="color:#a60">⏳ 上傳中…</small>';
    const action = !q ? `<button class="secondary" onclick="editRecord('${r.record_id}')">修改</button>`
      : q.status === 'failed' ? `<button class="secondary" onclick="retry('${r.record_id}')">重試</button>` : '';
    return `
    <div class="rec">
      <div>${escapeHtml(r.service_date)}｜${escapeHtml(r.client_code)}｜$${escapeHtml(r.amount)}<br>
        <small>${escapeHtml(String(r.note ?? '').slice(0, 40))}${r.file_ids ? '｜📎 已附檔' : ''}</small>${badge}</div>
      ${action}
    </div>`;
  }).join('') : '<p>還沒有紀錄。</p>';

  const active = queue.filter(q => q.status !== 'failed').length;
  const failed = queue.length - active;
  $('status').textContent = active ? `上傳中 ${active} 筆，請勿關閉頁面` : failed ? `${failed} 筆上傳失敗，請按「重試」` : '全部已儲存 ✓';
}

function editRecord(id) {
  const r = records.find(x => x.record_id === id);
  $('form-title').textContent = '修改紀錄';
  $('record_id').value = r.record_id;
  $('service_date').value = r.service_date;
  $('client_code').value = r.client_code;
  $('amount').value = r.amount;
  $('note').value = r.note;
  $('file').value = '';
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// 按下儲存：先把表單內容放進佇列、清空表單，讓心理師可以馬上填下一筆
async function save() {
  const f = $('file').files[0];
  const payload = {
    record_id: $('record_id').value || newRecordId(),
    service_date: $('service_date').value,
    client_code: $('client_code').value.trim(),
    amount: $('amount').value,
    note: $('note').value,
  };
  if (!payload.client_code) return alertStatus('請填個案代號');
  if (queue.some(q => q.payload.record_id === payload.record_id)) return alertStatus('這筆還在上傳中，請稍候再修改');

  $('save').disabled = true;
  try {
    if (f) payload.attachment = await fileToPayload(f);
  } finally {
    $('save').disabled = false;
  }
  queue.push({ payload, status: 'waiting' });
  resetForm();
  render();
  drain();
}

async function drain() {
  if (draining) return;
  draining = true;
  let q;
  while ((q = queue.find(x => x.status === 'waiting'))) {
    q.status = 'sending';
    try {
      const saved = await api('save', q.payload);
      const i = records.findIndex(r => r.record_id === saved.record_id);
      if (i >= 0) records[i] = saved; else records.push(saved);
      queue.splice(queue.indexOf(q), 1);
    } catch (err) {
      q.status = 'failed';
      q.error = err.message;
      if (/登入|憑證/.test(err.message)) google.accounts.id.prompt();
    }
    render();
  }
  draining = false;
}

function retry(id) {
  const q = queue.find(x => x.payload.record_id === id);
  if (!q) return;
  q.status = 'waiting';
  render();
  drain();
}

// 照片在手機端壓縮到長邊 1600px；其他檔案原樣上傳
async function fileToPayload(file) {
  if (file.type.startsWith('image/')) {
    const img = await createImageBitmap(file);
    const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
    return { name: file.name.replace(/\.\w+$/, '') + '.jpg', mimeType: 'image/jpeg', base64: dataUrl.split(',')[1] };
  }
  const buf = await file.arrayBuffer();
  let bin = '';
  new Uint8Array(buf).forEach(b => { bin += String.fromCharCode(b); });
  return { name: file.name, mimeType: file.type || 'application/octet-stream', base64: btoa(bin) };
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

$('save').addEventListener('click', save);
$('reset').addEventListener('click', resetForm);
// 還有未上傳的紀錄時，關閉頁面前提醒（桌機與 Android 有效；iPhone 不保證）
window.addEventListener('beforeunload', e => { if (queue.length) { e.preventDefault(); e.returnValue = ''; } });
window.addEventListener('load', initGsi);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
