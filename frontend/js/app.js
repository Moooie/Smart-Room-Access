// ==========================================================
// Smart Scheduled Room Access System
// Frontend Client Application (Layer 4: Web Dashboard)
// Vanilla JavaScript (ES6+), WebSocket, REST API Client
// ==========================================================

const API_BASE = window.location.origin;
let ws = null;
let currentUser = null;
let currentToken = localStorage.getItem('token') || null;

let currentRooms = [];
let pendingUnlockRoomCode = null;
let unlockCountdownTimer = null;
let currentLogPage = 1;

// ==========================================================
// INITIALIZATION
// ==========================================================
document.addEventListener('DOMContentLoaded', async () => {
  // Set default filter date to today for convenience
  const today = new Date().toISOString().slice(0, 10);
  const schedDateInput = document.getElementById('schedDate');
  if (schedDateInput) schedDateInput.value = today;

  await checkAuth();
  initWebSocket();
  loadStats();
  loadRoomsData();
  loadLiveLogFeed();

  // Listener input auto-formatting ala Windows Product Key
  const rfidInputEl = document.getElementById('userFormRfid');
  if (rfidInputEl) {
    rfidInputEl.addEventListener('input', (e) => {
      const start = e.target.selectionStart;
      const prevLen = e.target.value.length;
      e.target.value = formatRfidInput(e.target.value);
      const newLen = e.target.value.length;
      e.target.selectionStart = e.target.selectionEnd = Math.max(0, start + (newLen - prevLen));
      updateRfidInputFeedback();
    });
  }
});

