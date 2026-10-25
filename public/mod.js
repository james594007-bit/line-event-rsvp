function getCookie(name) {
  const match = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return match ? decodeURIComponent(match[1]) : null;
}

async function modFetch(url, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.method && options.method !== 'GET') {
    headers.set('X-CSRF-Token', getCookie('csrf_token') || '');
    if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  }
  const res = await fetch(url, { ...options, headers });
  if (res.status === 401) {
    location.href = '/mod-apply';
    throw new Error('unauthorized');
  }
  return res;
}

let editingId = null;

function getFormData() {
  return {
    title: document.getElementById('f_title').value.trim(),
    organizer: document.getElementById('f_organizer').value.trim() || undefined,
    endsAt: document.getElementById('f_endsAt').value,
    activityLocation: document.getElementById('f_activityLocation').value.trim() || undefined,
    meetingLocation: document.getElementById('f_meetingLocation').value.trim() || undefined,
    meetingTime: document.getElementById('f_meetingTime').value.trim() || undefined,
    fee: document.getElementById('f_fee').value.trim() || undefined,
    passengerFee: document.getElementById('f_passengerFee').value.trim() || undefined,
    capacity: document.getElementById('f_capacity').value ? parseInt(document.getElementById('f_capacity').value, 10) : undefined,
    cutoffAt: document.getElementById('f_cutoffAt').value.trim() || undefined,
    groupLink: document.getElementById('f_groupLink').value.trim() || undefined,
    notes: document.getElementById('f_notes').value.trim() || undefined,
    status: document.getElementById('f_status').value,
    enableAttendanceType: document.getElementById('f_enableAttendanceType').checked,
    enableCarRole: document.getElementById('f_enableCarRole').checked,
    enablePlusOne: document.getElementById('f_enablePlusOne').checked,
  };
}

function fillForm(ev) {
  document.getElementById('f_title').value = ev.title ?? '';
  document.getElementById('f_organizer').value = ev.organizer ?? '';
  document.getElementById('f_endsAt').value = ev.ends_at ?? '';
  document.getElementById('f_activityLocation').value = ev.activity_location ?? '';
  document.getElementById('f_meetingLocation').value = ev.meeting_location ?? '';
  document.getElementById('f_meetingTime').value = ev.meeting_time ?? '';
  document.getElementById('f_fee').value = ev.fee ?? '';
  document.getElementById('f_passengerFee').value = ev.passenger_fee ?? '';
  document.getElementById('f_capacity').value = ev.capacity ?? '';
  document.getElementById('f_cutoffAt').value = ev.cutoff_at ?? '';
  document.getElementById('f_groupLink').value = ev.group_link ?? '';
  document.getElementById('f_notes').value = ev.notes ?? '';
  document.getElementById('f_status').value = ev.status ?? 'open';
  document.getElementById('f_enableAttendanceType').checked = !!ev.enable_attendance_type;
  document.getElementById('f_enableCarRole').checked = !!ev.enable_car_role;
  document.getElementById('f_enablePlusOne').checked = !!ev.enable_plus_one;
}

function resetForm() {
  document.getElementById('eventForm').reset();
  editingId = null;
  document.getElementById('formTitle').textContent = '建立新活動';
  document.getElementById('submitBtn').textContent = '建立活動';
  document.getElementById('statusField').style.display = 'none';
  document.getElementById('cancelEditBtn').style.display = 'none';
  document.getElementById('result').style.display = 'none';
}

