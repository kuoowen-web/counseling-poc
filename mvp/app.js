const { CLIENT_ID, API_URL } = window.APP_CONFIG;
const SESSION_KEY = 'crs_session';
const NEW_CLIENT = '__new__';
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 90000;
const $ = id => document.getElementById(id);

// =====================================================================
// 文案：所有給使用者看的提示集中在這裡。後台只回錯誤代碼（code），這裡決定怎麼說。
// =====================================================================

const TEXT = {
  loginHint: '請用診所登記的 Google 帳號登入。按下後會跳出 Google 視窗；如果沒有出現，請允許此網站開啟彈出式視窗。',
  loggingIn: '登入中，約需 5～10 秒，請稍候……',
  loading: '載入資料中，約需 5～10 秒，請稍候……',
  processingFiles: '處理附件中，請稍候……',
  uploading: n => `上傳中 ${n} 筆，請勿關閉頁面……`,
  allSaved: '全部已儲存 ✓',
  signOutBlocked: n => `還有 ${n} 筆在上傳，請等上傳完成再登出。`,
  stillUploading: '這筆還在上傳中，請稍候……',
  voidedNoEdit: '這筆已作廢，不能再修改。',
  confirmVoid: '再按一次確認作廢',
  sessionExpiredQueued: '登入已到期，請重新登入。未送出的紀錄會在登入後自動送出。',
  switchAccount: '可按下方按鈕改用其他 Google 帳號登入。',
};

// 表單檢查（按儲存時，資料不會送出）
const FORM = {
  noDate: '請選擇日期。',
  noClient: '請選擇個案，或選「＋ 新增個案」輸入代號。',
  noNewClient: '請輸入新個案的代號。',
  clientTooLong: '個案代號最多 30 個字。',
  noType: '請選擇諮商性質。',
  badAmount: '請輸入金額，只能填數字，例如 1600。',
  tooManyFiles: (max, n) => `附件最多 ${max} 個，你選了 ${n} 個。`,
  fileTooLarge: name => `「${name}」超過 10 MB，請壓縮後再上傳。`,
  imageUnreadable: name => `「${name}」無法讀取，請改用 JPG 照片，或直接拍照上傳。`,
};

// 錯誤代碼 → 文案。where = 'load'（登入／載入畫面）或 'queue'（上傳失敗）
function describeError(err, where) {
  const p = err.params || {};
  switch (err.code) {
    case 'NETWORK':
      return where === 'load' ? '連不上網路，請確認手機網路後重新整理。' : '網路連線中斷。請確認網路後按「重試」。';
    case 'SERVER_DOWN':
      return where === 'load' ? '系統暫時沒有回應，請稍後再試。持續發生請聯絡系統維護人員。' : '系統暫時沒有回應，請稍等一下再按「重試」。';
    case 'BUSY': return '系統忙碌中，請稍等一下再按「重試」。';
    case 'NOT_REGISTERED': return `這個 Google 帳號（${p.email}）還沒有加入系統。請聯絡診所負責人，把這個 Gmail 加進名單。`;
    case 'DISABLED':
      return where === 'load' ? `這個帳號（${p.email}）已停用。如有疑問，請聯絡診所負責人。` : '你的帳號已停用，這筆沒有送出。請聯絡診所負責人。';
    case 'GOOGLE_LOGIN_FAILED': return 'Google 登入沒有完成，請再按一次登入。';
    case 'SESSION_EXPIRED': return where === 'load' ? '登入已超過 30 天，請重新登入。' : TEXT.sessionExpiredQueued;
    case 'SESSION_INVALID': return where === 'load' ? '請重新登入。' : TEXT.sessionExpiredQueued;
    case 'CONFIG': return '系統設定有問題，請聯絡診所負責人。';
    case 'CLIENT_TAKEN': return `個案代號「${p.client}」已被其他心理師使用，請換一個代號。`;
    case 'RECONCILED_AMOUNT': return '這筆負責人已對帳，金額不能修改。需要更正請聯絡診所負責人。';
    case 'RECONCILED_VOID': return '這筆負責人已對帳，不能作廢。需要更正請聯絡診所負責人。';
    case 'VOIDED': return '這筆已作廢，不能再修改。';
    case 'NOT_FOUND':
    case 'NOT_OWNER': return '找不到你的這筆紀錄，可能已被負責人移除。';
    case 'FILE_TOO_LARGE': return FORM.fileTooLarge(p.name);
    case 'BAD_INPUT': return `資料格式有誤：${err.detail}`;
    default: return '發生未預期的錯誤，請稍後再試。持續發生請聯絡系統維護人員。';
  }
}

