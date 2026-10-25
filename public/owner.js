function getCookie(name) {
  const match = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return match ? decodeURIComponent(match[1]) : null;
}

async function ownerFetch(url, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.method && options.method !== 'GET') {
    headers.set('X-CSRF-Token', getCookie('csrf_token') || '');
    if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  }
  const res = await fetch(url, { ...options, headers });
  if (res.status === 401) { location.href = '/mod-apply'; throw new Error('unauthorized'); }
  return res;
}

function row(mod, actionsHtml) {
  const label = mod.pending_display_name ? `${escapeHtml(mod.pending_display_name)}(${mod.id})` : mod.id;
  return `<div class="row-item">
    <div>
      <div>${label} ${mod.role === 'owner' ? '<span class="meta">擁有者</span>' : ''}</div>
      <div class="meta">申請於 ${mod.applied_at}${mod.decided_at ? ` · 決定於 ${mod.decided_at}` : ''}</div>
    </div>
    <div class="actions">${actionsHtml}</div>
  </div>`;
}

async function decide(id, action, extraBody) {
  const res = await ownerFetch(`/api/owner/moderators/${id}/${action}`, { method: 'POST', body: extraBody ? JSON.stringify(extraBody) : undefined });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    alert('操作失敗: ' + (err.error ?? res.status));
    return;
  }
  await loadAll();
}

async function loadAll() {
  const res = await ownerFetch('/api/owner/moderators');
  const all = await res.json();

  const pending = all.filter((m) => m.status === 'pending');
  const approved = all.filter((m) => m.status === 'approved');
  const suspended = all.filter((m) => m.status === 'suspended');
  const rejected = all.filter((m) => m.status === 'rejected');

  document.getElementById('pendingList').innerHTML = pending.length
    ? pending.map((m) => row(m, `<button class="approve" data-id="${m.id}" data-action="approve">核准</button><button class="reject" data-id="${m.id}" data-action="reject">拒絕</button>`)).join('')
    : '<div class="empty">目前沒有待審核的申請</div>';

  document.getElementById('approvedList').innerHTML = approved.length
    ? approved.map((m) => row(m, `<button class="suspend" data-id="${m.id}" data-action="suspend">停權</button>`)).join('')
    : '<div class="empty">目前沒有已核准的版主</div>';

  document.getElementById('suspendedList').innerHTML = suspended.length
    ? suspended.map((m) => row(m, `<button class="restore" data-id="${m.id}" data-action="restore">恢復</button>`)).join('')
    : '<div class="empty">目前沒有被停權的版主</div>';

  document.getElementById('rejectedList').innerHTML = rejected.length
    ? rejected.map((m) => row(m, '')).join('')
    : '<div class="empty">目前沒有被拒絕的申請</div>';

  document.querySelectorAll('button[data-action]').forEach((btn) => {
    btn.onclick = () => {
      const { id, action } = btn.dataset;
      if (action === 'suspend') {
        const reason = prompt('停權原因(只有你看得到,選填):') ?? '';
        decide(id, 'suspend', { reason });
      } else if (action === 'reject' && !confirm('確定要拒絕這個申請?')) {
        return;
      } else {
        decide(id, action);
      }
    };
  });
}

async function init() {
  const meRes = await fetch('/api/mod/me');
  if (!meRes.ok) { location.href = '/mod-apply'; return; }
  const me = await meRes.json();
  if (me.role !== 'owner') {
    document.getElementById('blocked').style.display = 'block';
    document.getElementById('blocked').textContent = '你不是擁有者,無法使用這個頁面。';
    return;
  }
  document.getElementById('dashboard').style.display = 'block';
  await loadAll();
  document.getElementById('logoutBtn').onclick = async () => {
    await ownerFetch('/auth/logout', { method: 'POST' });
    location.href = '/mod-apply';
  };
}

init();
