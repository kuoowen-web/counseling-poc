const { CLIENT_ID, API_URL } = window.APP_CONFIG;
const SESSION_KEY = 'crs_session';
const NEW_CLIENT = '__new__';
const $ = id => document.getElementById(id);

const state = {
  user: null,
  clients: [],        // 自己「進行中」的個案代號
  serviceTypes: [],
  records: [],        // 伺服器確認過的紀錄
  maxAttachments: 3,
  editingId: null,
  month: currentMonth(),
};
// 待送出的動作：{ action: 'save'|'void', payload, status: 'waiting'|'sending'|'failed', error }
// 只存在記憶體：關閉頁面前要等它清空（畫面底部會提示）
const queue = [];
let draining = false;

// =====================================================================
// 登入
// =====================================================================

function initGsi() {
  google.accounts.id.initialize({ client_id: CLIENT_ID, callback: onCredential });
  if (sessionValid()) return bootstrap();
  showLogin();
}

function showLogin(message) {
  $('app-view').classList.add('hidden');
  $('login-view').classList.remove('hidden');
  $('who').innerHTML = '';
  $('login-error').textContent = message || '';
  google.accounts.id.renderButton($('gsi-button'), { theme: 'filled_blue', size: 'large', text: 'signin_with' });
}

async function onCredential(resp) {
  try {
    const { session } = await api('login', { idToken: resp.credential });
    localStorage.setItem(SESSION_KEY, session);
    // 送出途中登入過期的動作，重新登入後自動重送
    queue.filter(q => q.status === 'failed' && q.auth).forEach(q => { q.status = 'waiting'; });
    await bootstrap();
    drain();
  } catch (err) {
    showLogin(err.message);
  }
}

function sessionValid() {
  const s = localStorage.getItem(SESSION_KEY);
  if (!s) return false;
  try {
    const body = JSON.parse(atob(s.split('.')[0].replace(/-/g, '+').replace(/_/g, '/')));
    return body.x > Date.now() + 60000;
  } catch (e) {
    return false;
  }
}

function signOut() {
  if (queue.length) return setStatus('還有紀錄在上傳，請等上傳完成再登出', 'warn');
  localStorage.removeItem(SESSION_KEY);
  location.reload();
}

// =====================================================================
// API
// =====================================================================

async function api(action, payload) {
  const res = await fetch(API_URL, {
    method: 'POST',
    // text/plain 避開 CORS preflight（Apps Script 不處理 OPTIONS）
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ session: localStorage.getItem(SESSION_KEY), action, payload }),
  });
  const json = await res.json();
  if (!json.ok) {
    const err = new Error(json.error);
    err.auth = json.auth;
    if (json.auth && action !== 'login') localStorage.removeItem(SESSION_KEY);
    throw err;
  }
  return json.data;
}

async function bootstrap() {
  $('login-view').classList.add('hidden');
  setStatus('載入中…');
  try {
    const data = await api('bootstrap');
    state.user = data.user;
    state.clients = data.clients;
    state.serviceTypes = data.serviceTypes;
    state.records = data.records;
    state.maxAttachments = data.maxAttachments;
    $('who').innerHTML = `<span>${esc(state.user.name)}</span><button onclick="signOut()">登出</button>`;
    $('app-view').classList.remove('hidden');
    resetForm();
    renderList();
    if (queue.length) renderStatus(); else setStatus('');
  } catch (err) {
    setStatus('');
    if (err.auth) return showLogin(err.message);
    showLogin('載入失敗：' + err.message);
  }
}

// =====================================================================
// 表單
// =====================================================================

function resetForm() {
  state.editingId = null;
  $('form-title').textContent = '新增一筆';
  $('cancel-edit').classList.add('hidden');
  $('void').classList.add('hidden');
  $('f-date').value = today();
  renderClientSelect('');
  renderTypeChips('');
  $('f-amount').value = '';
  $('f-amount').disabled = false;
  $('amount-hint').textContent = '';
  $('f-note').value = '';
  $('f-files').value = '';
  $('existing-files').textContent = '';
  $('form-error').textContent = '';
  resetVoidButton();
}

function renderClientSelect(selected) {
  const codes = [...state.clients];
  if (selected && !codes.includes(selected)) codes.unshift(selected); // 已移交或結案個案的舊紀錄
  $('f-client').innerHTML = '<option value="">請選擇個案</option>' +
    codes.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('') +
    `<option value="${NEW_CLIENT}">＋ 新增個案…</option>`;
  $('f-client').value = selected;
  $('f-new-client').classList.add('hidden');
  $('f-new-client').value = '';
}

function renderTypeChips(selected) {
  const types = [...state.serviceTypes];
  if (selected && !types.includes(selected)) types.push(selected); // 已停用的性質仍能顯示在舊紀錄
  $('f-type').innerHTML = types.map(t => `
    <label><input type="radio" name="type" value="${esc(t)}" ${t === selected ? 'checked' : ''}><span>${esc(t)}</span></label>`).join('');
}

function selectedType() {
  const el = document.querySelector('input[name="type"]:checked');
  return el ? el.value : '';
}