// 這些錯誤附上技術原因（小字），方便負責人轉給系統維護人員
const SHOW_DETAIL = ['CONFIG', 'UNKNOWN'];
// 上傳失敗時提供哪些按鈕
const RETRYABLE = ['NETWORK', 'SERVER_DOWN', 'BUSY', 'UNKNOWN'];
const EDITABLE = ['CLIENT_TAKEN', 'RECONCILED_AMOUNT', 'FILE_TOO_LARGE', 'BAD_INPUT'];
const AUTH_RETRY = ['SESSION_EXPIRED', 'SESSION_INVALID'];

function failurePrefix(q) { return q.action === 'void' ? '作廢失敗：' : '上傳失敗：'; }

// =====================================================================
// 狀態
// =====================================================================

const state = {
  user: null,
  clients: [],        // 自己「進行中」的個案代號
  serviceTypes: [],
  records: [],        // 伺服器確認過的紀錄
  maxAttachments: 3,
  editingId: null,
  editingQueued: null, // 正在修改的「上傳失敗」項目：送出時取代它
  month: currentMonth(),
};
// 待送出的動作：{ action: 'save'|'void', payload, status: 'waiting'|'sending'|'failed', err, newClient }
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

function showView(view) {
  ['login-view', 'loading-view', 'app-view'].forEach(v => $(v).classList.toggle('hidden', v !== view));
}

function showLoading(text) {
  $('loading-text').textContent = text;
  showView('loading-view');
}

function showLogin(err) {
  showView('login-view');
  $('who').innerHTML = '';
  $('login-hint').textContent = TEXT.loginHint;
  let message = '', detail = '';
  if (err) {
    message = describeError(err, err.queued ? 'queue' : 'load');
    if (err.code === 'NOT_REGISTERED' || err.code === 'DISABLED') message += TEXT.switchAccount;
    if (SHOW_DETAIL.includes(err.code || 'UNKNOWN')) detail = err.detail || '';
    if (err.code === 'NOT_REGISTERED' || err.code === 'DISABLED') google.accounts.id.disableAutoSelect();
  }
  $('login-error').textContent = message;
  $('login-detail').textContent = detail;
  google.accounts.id.renderButton($('gsi-button'), { theme: 'filled_blue', size: 'large', text: 'signin_with' });
}

async function onCredential(resp) {
  showLoading(TEXT.loggingIn);
  try {
    const { session } = await api('login', { idToken: resp.credential });
    localStorage.setItem(SESSION_KEY, session);
    // 送出途中登入到期的動作，重新登入後自動重送
    queue.filter(q => q.status === 'failed' && AUTH_RETRY.includes(q.err.code)).forEach(q => { q.status = 'waiting'; });
    await bootstrap();
    drain();
  } catch (err) {
    showLogin(err);
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
  if (queue.length) return setStatus(TEXT.signOutBlocked(queue.length), 'warn');
  localStorage.removeItem(SESSION_KEY);
  location.reload();
}

// =====================================================================
// API
// =====================================================================

function appError(code, params, detail) {
  const err = new Error(detail || code);
  err.code = code;
  err.params = params || {};
  err.detail = detail || '';
  return err;
}

async function api(action, payload) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(API_URL, {
      method: 'POST',
      // text/plain 避開 CORS preflight（Apps Script 不處理 OPTIONS）
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ session: localStorage.getItem(SESSION_KEY), action, payload }),
      signal: ctrl.signal,
    });
  } catch (e) {
    throw appError('NETWORK');
  } finally {
    clearTimeout(timer);
  }
  let json;
  try {
    json = await res.json();
  } catch (e) {
    throw appError('SERVER_DOWN', null, 'HTTP ' + res.status);
  }
  if (!json.ok) {
    const err = appError(json.code || 'UNKNOWN', json.params, json.error);
    err.auth = json.auth;
    if (json.auth && action !== 'login') localStorage.removeItem(SESSION_KEY);
    throw err;
  }
  return json.data;
}

async function bootstrap() {
  showLoading(TEXT.loading);
  try {
    const data = await api('bootstrap');
    state.user = data.user;
    state.clients = data.clients;
    state.serviceTypes = data.serviceTypes;
    state.records = data.records;
    state.maxAttachments = data.maxAttachments;
    $('who').innerHTML = `<span>${esc(state.user.name)}</span><button onclick="signOut()">登出</button>`;
    showView('app-view');
    resetForm();
    renderList();
    if (queue.length) renderStatus(); else setStatus('');
  } catch (err) {
    showLogin(err);
  }
}

// =====================================================================
// 表單
// =====================================================================