// ==========================================================
// TOAST NOTIFICATIONS
// ==========================================================
function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  if (!container) return;

  const toast = document.createElement('div');
  const colors = {
    success: 'bg-emerald-600 text-white border-emerald-700',
    error: 'bg-rose-600 text-white border-rose-700',
    warning: 'bg-amber-500 text-white border-amber-600',
    info: 'bg-indigo-600 text-white border-indigo-700'
  };
  const icons = {
    success: 'fa-circle-check',
    error: 'fa-circle-exclamation',
    warning: 'fa-triangle-exclamation',
    info: 'fa-circle-info'
  };

  toast.className = `pointer-events-auto flex items-center space-x-3 px-4 py-3 rounded-xl shadow-xl text-xs font-semibold border toast-enter ${colors[type] || colors.info}`;
  toast.innerHTML = `
    <i class="fa-solid ${icons[type] || icons.info} text-base"></i>
    <span class="flex-1">${message}</span>
    <button onclick="this.parentElement.remove()" class="text-white/80 hover:text-white ml-2">
      <i class="fa-solid fa-xmark"></i>
    </button>
  `;

  container.appendChild(toast);
  setTimeout(() => toast.classList.add('toast-enter-active'), 10);

  setTimeout(() => {
    toast.classList.remove('toast-enter-active');
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

// ==========================================================
// WEBSOCKET REAL-TIME CLIENT
// ==========================================================
function initWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}`;

  const dot = document.getElementById('wsStatusDot');
  const text = document.getElementById('wsStatusText');

  try {
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      console.log('[WS] Terhubung ke real-time gateway');
      if (dot) dot.className = 'w-2 h-2 rounded-full bg-emerald-500 animate-pulse';
      if (text) text.textContent = 'Terhubung (Real-time)';
    };

    ws.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        handleWsMessage(payload);
      } catch (e) {
        console.error('[WS] Parse message error:', e);
      }
    };

    ws.onclose = () => {
      console.warn('[WS] Sambungan terputus. Mencoba reconnect...');
      if (dot) dot.className = 'w-2 h-2 rounded-full bg-rose-500';
      if (text) text.textContent = 'Terputus. Menghubungkan ulang...';
      setTimeout(initWebSocket, 3000);
    };

    ws.onerror = (err) => {
      console.error('[WS] Error:', err);
      ws.close();
    };
  } catch (err) {
    console.error('[WS] Inisialisasi gagal:', err);
    setTimeout(initWebSocket, 5000);
  }
}

function handleWsMessage({ type, data }) {
  console.log('[WS Event]', type, data);

  switch (type) {
    case 'DEVICE_STATUS':
      // Update status online/offline ruangan
      updateRoomDeviceStatus(data.room, data.status);
      showToast(`ESP32 Ruang ${data.room} sekarang: ${data.status.toUpperCase()}`, data.status === 'online' ? 'info' : 'warning');
      break;

    case 'DOOR_STATUS':
      // Update status pintu locked/unlocked + refresh tombol aksi per ruangan
      updateRoomDoorStatus(data.room, data.status, data.duration);
      loadRoomsData();
      if (data.status === 'unlocked') {
        const durText = data.duration === 0
          ? 'Mode Bebas Admin'
          : (data.duration > 60000 ? 'Sesuai Jadwal Aktif' : `${Math.ceil((data.duration || 4000) / 1000)} detik`);
        showToast(`🔓 Pintu Ruang ${data.room} TERBUKA (${durText})`, 'success');
      } else {
        showToast(`🔒 Pintu Ruang ${data.room} TERKUNCI kembali`, 'info');
      }
      break;

    case 'ACCESS_LOG':
      // Tambahkan baris baru ke Live Feed Access Log di halaman Monitoring
      prependLiveLog(data);
      // Jika tab saat ini adalah logs, perbarui tabel riwayat jika di halaman 1
      if (currentActiveTab === 'logs' && currentLogPage === 1) {
        loadLogsData(1, false);
      }
      break;

    case 'ROOM_HOURS_UPDATED':
      showToast(`Jam operasional ${data.nama_ruangan} diperbarui: ${data.jam_buka} - ${data.jam_tutup} WIB`, 'info');
      loadRoomsData();
      break;

    case 'SCHEDULE_UPDATE':
      // Perbarui jadwal jika sedang di tab jadwal
      if (currentActiveTab === 'schedules') {
        loadSchedulesData();
      }
      loadRoomsData(); // Perbarui info active_schedule pada kartu ruangan
      break;

    case 'STATS_UPDATE':
      renderStats(data);
      break;
  }
}

// ==========================================================
// HTTP API HELPER
// ==========================================================
async function apiFetch(endpoint, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {})
  };

  if (currentToken) {
    headers['Authorization'] = `Bearer ${currentToken}`;
  }

  try {
    const response = await fetch(`${API_BASE}${endpoint}`, {
      ...options,
      headers
    });

    const data = await response.json().catch(() => ({}));

    if (response.status === 401 && currentToken) {
      // Sesi login habis
      logout();
      showToast('Sesi Anda telah berakhir. Silakan login kembali.', 'warning');
      throw new Error('Sesi kedaluwarsa');
    }

    if (!response.ok) {
      throw new Error(data.message || data.error || `HTTP ${response.status}`);
    }

    return data;
  } catch (error) {
    throw error;
  }
}

// ==========================================================
// AUTHENTICATION LOGIC
// ==========================================================
async function checkAuth() {
  if (!currentToken) {
    updateAuthUI(null);
    return;
  }

  try {
    const res = await apiFetch('/api/auth/me');
    currentUser = res.user;
    updateAuthUI(currentUser);
  } catch (e) {
    currentUser = null;
    currentToken = null;
    localStorage.removeItem('token');
    updateAuthUI(null);
  }
}

function updateAuthUI(user) {
  const unauth = document.getElementById('unauthSection');
  const auth = document.getElementById('authSection');
  const nameEl = document.getElementById('userFullName');
  const roleBadge = document.getElementById('userRoleBadge');
  const nimNipEl = document.getElementById('userNimNip');
  const adminBadgeTag = document.getElementById('adminBadgeTag');
  const navUsers = document.getElementById('nav-users');
  const mobileNavUsers = document.getElementById('mobileNavUsers');
  const btnSyncEsp = document.getElementById('btnSyncEsp');

  if (user) {
    unauth.classList.add('hidden');
    auth.classList.remove('hidden');
    if (nameEl) nameEl.textContent = user.nama_lengkap;
    if (nimNipEl) nimNipEl.textContent = user.nim_nip;

    if (roleBadge) {
      roleBadge.textContent = user.role.toUpperCase();
      if (user.role === 'admin') {
        roleBadge.className = 'text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-blue-100 text-blue-800';
      } else if (user.role === 'dosen') {
        roleBadge.className = 'text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-purple-100 text-purple-800';
      } else {
        roleBadge.className = 'text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800';
      }
    }

    // Tampilkan fitur admin jika role admin
    if (user.role === 'admin') {
      if (adminBadgeTag) adminBadgeTag.classList.remove('hidden');
      if (navUsers) navUsers.classList.remove('hidden');
      if (mobileNavUsers) mobileNavUsers.classList.remove('hidden');
      if (btnSyncEsp) btnSyncEsp.classList.remove('hidden');
    } else {
      if (adminBadgeTag) adminBadgeTag.classList.add('hidden');
      // Sembunyikan tab pengguna untuk non-admin
      if (navUsers) navUsers.classList.add('hidden');
      if (mobileNavUsers) mobileNavUsers.classList.add('hidden');
      if (btnSyncEsp) btnSyncEsp.classList.add('hidden');
    }
  } else {
    unauth.classList.remove('hidden');
    auth.classList.add('hidden');
    if (adminBadgeTag) adminBadgeTag.classList.add('hidden');
    if (navUsers) navUsers.classList.add('hidden');
    if (mobileNavUsers) mobileNavUsers.classList.add('hidden');
    if (btnSyncEsp) btnSyncEsp.classList.add('hidden');
  }

  // Render ulang kartu ruangan untuk memperbarui status izin remote unlock
  renderRooms();
}

async function handleLoginSubmit(e) {
  e.preventDefault();
  const identifier = document.getElementById('loginIdentifier').value.trim();
  const password = document.getElementById('loginPassword').value.trim();
  const btn = document.getElementById('btnLoginSubmit');

  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin mr-2"></i> Memproses...';

  try {
    const res = await apiFetch('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ identifier, password })
    });

    currentToken = res.token;
    currentUser = res.user;
    localStorage.setItem('token', currentToken);
    updateAuthUI(currentUser);
    closeLoginModal();
    showToast(`Selamat datang kembali, ${currentUser.nama_lengkap}!`, 'success');
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = 'Masuk Sekarang';
  }
}

async function handleRegisterSubmit(e) {
  e.preventDefault();
  const nim_nip = document.getElementById('regNimNip').value.trim();
  const nama_lengkap = document.getElementById('regNamaLengkap').value.trim();
  const email = document.getElementById('regEmail').value.trim();
  const role = document.getElementById('regRole').value;
  const password = document.getElementById('regPassword').value.trim();
  const btn = document.getElementById('btnRegSubmit');

  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin mr-2"></i> Mendaftarkan...';

  try {
    const res = await apiFetch('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ nim_nip, nama_lengkap, email, role, password })
    });

    currentToken = res.token;
    currentUser = res.user;
    localStorage.setItem('token', currentToken);
    updateAuthUI(currentUser);
    closeRegisterModal();
    showToast('Pendaftaran berhasil! Anda telah masuk.', 'success');
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = 'Daftar Sekarang';
  }
}

function logout() {
  currentUser = null;
  currentToken = null;
  localStorage.removeItem('token');
  updateAuthUI(null);
  showToast('Anda telah keluar dari akun.', 'info');
  if (currentActiveTab === 'users') {
    switchTab('rooms');
  }
}

// ==========================================================
// NAVIGATION TABS
// ==========================================================
let currentActiveTab = 'rooms';

function switchTab(tabId) {
  if (tabId === 'users' && (!currentUser || currentUser.role !== 'admin')) {
    showToast('Akses terbatas. Tab ini hanya untuk Administrator.', 'warning');
    return;
  }

  currentActiveTab = tabId;

  // Toggle active class on tab buttons
  document.querySelectorAll('.nav-tab').forEach(tab => {
    tab.className = 'nav-tab px-3.5 py-2 text-sm font-medium rounded-lg text-slate-600 hover:text-slate-900 hover:bg-slate-100 flex items-center space-x-2 transition';
  });

  const activeBtn = document.getElementById(`nav-${tabId}`);
  if (activeBtn) {
    activeBtn.className = 'nav-tab px-3.5 py-2 text-sm font-medium rounded-lg text-indigo-600 bg-indigo-50 flex items-center space-x-2 transition font-semibold';
  }

  // Hide all sections, show active
  document.querySelectorAll('.tab-pane').forEach(pane => pane.classList.add('hidden'));
  const activePane = document.getElementById(`tab-${tabId}`);
  if (activePane) activePane.classList.remove('hidden');

  // Trigger data loaders
  if (tabId === 'rooms') loadRoomsData();
  else if (tabId === 'schedules') loadSchedulesData();
  else if (tabId === 'users') loadUsersData();
  else if (tabId === 'logs') loadLogsData(1);
}

// ==========================================================
// TAB 1: MONITORING RUANGAN & LIVE CONTROL
// ==========================================================
async function loadStats() {
  try {
    const data = await apiFetch('/api/stats');
    renderStats(data);
  } catch (e) {
    console.error('Gagal memuat stats:', e);
  }
}

function renderStats(s) {
  if (!s) return;
  const setTxt = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  setTxt('statTotalAkses', s.totalAksesHariIni ?? 0);
  setTxt('statGranted', s.aksesGrantedHariIni ?? 0);
  setTxt('statDenied', s.aksesDeniedHariIni ?? 0);
  const isOnline = (s.perangkatOnline ?? 0) > 0;
  setTxt('statOnlineDevices', isOnline ? '1 / 1 Online' : '0 / 1 Offline');
}

async function loadRoomsData() {
  try {
    const res = await apiFetch('/api/rooms');
    currentRooms = res.rooms || [];
    populateRoomDropdowns(currentRooms);
    renderRooms();
  } catch (err) {
    console.error('Gagal mengambil data rooms:', err);
  }
}

function populateRoomDropdowns(rooms) {
  if (!rooms || rooms.length === 0) return;

  const schedSelect = document.getElementById('schedRoomId');
  if (schedSelect) {
    const currentVal = schedSelect.value;
    schedSelect.innerHTML = rooms.map(r => 
      `<option value="${r.id_room}">${r.nama_ruangan} (${r.device_id})</option>`
    ).join('');
    if (currentVal && rooms.some(r => String(r.id_room) === String(currentVal))) {
      schedSelect.value = currentVal;
    }
  }

  const filterSched = document.getElementById('filterSchedRoom');
  if (filterSched) {
    const cur = filterSched.value;
    filterSched.innerHTML = '<option value="">Semua Ruangan</option>' + rooms.map(r =>
      `<option value="${r.kode_ruangan}">${r.nama_ruangan}</option>`
    ).join('');
    if (cur) filterSched.value = cur;
  }

  const filterLog = document.getElementById('filterLogRoom');
  if (filterLog) {
    const cur = filterLog.value;
    filterLog.innerHTML = '<option value="">Semua Ruangan</option>' + rooms.map(r =>
      `<option value="${r.kode_ruangan}">${r.nama_ruangan}</option>`
    ).join('');
    if (cur) filterLog.value = cur;
  }
}

function renderRooms() {
  const container = document.getElementById('roomsContainer');
  if (!container) return;

  if (currentRooms.length === 0) {
    container.className = "w-full";
    container.innerHTML = '<div class="text-center py-12 text-slate-400">Tidak ada data ruangan</div>';
    return;
  }

  // Atur layout otomatis: jika 1 ruangan buat terpusat dan elegan
  if (currentRooms.length === 1) {
    container.className = "max-w-2xl mx-auto w-full";
  } else {
    container.className = "grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6";
  }

  const roomThemes = {
    MERAH: {
      border: 'card-merah',
      badge: 'bg-rose-100 text-rose-800 border-rose-200',
      btn: 'bg-rose-600 hover:bg-rose-700 shadow-rose-200',
      accentBg: 'bg-rose-50/50',
      titleColor: 'text-rose-900',
      iconColor: 'text-rose-500'
    },
    KUNING: {
      border: 'card-kuning',
      badge: 'bg-amber-100 text-amber-800 border-amber-200',
      btn: 'bg-amber-600 hover:bg-amber-700 shadow-amber-200',
      accentBg: 'bg-amber-50/50',
      titleColor: 'text-amber-900',
      iconColor: 'text-amber-500'
    },
    HIJAU: {
      border: 'card-hijau',
      badge: 'bg-emerald-100 text-emerald-800 border-emerald-200',
      btn: 'bg-emerald-600 hover:bg-emerald-700 shadow-emerald-200',
      accentBg: 'bg-emerald-50/50',
      titleColor: 'text-emerald-900',
      iconColor: 'text-emerald-500'
    }
  };

  container.innerHTML = currentRooms.map(r => {
    const theme = roomThemes[r.kode_ruangan] || roomThemes.MERAH;
    const isOnline = r.status_device === 'online';
    const isUnlocked = r.status_pintu === 'unlocked';

    // Periksa apakah user yang sedang login diizinkan membuka pintu:
    // Admin: selalu boleh.
    // Mahasiswa / Dosen: hanya jika memiliki jadwal aktif saat ini.
    let canUnlock = false;
    let unlockTooltip = 'Masuk untuk membuka pintu';

    if (!currentUser) {
      canUnlock = false;
      unlockTooltip = 'Silakan login terlebih dahulu';
    } else if (currentUser.role === 'admin') {
      canUnlock = true;
      unlockTooltip = 'Hak Akses Administrator';
    } else if (r.active_schedule && r.active_schedule.user.id_user === currentUser.id_user) {
      canUnlock = true;
      unlockTooltip = 'Jadwal Anda aktif saat ini';
    } else {
      canUnlock = false;
      unlockTooltip = 'Hanya pemilik jadwal aktif atau Admin yang dapat membuka';
    }

    // Status Door Lock Badge
    const doorBadge = isUnlocked
      ? `<span class="inline-flex items-center space-x-1.5 px-3 py-1 rounded-full text-xs font-bold bg-emerald-100 text-emerald-800 border border-emerald-200 glow-unlocked">
          <i class="fa-solid fa-lock-open text-emerald-600"></i>
          <span>TERBUKA (UNLOCKED)</span>
         </span>`
      : `<span class="inline-flex items-center space-x-1.5 px-3 py-1 rounded-full text-xs font-bold bg-slate-100 text-slate-700 border border-slate-200">
          <i class="fa-solid fa-lock text-slate-500"></i>
          <span>TERKUNCI (LOCKED)</span>
         </span>`;

    // Active Schedule Box
    const schedInfo = r.active_schedule
      ? `<div class="bg-white p-3.5 rounded-xl border border-slate-200 text-xs space-y-1.5">
          <div class="flex items-center justify-between text-slate-500">
            <span class="font-semibold text-slate-700"><i class="fa-regular fa-clock mr-1 text-indigo-500"></i> ${r.active_schedule.jam_mulai} - ${r.active_schedule.jam_selesai} WIB</span>
            <span class="text-[10px] font-bold uppercase tracking-wider bg-indigo-50 text-indigo-700 px-2 py-0.5 rounded-full">Sedang Berjalan</span>
          </div>
          <div class="font-bold text-slate-900">${r.active_schedule.user.nama_lengkap} <span class="font-normal text-slate-500">(${r.active_schedule.user.nim_nip})</span></div>
          <div class="text-slate-600 italic text-[11px] truncate">"${r.active_schedule.keperluan}"</div>
         </div>`
      : `<div class="bg-white p-3.5 rounded-xl border border-slate-100 text-center text-xs text-slate-400 py-5">
          <i class="fa-regular fa-calendar-xmark text-lg mb-1 block text-slate-300"></i>
          Tidak ada jadwal aktif saat ini (Ruangan Kosong)
         </div>`;

    return `
      <div id="roomCard-${r.kode_ruangan}" class="bg-white rounded-2xl border border-slate-200 shadow-sm hover:shadow-md transition duration-200 overflow-hidden flex flex-col ${theme.border}">
        
        <!-- Header -->
        <div class="p-5 border-b border-slate-100 flex items-center justify-between">
          <div>
            <div class="flex items-center space-x-2">
              <h2 class="text-lg font-bold ${theme.titleColor}">${r.nama_ruangan}</h2>
              <span class="text-[10px] font-bold tracking-wider px-2 py-0.5 rounded-md border ${theme.badge}">${r.kode_ruangan}</span>
            </div>
            <div class="text-xs text-slate-400 font-mono mt-0.5">Device ID: ${r.device_id}</div>
          </div>
          <!-- Online / Offline Badge -->
          <div id="roomDeviceBadge-${r.kode_ruangan}">
            ${isOnline
              ? '<span class="inline-flex items-center space-x-1.5 text-xs font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200 px-2.5 py-1 rounded-full"><span class="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span><span>Online</span></span>'
              : '<span class="inline-flex items-center space-x-1.5 text-xs font-semibold text-slate-500 bg-slate-100 border border-slate-200 px-2.5 py-1 rounded-full"><span class="w-2 h-2 rounded-full bg-slate-400"></span><span>Offline</span></span>'
            }
          </div>
        </div>

        <!-- Body -->
        <div class="p-5 space-y-4 flex-1 ${theme.accentBg}">
          
          <!-- Jam Akses Operasional Ruangan -->
          <div class="flex items-center justify-between bg-white p-3 rounded-xl border border-slate-200 text-xs">
            <div class="flex items-center space-x-2 text-slate-700">
              <i class="fa-regular fa-clock text-indigo-500"></i>
              <span>Jam Akses: <strong class="text-slate-900">${r.jam_buka || '07:00'} - ${r.jam_tutup || '21:00'} WIB</strong></span>
            </div>
            ${currentUser && currentUser.role === 'admin' ? `
              <button onclick='openRoomHoursModal(${JSON.stringify(r)})' class="text-[11px] font-bold text-indigo-600 hover:text-indigo-800 bg-indigo-50 hover:bg-indigo-100 px-2.5 py-1 rounded-lg border border-indigo-200 transition flex items-center space-x-1" title="Ubah jam operasional">
                <i class="fa-solid fa-pen-to-square"></i>
                <span>Ubah</span>
              </button>
            ` : ''}
          </div>

          <!-- Solenoid Status Widget -->
          <div class="flex items-center justify-between bg-white p-3.5 rounded-xl border border-slate-200">
            <span class="text-xs font-bold text-slate-600">Status Solenoid Pintu:</span>
            <div id="roomDoorBadge-${r.kode_ruangan}">${doorBadge}</div>
          </div>

          <!-- Schedule Occupant Info -->
          <div>
            <div class="text-xs font-bold text-slate-700 uppercase tracking-wider mb-2">Penggunaan Ruangan:</div>
            ${schedInfo}
          </div>

        </div>

        <!-- Footer / Remote Action -->
        <div class="p-5 border-t border-slate-100 bg-white">
          ${(r.status_pintu === 'unlocked' && currentUser && currentUser.role === 'admin') ? `
          <button 
            onclick="executeRemoteLock('${r.kode_ruangan}')" 
            id="btnLock-${r.kode_ruangan}"
            class="w-full py-2.5 px-4 text-xs font-bold text-white rounded-xl shadow-md transition flex items-center justify-center space-x-2 bg-slate-800 hover:bg-slate-900">
            <i class="fa-solid fa-lock"></i>
            <span>Kunci Pintu (Remote Lock)</span>
          </button>
          ` : `
          <button 
            onclick="confirmUnlockRoom('${r.kode_ruangan}', '${r.nama_ruangan}')" 
            ${!canUnlock ? 'disabled' : ''}
            title="${unlockTooltip}"
            id="btnUnlock-${r.kode_ruangan}"
            class="w-full py-2.5 px-4 text-xs font-bold text-white rounded-xl shadow-md transition flex items-center justify-center space-x-2 ${canUnlock ? theme.btn : 'bg-slate-300 text-slate-500 cursor-not-allowed shadow-none'}">
            <i class="fa-solid fa-lock-open"></i>
            <span>Buka Pintu (Remote Unlock)</span>
          </button>
          `}
          <div class="text-[11px] text-center text-slate-400 mt-2">
            ${unlockTooltip}
          </div>
        </div>

      </div>
    `;
  }).join('');
}

function updateRoomDeviceStatus(kode, status) {
  const badgeEl = document.getElementById(`roomDeviceBadge-${kode}`);
  if (badgeEl) {
    badgeEl.innerHTML = status === 'online'
      ? '<span class="inline-flex items-center space-x-1.5 text-xs font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200 px-2.5 py-1 rounded-full"><span class="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span><span>Online</span></span>'
      : '<span class="inline-flex items-center space-x-1.5 text-xs font-semibold text-slate-500 bg-slate-100 border border-slate-200 px-2.5 py-1 rounded-full"><span class="w-2 h-2 rounded-full bg-slate-400"></span><span>Offline</span></span>';
  }
}

function updateRoomDoorStatus(kode, status, duration = 4000) {
  const doorBadgeEl = document.getElementById(`roomDoorBadge-${kode}`);
  if (doorBadgeEl) {
    doorBadgeEl.innerHTML = status === 'unlocked'
      ? `<span class="inline-flex items-center space-x-1.5 px-3 py-1 rounded-full text-xs font-bold bg-emerald-100 text-emerald-800 border border-emerald-200 glow-unlocked">
          <i class="fa-solid fa-lock-open text-emerald-600"></i>
          <span>TERBUKA (UNLOCKED)</span>
         </span>`
      : `<span class="inline-flex items-center space-x-1.5 px-3 py-1 rounded-full text-xs font-bold bg-slate-100 text-slate-700 border border-slate-200">
          <i class="fa-solid fa-lock text-slate-500"></i>
          <span>TERKUNCI (LOCKED)</span>
         </span>`;
  }
}

// Remote Unlock Modal & Confirmation
function confirmUnlockRoom(kode, nama) {
  if (!currentUser) {
    openLoginModal();
    return;
  }

  pendingUnlockRoomCode = kode;
  document.getElementById('unlockModalTitle').textContent = `Buka Pintu ${nama}`;
  document.getElementById('unlockModalDesc').textContent = (currentUser && currentUser.role === 'admin')
    ? `Apakah Anda yakin ingin membuka pintu ${nama}? Pintu akan tetap terbuka sampai Anda menguncinya kembali.`
    : `Apakah Anda yakin ingin mengirim sinyal MQTT unlock ke perangkat esp32-${kode.toLowerCase()}?`;

  // Reset tombol konfirmasi agar selalu siap diklik
  const btn = document.getElementById('btnConfirmUnlock');
  if (btn) {
    btn.disabled = false;
    btn.innerHTML = 'Ya, Buka Pintu';
  }

  document.getElementById('countdownBox').classList.add('hidden');
  document.getElementById('unlockModalActions').classList.remove('hidden');
  document.getElementById('unlockModal').classList.remove('hidden');
}

function closeUnlockModal() {
  if (unlockCountdownTimer) clearInterval(unlockCountdownTimer);
  document.getElementById('unlockModal').classList.add('hidden');
  document.getElementById('countdownBox').classList.add('hidden');
  document.getElementById('unlockModalActions').classList.remove('hidden');
  const btn = document.getElementById('btnConfirmUnlock');
  if (btn) {
    btn.disabled = false;
    btn.innerHTML = 'Ya, Buka Pintu';
  }
  pendingUnlockRoomCode = null;
}

async function executeRemoteUnlock() {
  if (!pendingUnlockRoomCode) return;
  const kode = pendingUnlockRoomCode;

  const btn = document.getElementById('btnConfirmUnlock');
  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin mr-2"></i> Mengirim...';

  try {
    const res = await apiFetch(`/api/rooms/${kode}/unlock`, {
      method: 'POST'
    });

    if (res.duration === 0) {
      closeUnlockModal();
      showToast(res.message || `Pintu ${kode} terbuka (tetap terbuka sampai dikunci Admin)`, 'success');
      loadRoomsData();
      return;
    }

    // Sembunyikan tombol aksi modal dan mulai animasi countdown
    document.getElementById('unlockModalActions').classList.add('hidden');
    const countdownBox = document.getElementById('countdownBox');
    countdownBox.classList.remove('hidden');

    let timeLeft = Math.ceil((res.duration || 4000) / 1000);
    const countSecondsEl = document.getElementById('countdownSeconds');
    countSecondsEl.textContent = `${timeLeft}s`;

    if (unlockCountdownTimer) clearInterval(unlockCountdownTimer);
    unlockCountdownTimer = setInterval(() => {
      timeLeft--;
      if (timeLeft <= 0) {
        clearInterval(unlockCountdownTimer);
        closeUnlockModal();
      } else {
        countSecondsEl.textContent = `${timeLeft}s`;
      }
    }, 1000);

  } catch (err) {
    showToast(err.message, 'error');
    btn.disabled = false;
    btn.innerHTML = 'Ya, Buka Pintu';
    closeUnlockModal();
  }
}

async function executeRemoteLock(kode) {
  try {
    const res = await apiFetch(`/api/rooms/${kode}/lock`, { method: 'POST' });
    showToast(res.message || `Pintu ${kode} berhasil dikunci`, 'success');
    loadRoomsData();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function triggerEspSync() {
  const btn = document.getElementById('btnSyncEsp');
  const origHtml = btn ? btn.innerHTML : '';
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i><span>Menyinkronkan...</span>';
  }
  try {
    const res = await apiFetch('/api/esp/sync', { method: 'POST' });
    showToast(res.message || 'Sinkronisasi ESP32 dikirim!', 'success');
    loadRoomsData();
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = origHtml;
    }
  }
}

// Live Feed Access Log (WebSocket Live Prepend)
async function loadLiveLogFeed() {
  try {
    const res = await apiFetch('/api/logs?limit=8');
    const tbody = document.getElementById('liveLogTableBody');
    if (!tbody) return;

    if (!res.data || res.data.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" class="py-6 text-center text-slate-400">Belum ada riwayat tap</td></tr>';
      return;
    }

    tbody.innerHTML = res.data.map(renderLiveLogRow).join('');
  } catch (e) {
    console.error('Error loading live logs:', e);
  }
}

function renderLiveLogRow(log) {
  const isGranted = log.status_akses === 'granted';
  const statusBadge = isGranted
    ? '<span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold bg-emerald-100 text-emerald-800"><i class="fa-solid fa-check mr-1 text-[10px]"></i> Granted</span>'
    : '<span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold bg-rose-100 text-rose-800"><i class="fa-solid fa-xmark mr-1 text-[10px]"></i> Denied</span>';

  const methodBadge = log.metode_akses === 'remote'
    ? '<span class="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-semibold bg-indigo-50 text-indigo-700 border border-indigo-200"><i class="fa-solid fa-mobile-screen mr-1"></i> Remote</span>'
    : '<span class="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-semibold bg-slate-100 text-slate-700 border border-slate-200"><i class="fa-solid fa-id-card mr-1"></i> RFID</span>';

  const roomColors = {
    MERAH: 'text-rose-600 bg-rose-50 border-rose-200',
    KUNING: 'text-amber-700 bg-amber-50 border-amber-200',
    HIJAU: 'text-emerald-700 bg-emerald-50 border-emerald-200'
  };

  return `
    <tr class="hover:bg-slate-50/80 transition">
      <td class="py-3 px-4 font-mono text-xs text-slate-500 whitespace-nowrap">${log.waktu_tap}</td>
      <td class="py-3 px-4 font-bold text-xs">
        <span class="px-2 py-0.5 rounded border text-[11px] ${roomColors[log.kode_ruangan] || 'text-slate-700 bg-slate-100'}">${log.nama_ruangan || log.kode_ruangan}</span>
      </td>
      <td class="py-3 px-4 font-medium text-slate-900">
        ${log.nama_lengkap || 'Pengguna Tidak Dikenal'}
        ${log.nim_nip && log.nim_nip !== '-' ? `<span class="block text-[11px] text-slate-400 font-mono">${log.nim_nip}</span>` : ''}
      </td>
      <td class="py-3 px-4">${methodBadge}</td>
      <td class="py-3 px-4 font-mono text-xs text-slate-600">${log.rfid_uid_tap || '-'}</td>
      <td class="py-3 px-4">${statusBadge}</td>
      <td class="py-3 px-4 text-xs font-mono text-slate-600">${log.keterangan || '-'}</td>
    </tr>
  `;
}

function prependLiveLog(log) {
  const tbody = document.getElementById('liveLogTableBody');
  if (!tbody) return;

  const temp = document.createElement('tbody');
  temp.innerHTML = renderLiveLogRow(log);
  const row = temp.firstElementChild;
  row.classList.add('bg-emerald-50/50');

  if (tbody.children.length === 1 && tbody.children[0].innerText.includes('Belum ada')) {
    tbody.innerHTML = '';
  }

  tbody.insertBefore(row, tbody.firstChild);

  // Batasi hanya menampilkan 8 baris teratas di live preview
  if (tbody.children.length > 8) {
    tbody.lastElementChild.remove();
  }

  // Hilangkan highlight hijau setelah 3 detik
  setTimeout(() => row.classList.remove('bg-emerald-50/50'), 3000);
}

// ==========================================================
// TAB 2: MANAJEMEN JADWAL (SCHEDULES)
// ==========================================================
async function loadSchedulesData() {
  const room = document.getElementById('filterSchedRoom').value;
  const status = document.getElementById('filterSchedStatus').value;
  const date = document.getElementById('filterSchedDate').value;
  const search = document.getElementById('filterSchedSearch').value.trim();

  const tbody = document.getElementById('schedulesTableBody');
  if (!tbody) return;

  tbody.innerHTML = '<tr><td colspan="7" class="py-8 text-center text-slate-400"><i class="fa-solid fa-circle-notch fa-spin mr-2"></i> Memuat jadwal...</td></tr>';

  try {
    const params = new URLSearchParams();
    if (room) params.append('room', room);
    if (status) params.append('status', status);
    if (date) params.append('date', date);
    if (search) params.append('search', search);

    const res = await apiFetch(`/api/schedules/all?${params.toString()}`);
    renderSchedulesTable(res.schedules || []);
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" class="py-6 text-center text-rose-500">${err.message}</td></tr>`;
  }
}