// 選個案後：帶入這位個案上一次的性質與金額
function onClientChange() {
  const v = $('f-client').value;
  $('f-new-client').classList.toggle('hidden', v !== NEW_CLIENT);
  if (v === NEW_CLIENT) return $('f-new-client').focus();
  if (state.editingId || !v) return;
  const last = lastRecordFor(v);
  if (!last) return ($('amount-hint').textContent = '');
  renderTypeChips(last.type);
  $('f-amount').value = last.amount;
  $('amount-hint').textContent = '（已帶入上次的金額）';
}

function lastRecordFor(client) {
  return allRecords()
    .filter(r => r.client === client && !r.voided)
    .sort((a, b) => (b.date + b.updated).localeCompare(a.date + a.updated))[0];
}

function editRecord(id) {
  const r = allRecords().find(x => x.record_id === id);
  if (!r) return;
  if (r.voided) return setStatus('這筆已作廢，不能修改', 'warn');
  if (queue.some(q => q.payload.record_id === id)) return setStatus('這筆還在上傳中，請稍候', 'warn');

  state.editingId = id;
  $('form-title').textContent = '修改紀錄';
  $('cancel-edit').classList.remove('hidden');
  $('f-date').value = r.date;
  renderClientSelect(r.client);
  renderTypeChips(r.type);
  $('f-amount').value = r.amount;
  $('f-amount').disabled = r.reconciled;
  $('amount-hint').textContent = r.reconciled ? '（已對帳，金額已鎖定）' : '';
  $('f-note').value = r.note;
  $('f-files').value = '';
  $('existing-files').textContent = r.attachments.length
    ? `目前附件：${r.attachments.join('、')}（選新檔案會整組取代）` : '';
  $('void').classList.toggle('hidden', r.reconciled);
  $('form-error').textContent = '';
  resetVoidButton();
  switchTab('form');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function save() {
  $('form-error').textContent = '';
  let client = $('f-client').value;
  if (client === NEW_CLIENT) client = $('f-new-client').value.trim();
  const amount = $('f-amount').value.trim();
  const files = [...$('f-files').files];

  const problem = !client ? '請選擇或輸入個案'
    : !selectedType() ? '請選擇諮商性質'
    : !/^\d+$/.test(amount) ? '請輸入金額（整數）'
    : files.length > state.maxAttachments ? `附件最多 ${state.maxAttachments} 個`
    : '';
  if (problem) return ($('form-error').textContent = problem);

  const payload = {
    record_id: state.editingId || newRecordId(),
    date: $('f-date').value,
    client,
    type: selectedType(),
    amount: Number(amount),
    note: $('f-note').value,
  };

  $('save').disabled = true;
  try {
    if (files.length) {
      setStatus('處理附件中…');
      payload.attachments = await Promise.all(files.map(fileToPayload));
    }
  } catch (err) {
    $('save').disabled = false;
    return ($('form-error').textContent = '附件處理失敗：' + err.message);
  }
  $('save').disabled = false;

  if (!state.clients.includes(client) && !state.editingId) state.clients.push(client);
  const wasEditing = !!state.editingId;
  enqueue('save', payload);
  resetForm();
  if (wasEditing) switchTab('list');
}

// 作廢要按兩次，避免誤觸（不用瀏覽器的確認對話框）
let voidArmed = null;
function onVoidClick() {
  if (!voidArmed) {
    $('void').textContent = '再按一次確認作廢';
    voidArmed = setTimeout(resetVoidButton, 4000);
    return;
  }
  const id = state.editingId;
  resetVoidButton();
  enqueue('void', { record_id: id });
  resetForm();
  switchTab('list');
}

function resetVoidButton() {
  clearTimeout(voidArmed);
  voidArmed = null;
  $('void').textContent = '作廢這筆';
}

// =====================================================================
// 上傳佇列：按下儲存立刻可以填下一筆，背景依序送出
// =====================================================================

function enqueue(action, payload) {
  queue.push({ action, payload, status: 'waiting' });
  renderList();
  renderStatus();
  drain();
}

async function drain() {
  if (draining) return;
  draining = true;
  let q;
  while ((q = queue.find(x => x.status === 'waiting'))) {
    q.status = 'sending';
    renderStatus();
    try {
      const saved = await api(q.action, q.payload);
      const i = state.records.findIndex(r => r.record_id === saved.record_id);
      if (i >= 0) state.records[i] = saved; else state.records.push(saved);
      queue.splice(queue.indexOf(q), 1);
    } catch (err) {
      q.status = 'failed';
      q.error = err.message;
      q.auth = err.auth;
      if (err.auth) showLogin('登入已過期，重新登入後會自動送出未完成的紀錄');
    }
    renderList();
    renderStatus();
  }
  draining = false;
}

function retry(id) {
  const q = queue.find(x => x.payload.record_id === id);
  if (!q) return;
  q.status = 'waiting';
  drain();
}

function discard(id) {
  const i = queue.findIndex(x => x.payload.record_id === id);
  if (i >= 0) queue.splice(i, 1);
  renderList();
  renderStatus();
}

// 伺服器紀錄＋佇列中尚未送出的修改（畫面上立即反映）
function allRecords() {
  const map = new Map(state.records.map(r => [r.record_id, r]));
  queue.forEach(q => {
    const base = map.get(q.payload.record_id) ||
      { attachments: [], paid: false, reconciled: false, voided: false, updated: '' };
    const merged = q.action === 'void'
      ? { ...base, voided: true }
      : { ...base, ...q.payload, attachments: q.payload.attachments ? q.payload.attachments.map(a => a.name) : base.attachments };
    map.set(q.payload.record_id, { ...merged, pending: q });
  });
  return [...map.values()];
}

// =====================================================================
// 我的紀錄
// =====================================================================

function renderList() {
  $('month-label').textContent = state.month.replace('-', ' 年 ') + ' 月';
  const rows = allRecords()
    .filter(r => r.date.startsWith(state.month))
    .sort((a, b) => (b.date + b.updated).localeCompare(a.date + a.updated));
  const count = rows.filter(r => !r.voided).length;
  $('month-summary').textContent = rows.length ? `本月 ${count} 筆` : '';

  $('records').innerHTML = rows.length ? rows.map(r => {
    const q = r.pending;
    const badges = [
      q && q.status === 'failed' ? '<span class="badge err">上傳失敗</span>' : q ? '<span class="badge warn">上傳中</span>' : '',
      r.voided ? '<span class="badge grey">已作廢</span>' : '',
      r.reconciled ? '<span class="badge">已對帳</span>' : r.paid ? '<span class="badge">已收款</span>' : '',
      r.attachments.length ? `<span class="badge grey">📎${r.attachments.length}</span>` : '',
    ].join('');
    const failedActions = q && q.status === 'failed'
      ? `<div class="sub error">${esc(q.error)}</div>
         <div><button class="link" onclick="event.stopPropagation();retry('${r.record_id}')">重試</button>
         <button class="link" onclick="event.stopPropagation();discard('${r.record_id}')">放棄</button></div>` : '';
    return `
      <div class="rec ${r.voided ? 'voided' : ''}" onclick="editRecord('${r.record_id}')">
        <div>
          <div class="main">${esc(r.date.slice(5))}　${esc(r.client)}　${esc(r.type)}${badges}</div>
          ${r.note ? `<div class="sub">${esc(r.note.slice(0, 30))}${r.note.length > 30 ? '…' : ''}</div>` : ''}
          ${failedActions}
        </div>
        <div class="amount">$${Number(r.amount).toLocaleString()}</div>
      </div>`;
  }).join('') : '<p class="empty">這個月還沒有紀錄</p>';
}

function shiftMonth(delta) {
  const [y, m] = state.month.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  state.month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  renderList();
}

// =====================================================================
// 狀態列
// =====================================================================

function renderStatus() {
  const active = queue.filter(q => q.status !== 'failed').length;
  const failed = queue.length - active;
  if (active) return setStatus(`上傳中 ${active} 筆，請勿關閉頁面`, 'warn');
  if (failed) return setStatus(`${failed} 筆上傳失敗，請到「我的紀錄」重試`, 'err');
  setStatus('全部已儲存 ✓', 'ok', 2500);
}

let statusTimer = null;
function setStatus(text, kind, hideAfter) {
  clearTimeout(statusTimer);
  const bar = $('status-bar');
  bar.textContent = text;
  bar.className = text ? kind || '' : 'hidden';
  if (hideAfter) statusTimer = setTimeout(() => { bar.className = 'hidden'; }, hideAfter);
}

// =====================================================================
// 工具
// =====================================================================

function switchTab(tab) {
  document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  $('form-view').classList.toggle('hidden', tab !== 'form');
  $('list-view').classList.toggle('hidden', tab !== 'list');
}

function today() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

function currentMonth() { return today().slice(0, 7); }

// 前端先產生編號：重送同一筆時後端只會更新，不會重複新增
function newRecordId() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `R${stamp}-${Math.random().toString(36).slice(2, 8).padEnd(6, '0')}`;
}

// 照片在手機端壓縮到長邊 1600px；其他檔案原樣上傳
async function fileToPayload(file) {
  if (file.size > 10 * 1024 * 1024 && !file.type.startsWith('image/')) throw new Error(`「${file.name}」超過 10 MB`);
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
  const bytes = new Uint8Array(await file.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return { name: file.name, mimeType: file.type || 'application/octet-stream', base64: btoa(bin) };
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// =====================================================================
// 事件
// =====================================================================

document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));
$('f-client').addEventListener('change', onClientChange);
$('save').addEventListener('click', save);
$('void').addEventListener('click', onVoidClick);
$('cancel-edit').addEventListener('click', () => { resetForm(); switchTab('list'); });
$('prev-month').addEventListener('click', () => shiftMonth(-1));
$('next-month').addEventListener('click', () => shiftMonth(1));
// 還有未送出的紀錄時，關閉頁面前提醒（桌機與 Android 有效；iPhone 不保證）
window.addEventListener('beforeunload', e => { if (queue.length) { e.preventDefault(); e.returnValue = ''; } });
window.addEventListener('load', initGsi);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