async function startEdit(id) {
  const res = await modFetch(`/api/mod/events/${id}`);
  const ev = await res.json();
  if (ev.error) { alert('找不到這個活動'); return; }
  editingId = id;
  fillForm(ev);
  document.getElementById('formTitle').textContent = `編輯:${ev.title}`;
  document.getElementById('submitBtn').textContent = '儲存修改';
  document.getElementById('statusField').style.display = 'flex';
  document.getElementById('cancelEditBtn').style.display = 'inline-block';
  showLinks(id);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function showLinks(id) {
  const shareUrl = `${location.origin}/liff?event=${id}`;
  const box = document.getElementById('result');
  box.innerHTML = `報名連結（分享到 LINE 用）:<br /><a href="${shareUrl}" target="_blank">${shareUrl}</a>`;
  box.style.display = 'block';
}

const attendanceLabel = { activity_only: '只參加活動', activity_and_meal: '活動+聚餐', meal_only: '聚餐' };
function rosterEntryTags(r) {
  const tags = [];
  if (r.role === 'driver') tags.push('開車');
  if (r.role === 'passenger') tags.push('共乘');
  if (attendanceLabel[r.attendanceType]) tags.push(attendanceLabel[r.attendanceType]);
  if (r.plusOneCount) tags.push(`+${r.plusOneCount}`);
  return tags;
}

async function loadEventList() {
  const res = await modFetch('/api/mod/events');
  const events = await res.json();
  const ul = document.getElementById('eventList');
  ul.innerHTML = '';
  events.forEach((ev) => {
    const li = document.createElement('li');
    li.dataset.title = ev.title;
    const statusBadge = ev.status === 'closed' ? '<span class="badge">已截止</span>' : '';
    const capLabel = ev.capacity ? `${ev.registered_count}/${ev.capacity}` : `${ev.registered_count}`;
    const headcountExtra = ev.total_headcount !== ev.registered_count ? `(含攜伴共${ev.total_headcount}人)` : '';
    li.innerHTML = `
      <div class="row">
        <div>
          <div>${escapeHtml(ev.title)} ${statusBadge}</div>
          <div class="meta">${escapeHtml(ev.ends_at ?? ev.event_date ?? '')} ${ev.capacity ? `· 上限${ev.capacity}人` : ''} · 截止 ${escapeHtml(ev.cutoff_at ?? '未設定')}</div>
          <div class="headcount">${capLabel} 人報名 ${headcountExtra} · 查看名單 ▾</div>
        </div>
        <div style="display:flex; gap:10px;">
          <a class="edit" href="#" data-id="${ev.id}">編輯</a>
          <a class="delete" href="#" data-id="${ev.id}">刪除</a>
        </div>
      </div>
      <div class="roster-box">
        <div class="roster-summary"></div>
        <ul class="roster-registered"></ul>
        <div class="roster-cancelled"></div>
        <div style="display:flex; gap:8px; margin-top:8px;">
          <button type="button" class="secondary copy-roster">複製名單文字</button>
          <button type="button" class="secondary export-csv">匯出CSV(可開Google試算表)</button>
        </div>
      </div>
    `;
    li.querySelector('a.edit').onclick = (e) => { e.preventDefault(); startEdit(ev.id); };
    li.querySelector('a.delete').onclick = (e) => { e.preventDefault(); deleteEvent(ev.id, ev.title); };
    li.querySelector('.headcount').onclick = () => toggleRoster(ev.id, li);
    ul.appendChild(li);
  });
}

async function toggleRoster(id, li) {
  const box = li.querySelector('.roster-box');
  if (box.style.display === 'block') { box.style.display = 'none'; return; }
  const res = await modFetch(`/api/mod/events/${id}/roster`);
  const data = await res.json();

  const summaryParts = [];
  if (data.driverCount || data.passengerCount) summaryParts.push(`開車 ${data.driverCount} · 共乘 ${data.passengerCount}`);
  if (data.activityOnlyCount || data.activityAndMealCount || data.mealOnlyCount) {
    summaryParts.push(`只活動 ${data.activityOnlyCount} · 活動+聚餐 ${data.activityAndMealCount} · 只聚餐 ${data.mealOnlyCount}`);
  }
  if (data.totalHeadcount !== data.registeredCount) summaryParts.push(`含攜伴共 ${data.totalHeadcount} 人`);
  summaryParts.push(`已取消 ${data.cancelledCount} 人`);
  box.querySelector('.roster-summary').innerHTML = summaryParts.map((s) => `<div class="meta">${s}</div>`).join('');

  const listEl = box.querySelector('.roster-registered');
  listEl.innerHTML = data.roster.length
    ? data.roster
        .map((r) => `<li>${escapeHtml(r.displayName ?? '(隱藏姓名)')} ${rosterEntryTags(r).map((t) => `<span class="tag">${t}</span>`).join('')}</li>`)
        .join('')
    : '<li style="color:#aaa">還沒有人報名</li>';

  const cancelledEl = box.querySelector('.roster-cancelled');
  cancelledEl.innerHTML = data.cancelledRoster.length
    ? `<div class="meta" style="margin-top:6px;">已取消:${data.cancelledRoster.map((r) => escapeHtml(r.displayName ?? '(隱藏姓名)')).join('、')}</div>`
    : '';

  box.querySelector('.copy-roster').onclick = () => {
    const lines = [
      li.dataset.title,
      `報名 ${data.registeredCount} 人`,
      ...summaryParts.filter((s) => !s.startsWith('已取消')),
      '',
      ...data.roster.map((r, i) => `${i + 1}. ${r.displayName ?? '(隱藏姓名)'} ${rosterEntryTags(r).join(' ')}`.trim()),
      '',
      `已取消 ${data.cancelledCount} 人${data.cancelledRoster.length ? `:${data.cancelledRoster.map((r) => r.displayName ?? '(隱藏姓名)').join('、')}` : ''}`,
    ].filter((line) => line !== null && line !== undefined);
    navigator.clipboard.writeText(lines.join('\n')).then(() => alert('已複製名單'), () => alert('複製失敗,請手動選取'));
  };

  box.querySelector('.export-csv').onclick = () => {
    const csvField = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const rows = [['姓名', '開車/共乘', '參加類型', '攜伴人數', '狀態']];
    data.roster.forEach((r) => rows.push([r.displayName ?? '(隱藏姓名)', r.role === 'driver' ? '開車' : r.role === 'passenger' ? '共乘' : '', attendanceLabel[r.attendanceType] ?? '', r.plusOneCount || 0, '已報名']));
    data.cancelledRoster.forEach((r) => rows.push([r.displayName ?? '(隱藏姓名)', '', '', '', '已取消']));
    const csv = '﻿' + rows.map((row) => row.map(csvField).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${li.dataset.title}-報名名單.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  box.style.display = 'block';
}

async function deleteEvent(id, title) {
  if (!confirm(`確定要刪除「${title}」?已經報名的人數跟名單會一起被清掉,刪了就回不來了。`)) return;
  const res = await modFetch(`/api/mod/events/${id}`, { method: 'DELETE' });
  if (!res.ok) { alert('刪除失敗'); return; }
  if (editingId === id) resetForm();
  await loadEventList();
}

async function init() {
  const meRes = await fetch('/api/mod/me');
  if (!meRes.ok) { location.href = '/mod-apply'; return; }
  const me = await meRes.json();
  if (me.status !== 'approved') {
    document.getElementById('blocked').style.display = 'block';
    document.getElementById('blocked').textContent = `目前狀態:${me.status},還不能使用版主後台,請到申請頁查看。`;
    return;
  }

  document.getElementById('dashboard').style.display = 'block';
  await loadEventList();

  document.getElementById('eventForm').onsubmit = async (e) => {
    e.preventDefault();
    const data = getFormData();
    if (!data.title || !data.endsAt) return;
    const url = editingId ? `/api/mod/events/${editingId}` : '/api/mod/events';
    const method = editingId ? 'PUT' : 'POST';
    const res = await modFetch(url, { method, body: JSON.stringify(data) });
    const result = await res.json();
    if (!res.ok) { alert('儲存失敗: ' + (result.error ?? '')); return; }
    const id = editingId ?? result.id;
    showLinks(id);
    await loadEventList();
  };
  document.getElementById('cancelEditBtn').onclick = resetForm;
  document.getElementById('logoutBtn').onclick = async () => {
    await modFetch('/auth/logout', { method: 'POST' });
    location.href = '/mod-apply';
  };
}

init();