function renderSchedulesTable(schedules) {
  const tbody = document.getElementById('schedulesTableBody');
  if (!tbody) return;

  if (schedules.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="py-8 text-center text-slate-400">Tidak ada data jadwal ditemukan</td></tr>';
    return;
  }

  const statusBadges = {
    pending: '<span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold bg-amber-100 text-amber-800"><i class="fa-solid fa-clock mr-1 text-[10px]"></i> Pending</span>',
    approved: '<span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold bg-emerald-100 text-emerald-800"><i class="fa-solid fa-check mr-1 text-[10px]"></i> Approved</span>',
    rejected: '<span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold bg-rose-100 text-rose-800"><i class="fa-solid fa-ban mr-1 text-[10px]"></i> Rejected</span>'
  };

  const roomColors = {
    MERAH: 'text-rose-700 bg-rose-50 border-rose-200',
    KUNING: 'text-amber-700 bg-amber-50 border-amber-200',
    HIJAU: 'text-emerald-700 bg-emerald-50 border-emerald-200'
  };

  tbody.innerHTML = schedules.map(s => {
    const isAdmin = currentUser && currentUser.role === 'admin';
    const isOwner = currentUser && currentUser.id_user === s.id_user;

    let actions = '-';
    if (isAdmin) {
      actions = `
        <div class="flex items-center justify-center space-x-1.5">
          ${s.status_jadwal === 'pending' ? `
            <button onclick="updateScheduleStatus(${s.id_schedule}, 'approved')" title="Setujui Jadwal" class="px-2 py-1 bg-emerald-50 text-emerald-700 hover:bg-emerald-600 hover:text-white border border-emerald-200 rounded-lg text-xs font-bold transition">
              <i class="fa-solid fa-check mr-1"></i> Approve
            </button>
            <button onclick="updateScheduleStatus(${s.id_schedule}, 'rejected')" title="Tolak Jadwal" class="px-2 py-1 bg-rose-50 text-rose-700 hover:bg-rose-600 hover:text-white border border-rose-200 rounded-lg text-xs font-bold transition">
              <i class="fa-solid fa-xmark mr-1"></i> Reject
            </button>
          ` : ''}
          <button onclick="deleteSchedule(${s.id_schedule})" title="Hapus Jadwal" class="p-1.5 text-slate-400 hover:text-rose-600 rounded-lg hover:bg-slate-100 transition">
            <i class="fa-solid fa-trash-can"></i>
          </button>
        </div>
      `;
    } else if (isOwner && s.status_jadwal === 'pending') {
      actions = `
        <button onclick="deleteSchedule(${s.id_schedule})" class="px-2.5 py-1 text-xs text-rose-600 hover:bg-rose-50 border border-rose-200 rounded-lg font-semibold transition">
          Batalkan
        </button>
      `;
    }

    return `
      <tr class="hover:bg-slate-50/80 transition">
        <td class="py-3 px-4 font-medium text-slate-900 text-xs whitespace-nowrap">
          <i class="fa-regular fa-calendar mr-1.5 text-indigo-500"></i> ${s.tanggal_akses}
        </td>
        <td class="py-3 px-4">
          <span class="px-2 py-0.5 rounded border text-xs font-bold ${roomColors[s.kode_ruangan] || 'bg-slate-100 text-slate-700'}">
            ${s.nama_ruangan}
          </span>
        </td>
        <td class="py-3 px-4 font-mono text-xs font-semibold text-slate-700 whitespace-nowrap">
          ${s.jam_mulai.slice(0, 5)} - ${s.jam_selesai.slice(0, 5)}
        </td>
        <td class="py-3 px-4">
          <div class="font-bold text-slate-900 text-xs">${s.nama_lengkap}</div>
          <div class="text-[11px] text-slate-400 font-mono">${s.nim_nip} (${s.role})</div>
        </td>
        <td class="py-3 px-4 text-xs text-slate-700 max-w-xs truncate" title="${s.keperluan}">
          ${s.keperluan}
        </td>
        <td class="py-3 px-4">${statusBadges[s.status_jadwal] || s.status_jadwal}</td>
        <td class="py-3 px-4 text-center whitespace-nowrap">${actions}</td>
      </tr>
    `;
  }).join('');
}