function resetForm() {
  state.editingId = null;
  state.editingQueued = null;
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
    `<option value="${NEW_CLIENT}">＋ 新增個案……</option>`;
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
  const pending = queue.find(q => q.payload.record_id === id);
  if (pending) return pending.status === 'failed' ? editFailed(pending) : setStatus(TEXT.stillUploading, 'warn');
  if (r.voided) return setStatus(TEXT.voidedNoEdit, 'warn', 3000);

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

// 上傳失敗的那筆：把送出的內容（含附件）帶回表單，改完再送
function editFailed(q) {
  if (q.action !== 'save' || !EDITABLE.includes(q.err.code)) {
    switchTab('list');
    return window.scrollTo(0, 0);
  }
  const p = q.payload;
  const base = state.records.find(r => r.record_id === p.record_id);
  state.editingId = p.record_id;
  state.editingQueued = q;
  $('form-title').textContent = '修改後重新送出';
  $('cancel-edit').classList.remove('hidden');
  $('f-date').value = p.date;
  renderClientSelect(p.client);
  renderTypeChips(p.type);
  $('f-amount').value = p.amount;
  $('f-amount').disabled = !!(base && base.reconciled);
  $('amount-hint').textContent = base && base.reconciled ? '（已對帳，金額已鎖定）' : '';
  if (base && base.reconciled) $('f-amount').value = base.amount;
  $('f-note').value = p.note;
  $('f-files').value = '';
  $('existing-files').textContent = p.attachments
    ? `待送出的附件：${p.attachments.map(a => a.name).join('、')}（沒選新檔案就沿用）` : '';
  $('void').classList.add('hidden');
  $('form-error').textContent = '上次失敗原因：' + describeError(q.err, 'queue');
  resetVoidButton();
  switchTab('form');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function validateForm(client, isNew, amount, files) {
  if (!$('f-date').value) return FORM.noDate;
  if (isNew && !client) return FORM.noNewClient;
  if (!client) return FORM.noClient;
  if (client.length > 30) return FORM.clientTooLong;
  if (!selectedType()) return FORM.noType;
  if (!/^\d+$/.test(amount)) return FORM.badAmount;
  if (files.length > state.maxAttachments) return FORM.tooManyFiles(state.maxAttachments, files.length);
  const big = files.find(f => f.size > MAX_FILE_BYTES && !f.type.startsWith('image/'));
  if (big) return FORM.fileTooLarge(big.name);
  return '';
}

async function save() {
  $('form-error').textContent = '';
  const isNew = $('f-client').value === NEW_CLIENT;
  const client = isNew ? $('f-new-client').value.trim() : $('f-client').value;
  const amount = $('f-amount').value.trim();
  const files = [...$('f-files').files];

  const problem = validateForm(client, isNew, amount, files);
  if (problem) return ($('form-error').textContent = problem);

  const payload = {
    record_id: state.editingId || newRecordId(),
    date: $('f-date').value,
    client,
    type: selectedType(),
    amount: Number(amount),
    note: $('f-note').value,
  };

  if (files.length) {
    $('save').disabled = true;
    setStatus(TEXT.processingFiles, 'warn');
    try {
      payload.attachments = [];
      for (const f of files) payload.attachments.push(await fileToPayload(f));
    } catch (err) {
      $('form-error').textContent = err.message;
      return queue.length ? renderStatus() : setStatus('');
    } finally {
      $('save').disabled = false;
    }
  }

  const replacing = state.editingQueued;
  if (replacing) {
    if (!payload.attachments && replacing.payload.attachments) payload.attachments = replacing.payload.attachments;
    queue.splice(queue.indexOf(replacing), 1);
  }
  const isNewClient = !state.clients.includes(client) && (!state.editingId || replacing);
  if (isNewClient) state.clients.push(client);
  const wasEditing = !!state.editingId;
  enqueue('save', payload, isNewClient ? client : null);
  resetForm();
  if (wasEditing) switchTab('list');
}

// 作廢要按兩次，避免誤觸（不用瀏覽器的確認對話框）
let voidArmed = null;
function onVoidClick() {
  if (!voidArmed) {
    $('void').textContent = TEXT.confirmVoid;
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

function enqueue(action, payload, newClient) {
  queue.push({ action, payload, status: 'waiting', newClient });
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
      q.err = err;
      // 新個案沒建成功（例如代號被別人用了），從選單拿掉
      if (q.newClient && !err.auth) state.clients = state.clients.filter(c => c !== q.newClient);
      if (err.auth) {
        err.queued = true;
        showLogin(err);
      }
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
  renderList();
  drain();
}

function discard(id) {
  const i = queue.findIndex(x => x.payload.record_id === id);
  if (i >= 0) {
    const [q] = queue.splice(i, 1);
    if (state.editingQueued === q) resetForm();
  }
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

function failureButtons(q, id) {
  const btn = (label, fn) => `<button class="link" onclick="event.stopPropagation();${fn}('${id}')">${label}</button>`;
  if (q.action === 'void' && q.err.code === 'RECONCILED_VOID') return btn('知道了', 'discard');
  const buttons = [];
  if (q.action === 'save' && EDITABLE.includes(q.err.code)) buttons.push(btn('修改', 'editRecord'));
  if (RETRYABLE.includes(q.err.code || 'UNKNOWN')) buttons.push(btn('重試', 'retry'));
  buttons.push(btn('放棄', 'discard'));
  return buttons.join('');
}

function renderList() {
  $('month-label').textContent = state.month.replace('-', ' 年 ') + ' 月';
  const rows = allRecords()
    .filter(r => r.date.startsWith(state.month))
    .sort((a, b) => (b.date + b.updated).localeCompare(a.date + a.updated));
  const count = rows.filter(r => !r.voided).length;
  $('month-summary').textContent = rows.length ? `本月 ${count} 筆` : '';

  $('records').innerHTML = rows.length ? rows.map(r => {
    const q = r.pending;
    const failed = q && q.status === 'failed';
    const badges = [
      failed ? `<span class="badge err">${q.action === 'void' ? '作廢失敗' : '上傳失敗'}</span>` : q ? '<span class="badge warn">上傳中</span>' : '',
      r.voided && !failed ? '<span class="badge grey">已作廢</span>' : '',
      r.reconciled ? '<span class="badge">已對帳</span>' : r.paid ? '<span class="badge">已收款</span>' : '',
      r.attachments.length ? `<span class="badge grey">📎${r.attachments.length}</span>` : '',
    ].join('');
    const failedBlock = failed
      ? `<div class="fail-reason">⚠ ${esc(describeError(q.err, 'queue'))}</div>
         ${SHOW_DETAIL.includes(q.err.code || 'UNKNOWN') && q.err.detail ? `<div class="sub">${esc(q.err.detail)}</div>` : ''}
         <div class="fail-actions">${failureButtons(q, r.record_id)}</div>` : '';
    return `
      <div class="rec ${r.voided && !failed ? 'voided' : ''} ${failed ? 'failed' : ''}" onclick="editRecord('${r.record_id}')">
        <div>
          <div class="main">${esc(r.date.slice(5))}　${esc(r.client)}　${esc(r.type)}${badges}</div>
          ${r.note ? `<div class="sub">${esc(r.note.slice(0, 30))}${r.note.length > 30 ? '……' : ''}</div>` : ''}
          ${failedBlock}
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
// 狀態列：失敗當下就顯示原因，點一下直接處理
// =====================================================================

function renderStatus() {
  const active = queue.filter(q => q.status !== 'failed').length;
  const failed = queue.filter(q => q.status === 'failed');
  if (active) return setStatus(TEXT.uploading(active), 'warn');
  if (failed.length === 1) {
    const q = failed[0];
    const canEdit = q.action === 'save' && EDITABLE.includes(q.err.code);
    return setStatus(`${failurePrefix(q)}${describeError(q.err, 'queue')} — 點這裡${canEdit ? '修改' : '查看'}`, 'err');
  }
  if (failed.length) {
    return setStatus(`${failed.length} 筆未送出（第一筆：${describeError(failed[0].err, 'queue')}）— 點這裡查看`, 'err');
  }
  setStatus(TEXT.allSaved, 'ok', 3000);
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
  if (file.type.startsWith('image/')) {
    let img;
    try {
      img = await createImageBitmap(file);
    } catch (e) {
      throw new Error(FORM.imageUnreadable(file.name));
    }
    const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
    return { name: file.name.replace(/\.\w+$/, '') + '.jpg', mimeType: 'image/jpeg', base64: dataUrl.split(',')[1] };
  }
  if (file.size > MAX_FILE_BYTES) throw new Error(FORM.fileTooLarge(file.name));
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
$('status-bar').addEventListener('click', () => {
  if (!$('status-bar').classList.contains('err')) return;
  const failed = queue.filter(q => q.status === 'failed');
  if (failed.length === 1) return editFailed(failed[0]);
  switchTab('list');
  window.scrollTo(0, 0);
});
// 還有未送出的紀錄時，關閉頁面前提醒（桌機與 Android 有效；iPhone 不保證）
window.addEventListener('beforeunload', e => { if (queue.length) { e.preventDefault(); e.returnValue = ''; } });
window.addEventListener('load', initGsi);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
