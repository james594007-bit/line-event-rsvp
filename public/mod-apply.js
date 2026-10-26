const statusLabel = { pending: '等待開通', approved: '已開通', rejected: '未開通', suspended: '已停用' };
const statusExplain = {
  pending: '申請已送出，等待工具管理者開通。',
  approved: '活動工具已開通，可以前往建立及管理活動。',
  rejected: '這次申請未開通。如有需要，可以重新申請。',
  suspended: '活動工具目前已停用，請聯絡工具管理者。',
};

function show(id, html) { document.getElementById(id).innerHTML = html; }

async function refreshStatus() {
  const res = await fetch('/api/mod/me');
  if (!res.ok) return null;
  const data = await res.json();
  // communityName is a fixed server-side constant and status is a closed
  // enum (DB CHECK constraint), so neither is attacker-controlled today —
  // escaped anyway for consistency with mod.js/owner.js and so this stays
  // safe if either ever starts carrying freer-form data.
  show('communityName', escapeHtml(data.communityName));
  show('statusBox', `<div class="status ${escapeHtml(data.status)}">${escapeHtml(statusLabel[data.status])} — ${escapeHtml(statusExplain[data.status])}</div>`);

  const btn = document.getElementById('actionBtn');
  if (data.status === 'approved') {
    btn.textContent = '前往活動管理工具';
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