function resetScheduleFilters() {
  document.getElementById('filterSchedRoom').value = '';
  document.getElementById('filterSchedStatus').value = '';
  document.getElementById('filterSchedDate').value = '';
  document.getElementById('filterSchedSearch').value = '';
  loadSchedulesData();
}

function openScheduleModal() {
  if (!currentUser) {
    openLoginModal();
    return;
  }
  document.getElementById('schedConflictAlert').classList.add('hidden');
  document.getElementById('scheduleForm').reset();
  const today = new Date().toISOString().slice(0, 10);
  document.getElementById('schedDate').value = today;
  document.getElementById('scheduleModal').classList.remove('hidden');
}

function closeScheduleModal() {
  document.getElementById('scheduleModal').classList.add('hidden');
}

async function handleScheduleSubmit(e) {
  e.preventDefault();
  const id_room = document.getElementById('schedRoomId').value;
  const tanggal_akses = document.getElementById('schedDate').value;
  const jam_mulai = document.getElementById('schedStartTime').value;
  const jam_selesai = document.getElementById('schedEndTime').value;
  const keperluan = document.getElementById('schedPurpose').value.trim();

  const conflictAlert = document.getElementById('schedConflictAlert');
  const conflictMsg = document.getElementById('schedConflictMsg');
  conflictAlert.classList.add('hidden');

  const btn = document.getElementById('btnSubmitSched');
  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin mr-2"></i> Memvalidasi...';

  try {
    const res = await apiFetch('/api/schedules', {
      method: 'POST',
      body: JSON.stringify({ id_room, tanggal_akses, jam_mulai, jam_selesai, keperluan })
    });

    closeScheduleModal();
    showToast(res.message, 'success');
    loadSchedulesData();
    loadRoomsData();
  } catch (err) {
    conflictMsg.textContent = err.message;
    conflictAlert.classList.remove('hidden');
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = 'Kirim Pengajuan';
  }
}

