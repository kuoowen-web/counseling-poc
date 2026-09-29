const { CLIENT_ID, API_URL } = window.APP_CONFIG;
const TOKEN_KEY = 'poc_id_token';
const $ = id => document.getElementById(id);
let records = [];

// ---------- 登入 ----------

function initGsi() {
  google.accounts.id.initialize({ client_id: CLIENT_ID, callback: onCredential, auto_select: true });
  const saved = loadToken();
  if (saved) return startApp(saved);
  google.accounts.id.renderButton($('gsi-button'), { theme: 'filled_blue', size: 'large', text: 'signin_with' });
  google.accounts.id.prompt();
}

function onCredential(resp) {
  // PoC：存在 localStorage 以測試「重開 App 不用重新登入」；正式版要改成後端核發的 session
  localStorage.setItem(TOKEN_KEY, resp.credential);
  startApp(resp.credential);
}

function loadToken() {
  const t = localStorage.getItem(TOKEN_KEY);
  if (!t) return null;
  const payload = JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
  return payload.exp * 1000 > Date.now() + 60000 ? t : null;
}

function signOut() {
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
  if (!json.ok) {
    if (/登入|憑證/.test(json.error)) localStorage.removeItem(TOKEN_KEY);
    throw new Error(json.error);
  }
  return json.data;
}

// ---------- 畫面 ----------

async function startApp() {
  $('login-box').classList.add('hidden');
  try {
    const me = await api('whoami');
    $('who').innerHTML = `${escapeHtml(me.name || me.email)} <button class="secondary" onclick="signOut()">登出</button>`;
    $('app').classList.remove('hidden');
    resetForm();
    records = await api('list');
    renderList();
  } catch (err) {
    $('login-box').classList.remove('hidden');
    $('login-box').insertAdjacentHTML('beforeend', `<p style="color:#b00">${err.message}</p>`);
    google.accounts.id.renderButton($('gsi-button'), { theme: 'filled_blue', size: 'large' });
  }
}

function today() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

function resetForm() {
  $('form-title').textContent = '新增一筆';
  $('record_id').value = '';
  $('service_date').value = today();
  $('client_code').value = '';
  $('amount').value = '';
  $('note').value = '';
  $('file').value = '';
  $('status').textContent = '';
}

function renderList() {
  const sorted = [...records].sort((a, b) => String(b.service_date).localeCompare(String(a.service_date)));
  $('list').innerHTML = sorted.length ? sorted.map(r => `
    <div class="rec">
      <div>${r.service_date}｜${escapeHtml(r.client_code)}｜$${r.amount}<br>
        <small>${escapeHtml(String(r.note).slice(0, 40))}${r.file_ids ? '｜📎 已附檔' : ''}</small></div>
      <button class="secondary" onclick="editRecord('${r.record_id}')">修改</button>
    </div>`).join('') : '<p>還沒有紀錄。</p>';
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
  $('status').textContent = r.file_ids ? '已有附件；選新檔案會取代舊的。' : '';
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function save() {
  const btn = $('save');
  btn.disabled = true;
  try {
    const payload = {
      record_id: $('record_id').value || undefined,
      service_date: $('service_date').value,
      client_code: $('client_code').value.trim(),
      amount: $('amount').value,
      note: $('note').value,
    };
    const f = $('file').files[0];
    if (f) {
      $('status').textContent = '上傳附件中…';
      const up = await api('upload', await fileToPayload(f));
      payload.file_ids = up.file_id;
    }
    $('status').textContent = '儲存中…';
    await api('save', payload);
    records = await api('list');
    renderList();
    resetForm();
    $('status').textContent = '已儲存 ✓';
  } catch (err) {
    $('status').textContent = '失敗：' + err.message;
  } finally {
    btn.disabled = false;
  }
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
window.addEventListener('load', initGsi);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
