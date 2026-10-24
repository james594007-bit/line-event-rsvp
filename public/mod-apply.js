const statusLabel = { pending: '待審核', approved: '已核准', rejected: '未通過', suspended: '已停權' };
const statusExplain = {
  pending: '申請已送出,等待擁有者審核。',
  approved: '你已經是版主了,前往管理頁面。',
  rejected: '很抱歉,申請未通過。你可以重新申請。',
  suspended: '你的版主權限已被停權,請聯絡擁有者。',
};

function show(id, html) { document.getElementById(id).innerHTML = html; }

async function refreshStatus() {
  const res = await fetch('/api/mod/me');
  if (!res.ok) return null;
  const data = await res.json();
  show('communityName', data.communityName);
  show('statusBox', `<div class="status ${data.status}">${statusLabel[data.status]} — ${statusExplain[data.status]}</div>`);

  const btn = document.getElementById('actionBtn');
  if (data.status === 'approved') {
    btn.textContent = '前往管理頁面';
    btn.onclick = () => { location.href = '/mod'; };
  } else if (data.status === 'rejected') {
    btn.textContent = '重新申請';
    btn.onclick = apply;
  } else if (data.status === 'pending') {
    btn.textContent = '重新整理申請狀態';
    btn.onclick = refreshStatus;
  } else {
    btn.textContent = '聯絡擁有者';
    btn.onclick = null;
  }
  return data;
}

async function apply() {
  const res = await fetch('/api/mod/apply', { method: 'POST' });
  if (res.status === 401) {
    // not verified via LINE yet — send them through login, then back here
    location.href = '/auth/line/start';
    return;
  }
  if (!res.ok) {
    show('statusBox', '<div class="status rejected">申請失敗,請稍後再試</div>');
    return;
  }
  await refreshStatus();
}

(async () => {
  const existing = await refreshStatus();
  if (!existing) {
    document.getElementById('actionBtn').onclick = apply;
  }
})();