async function updateScheduleStatus(id, newStatus) {
  try {
    const res = await apiFetch(`/api/schedules/${id}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status_jadwal: newStatus })
    });
    showToast(res.message, 'success');
    loadSchedulesData();
    loadRoomsData();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function deleteSchedule(id) {
  if (!confirm('Apakah Anda yakin ingin membatalkan/menghapus jadwal ini?')) return;

  try {
    const res = await apiFetch(`/api/schedules/${id}`, { method: 'DELETE' });
    showToast(res.message, 'info');
    loadSchedulesData();
    loadRoomsData();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ==========================================================
// TAB 3: MANAJEMEN PENGGUNA & RFID (ADMIN ONLY)
// ==========================================================
async function loadUsersData() {
  const tbody = document.getElementById('usersTableBody');
  if (!tbody) return;

  tbody.innerHTML = '<tr><td colspan="7" class="py-8 text-center text-slate-400"><i class="fa-solid fa-circle-notch fa-spin mr-2"></i> Memuat data pengguna...</td></tr>';

  try {
    const res = await apiFetch('/api/users');
    renderUsersTable(res.users || []);
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" class="py-6 text-center text-rose-500">${err.message}</td></tr>`;
  }
}

function renderUsersTable(users) {
  const tbody = document.getElementById('usersTableBody');
  if (!tbody) return;

  if (users.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="py-8 text-center text-slate-400">Tidak ada data pengguna</td></tr>';
    return;
  }

  const roleBadges = {
    admin: '<span class="px-2.5 py-0.5 rounded-full text-xs font-bold bg-blue-100 text-blue-800">Admin</span>',
    dosen: '<span class="px-2.5 py-0.5 rounded-full text-xs font-bold bg-purple-100 text-purple-800">Dosen</span>',
    mahasiswa: '<span class="px-2.5 py-0.5 rounded-full text-xs font-bold bg-emerald-100 text-emerald-800">Mahasiswa</span>'
  };

  tbody.innerHTML = users.map(u => {
    return `
      <tr class="hover:bg-slate-50/80 transition">
        <td class="py-3 px-4 font-mono font-semibold text-slate-900 text-xs">${u.nim_nip}</td>
        <td class="py-3 px-4 font-bold text-slate-900 text-xs">${u.nama_lengkap}</td>
        <td class="py-3 px-4 text-xs text-slate-500">${u.email || '-'}</td>
        <td class="py-3 px-4">${roleBadges[u.role] || u.role}</td>
        <td class="py-3 px-4">
          ${u.rfid_uid 
            ? `<div class="space-y-1">
                 <span class="font-mono text-xs font-bold px-2 py-0.5 bg-slate-100 border border-slate-200 rounded text-slate-700 tracking-wider">${u.rfid_uid}</span>
                 ${u.tipe_kartu ? `<div class="text-[10px] font-semibold text-indigo-600 flex items-center space-x-1"><i class="fa-solid fa-tag text-[9px]"></i><span>${u.tipe_kartu}</span></div>` : ''}
               </div>` 
            : '<span class="text-xs text-rose-500 italic">Belum terhubung</span>'}
        </td>
        <td class="py-3 px-4 text-center font-semibold text-xs text-slate-700">${u.total_jadwal || 0}</td>
        <td class="py-3 px-4 text-center whitespace-nowrap">
          <button onclick="editUser(${JSON.stringify(u).replace(/"/g, '&quot;')})" class="p-1.5 text-slate-400 hover:text-indigo-600 rounded-lg hover:bg-slate-100 transition mr-1" title="Edit Pengguna">
            <i class="fa-solid fa-pen-to-square"></i>
          </button>
          <button onclick="deleteUser(${u.id_user}, '${u.nama_lengkap}')" class="p-1.5 text-slate-400 hover:text-rose-600 rounded-lg hover:bg-slate-100 transition" title="Hapus Pengguna">
            <i class="fa-solid fa-trash-can"></i>
          </button>
        </td>
      </tr>
    `;
  }).join('');
}

// Auto-Formatting UID ala Windows Product Key
function formatRfidInput(rawVal) {
  // Hanya izinkan karakter heksadesimal (0-9, A-F)
  const hexOnly = rawVal.replace(/[^0-9a-fA-F]/g, '').toUpperCase().slice(0, 14); // maks 7 byte
  const pairs = hexOnly.match(/.{1,2}/g) || [];
  return pairs.join(':');
}

function updateRfidInputFeedback() {
  const input = document.getElementById('userFormRfid');
  if (!input) return;
  const badge = document.getElementById('rfidFormatBadge');
  const badgeText = document.getElementById('rfidBadgeText');
  const countEl = document.getElementById('rfidBytesCount');

  const rawHex = input.value.replace(/[^0-9a-fA-F]/g, '');
  const byteCount = Math.floor(rawHex.length / 2);

  if (countEl) {
    countEl.textContent = `${byteCount} / ${byteCount > 4 ? '7' : '4'} Bytes`;
  }

  if (badge && badgeText) {
    if (byteCount === 4 && rawHex.length === 8) {
      badge.classList.remove('hidden');
      badgeText.textContent = 'Mifare 1K (4B)';
    } else if (byteCount === 7 && rawHex.length === 14) {
      badge.classList.remove('hidden');
      badgeText.textContent = 'NFC/e-KTP (7B)';
    } else {
      badge.classList.add('hidden');
    }
  }
}

function setCardLabelPreset(label) {
  const el = document.getElementById('userFormCardLabel');
  if (el) {
    el.value = label;
    el.focus();
  }
}

function openUserModal(user = null) {
  document.getElementById('userForm').reset();
  const title = document.getElementById('userModalTitle');
  const passHint = document.getElementById('userPassHint');
  const rfidInfo = document.getElementById('rfidDetectionInfo');

  if (user) {
    title.textContent = 'Edit Data Pengguna';
    passHint.textContent = '(Kosongkan jika password tidak diubah)';
    document.getElementById('userFormId').value = user.id_user;
    document.getElementById('userFormNim').value = user.nim_nip;
    document.getElementById('userFormNama').value = user.nama_lengkap;
    document.getElementById('userFormEmail').value = user.email || '';
    document.getElementById('userFormRole').value = user.role;
    document.getElementById('userFormRfid').value = user.rfid_uid || '';
    document.getElementById('userFormCardLabel').value = user.tipe_kartu || '';
  } else {
    title.textContent = 'Tambah Pengguna Baru';
    passHint.textContent = '(Default jika kosong: 12345678)';
    document.getElementById('userFormId').value = '';
    document.getElementById('userFormCardLabel').value = 'e-KTP';
  }

  updateRfidInputFeedback();
  rfidInfo.textContent = 'Tip: Jika baru men-tap kartu di reader, klik Auto-Fill untuk menarik UID secara instan.';
  document.getElementById('userModal').classList.remove('hidden');
}

function editUser(user) {
  openUserModal(user);
}

function closeUserModal() {
  document.getElementById('userModal').classList.add('hidden');
}

// FITUR SPESIAL: Auto-Fill UID dari Tap Terakhir
async function fetchLatestUnregisteredUid() {
  const rfidInput = document.getElementById('userFormRfid');
  const rfidInfo = document.getElementById('rfidDetectionInfo');

  rfidInfo.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin mr-1"></i> Mendeteksi tap kartu di log ESP32...';

  try {
    const res = await apiFetch('/api/users/latest-unregistered-uid');
    if (res.found) {
      rfidInput.value = formatRfidInput(res.uid);
      updateRfidInputFeedback();
      // Berikan efek highlight visual
      rfidInput.classList.add('ring-2', 'ring-emerald-500', 'bg-emerald-50');
      setTimeout(() => rfidInput.classList.remove('ring-2', 'ring-emerald-500', 'bg-emerald-50'), 2000);

      rfidInfo.innerHTML = `<span class="text-emerald-600 font-semibold"><i class="fa-solid fa-circle-check mr-1"></i> UID <strong>${res.uid}</strong> terdeteksi dari ${res.ruangan} pada ${res.waktu_tap}</span>`;
      showToast(`UID ${res.uid} berhasil disalin dari tap terakhir di ${res.ruangan}!`, 'success');
    } else {
      rfidInfo.innerHTML = `<span class="text-amber-600">${res.message}</span>`;
      showToast(res.message, 'warning');
    }
  } catch (err) {
    rfidInfo.innerHTML = `<span class="text-rose-600">${err.message}</span>`;
    showToast(err.message, 'error');
  }
}

async function handleUserSubmit(e) {
  e.preventDefault();
  const userId = document.getElementById('userFormId').value;
  const nim_nip = document.getElementById('userFormNim').value.trim();
  const nama_lengkap = document.getElementById('userFormNama').value.trim();
  const email = document.getElementById('userFormEmail').value.trim();
  const role = document.getElementById('userFormRole').value;
  const rfid_uid = document.getElementById('userFormRfid').value.trim();
  const tipe_kartu = document.getElementById('userFormCardLabel').value.trim();
  const password = document.getElementById('userFormPassword').value.trim();

  const btn = document.getElementById('btnSubmitUser');
  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin mr-2"></i> Menyimpan...';

  try {
    if (userId) {
      // Edit User
      const res = await apiFetch(`/api/users/${userId}`, {
        method: 'PUT',
        body: JSON.stringify({ nim_nip, nama_lengkap, email, role, rfid_uid, tipe_kartu, password })
      });
      showToast(res.message, 'success');
    } else {
      // Tambah Baru
      const res = await apiFetch('/api/users', {
        method: 'POST',
        body: JSON.stringify({ nim_nip, nama_lengkap, email, role, rfid_uid, tipe_kartu, password })
      });
      showToast(res.message, 'success');
    }

    closeUserModal();
    loadUsersData();
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = 'Simpan Pengguna';
  }
}

async function deleteUser(id, nama) {
  if (!confirm(`Apakah Anda yakin ingin menghapus pengguna "${nama}"? Semua jadwal terkait akan dihapus.`)) return;

  try {
    const res = await apiFetch(`/api/users/${id}`, { method: 'DELETE' });
    showToast(res.message, 'info');
    loadUsersData();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ==========================================================
// TAB 4: RIWAYAT AKSES & AUDIT LOG
// ==========================================================
async function loadLogsData(page = 1, showLoading = true) {
  currentLogPage = page;
  const room = document.getElementById('filterLogRoom').value;
  const method = document.getElementById('filterLogMethod').value;
  const status = document.getElementById('filterLogStatus').value;
  const startDate = document.getElementById('filterLogStartDate').value;
  const endDate = document.getElementById('filterLogEndDate').value;
  const search = document.getElementById('filterLogSearch').value.trim();

  const tbody = document.getElementById('logsTableBody');
  if (!tbody) return;

  if (showLoading) {
    tbody.innerHTML = '<tr><td colspan="7" class="py-8 text-center text-slate-400"><i class="fa-solid fa-circle-notch fa-spin mr-2"></i> Memuat riwayat akses...</td></tr>';
  }

  try {
    const params = new URLSearchParams();
    params.append('page', page);
    params.append('limit', 20);
    if (room) params.append('room', room);
    if (method) params.append('method', method);
    if (status) params.append('status', status);
    if (startDate) params.append('startDate', startDate);
    if (endDate) params.append('endDate', endDate);
    if (search) params.append('search', search);

    const res = await apiFetch(`/api/logs?${params.toString()}`);
    renderLogsTable(res.data || []);
    renderLogsPagination(res.pagination);
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" class="py-6 text-center text-rose-500">${err.message}</td></tr>`;
  }
}

function renderLogsTable(logs) {
  const tbody = document.getElementById('logsTableBody');
  if (!tbody) return;

  if (logs.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="py-8 text-center text-slate-400">Tidak ada riwayat akses ditemukan</td></tr>';
    return;
  }

  tbody.innerHTML = logs.map(renderLiveLogRow).join('');
}

function renderLogsPagination(p) {
  if (!p) return;
  const total = p.total || 0;
  const page = p.page || 1;
  const limit = p.limit || 20;
  const totalPages = p.totalPages || 1;

  const start = total === 0 ? 0 : (page - 1) * limit + 1;
  const end = Math.min(total, page * limit);

  document.getElementById('logRangeStart').textContent = start;
  document.getElementById('logRangeEnd').textContent = end;
  document.getElementById('logTotalCount').textContent = total;
  document.getElementById('logPageIndicator').textContent = `Halaman ${page} / ${totalPages}`;

  document.getElementById('btnPrevLog').disabled = page <= 1;
  document.getElementById('btnNextLog').disabled = page >= totalPages;
}

function changeLogPage(delta) {
  const target = currentLogPage + delta;
  if (target >= 1) loadLogsData(target);
}

function resetLogFilters() {
  document.getElementById('filterLogRoom').value = '';
  document.getElementById('filterLogMethod').value = '';
  document.getElementById('filterLogStatus').value = '';
  document.getElementById('filterLogStartDate').value = '';
  document.getElementById('filterLogEndDate').value = '';
  document.getElementById('filterLogSearch').value = '';
  loadLogsData(1);
}

function exportLogsCSV() {
  const room = document.getElementById('filterLogRoom').value;
  const method = document.getElementById('filterLogMethod').value;
  const status = document.getElementById('filterLogStatus').value;
  const startDate = document.getElementById('filterLogStartDate').value;
  const endDate = document.getElementById('filterLogEndDate').value;

  const params = new URLSearchParams();
  if (room) params.append('room', room);
  if (method) params.append('method', method);
  if (status) params.append('status', status);
  if (startDate) params.append('startDate', startDate);
  if (endDate) params.append('endDate', endDate);

  // Buka endpoint export dengan token otentikasi
  const url = `${API_BASE}/api/logs/export?${params.toString()}`;
  fetch(url, {
    headers: { 'Authorization': `Bearer ${currentToken}` }
  })
  .then(res => {
    if (!res.ok) throw new Error('Gagal mengekspor file');
    return res.blob();
  })
  .then(blob => {
    const downloadUrl = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = downloadUrl;
    a.download = `access_logs_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    showToast('File CSV berhasil diunduh', 'success');
  })
  .catch(err => showToast(err.message, 'error'));
}

// ==========================================================
// MODAL CONTROLLERS & UTILITIES
// ==========================================================
function openLoginModal() {
  document.getElementById('loginForm').reset();
  document.getElementById('loginModal').classList.remove('hidden');
}

function closeLoginModal() {
  document.getElementById('loginModal').classList.add('hidden');
}

function openRegisterModal() {
  document.getElementById('registerForm').reset();
  document.getElementById('registerModal').classList.remove('hidden');
}

function closeRegisterModal() {
  document.getElementById('registerModal').classList.add('hidden');
}

// MODAL UBAH JAM AKSES OPERASIONAL RUANGAN (ADMIN)
function openRoomHoursModal(room) {
  if (!room) return;
  document.getElementById('editRoomId').value = room.id_room;
  document.getElementById('editRoomLabel').textContent = `${room.nama_ruangan} (${room.kode_ruangan})`;
  document.getElementById('editJamBuka').value = room.jam_buka || '07:00';
  document.getElementById('editJamTutup').value = room.jam_tutup || '21:00';
  document.getElementById('roomHoursModal').classList.remove('hidden');
}

function closeRoomHoursModal() {
  document.getElementById('roomHoursModal').classList.add('hidden');
}

async function handleRoomHoursSubmit(e) {
  e.preventDefault();
  const roomId = document.getElementById('editRoomId').value;
  const jam_buka = document.getElementById('editJamBuka').value;
  const jam_tutup = document.getElementById('editJamTutup').value;
  const btn = document.getElementById('btnSubmitRoomHours');

  if (jam_buka >= jam_tutup) {
    showToast('Jam tutup harus lebih akhir dari jam buka', 'warning');
    return;
  }

  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin mr-2"></i> Menyimpan...';

  try {
    const res = await apiFetch(`/api/rooms/${roomId}/hours`, {
      method: 'PUT',
      body: JSON.stringify({ jam_buka, jam_tutup })
    });
    showToast(res.message, 'success');
    closeRoomHoursModal();
    loadRoomsData();
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = 'Simpan Jam Akses';
  }
}

// Debounce helper for instant search
function debounce(func, wait) {
  let timeout;
  return function (...args) {
    clearTimeout(timeout);
    timeout = setTimeout(() => func.apply(this, args), wait);
  };
}
