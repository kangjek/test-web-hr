/** Konfigurasi: set ID master spreadsheet sebelum deployment. */
const CONFIG = {
  SPREADSHEET_ID: 'PASTE_MASTER_SPREADSHEET_ID_HERE',
  SHEETS: {
    EMPLOYEES: 'Employees',
    REQUESTS: 'LeaveRequests',
    BALANCE_HISTORY: 'LeaveBalanceHistory',
    AUDIT: 'AuditLog'
  },
  EMPLOYEE_HEADERS: ['ID Karyawan', 'Email', 'Nama', 'Departemen', 'Role', 'Saldo Cuti', 'Aktif', 'Password Hash', 'Password Salt'],
  REQUEST_HEADERS: ['ID', 'Email', 'Jenis Cuti', 'Tanggal Mulai', 'Tanggal Selesai', 'Durasi', 'Alasan', 'Status', 'Approver', 'Timestamp'],
  BALANCE_HEADERS: ['Timestamp', 'Email', 'Perubahan', 'Saldo Sebelum', 'Saldo Sesudah', 'Referensi', 'Aktor'],
  AUDIT_HEADERS: ['Timestamp', 'Aktor', 'Aksi', 'Entitas', 'ID Entitas', 'Detail']
};

function doGet() {
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle('HR Leave Portal')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function include(filename) { return HtmlService.createHtmlOutputFromFile(filename).getContent(); }

/** Jalankan sekali untuk membuat sheet dan header yang diperlukan. */
function setupMasterSheets() {
  ensureSheet_(CONFIG.SHEETS.EMPLOYEES, CONFIG.EMPLOYEE_HEADERS);
  migrateEmployeeHeaders_();
  ensureSheet_(CONFIG.SHEETS.REQUESTS, CONFIG.REQUEST_HEADERS);
  ensureSheet_(CONFIG.SHEETS.BALANCE_HISTORY, CONFIG.BALANCE_HEADERS);
  ensureSheet_(CONFIG.SHEETS.AUDIT, CONFIG.AUDIT_HEADERS);
}

function login(credentials) {
  if (!credentials) throw new Error('Masukkan email/ID karyawan dan password.');
  var employee = findEmployeeByIdentifier_(credentials.identifier);
  if (!employee || String(employee.data.Aktif).toLowerCase() === 'false' || !verifyPassword_(credentials.password, employee.data)) {
    throw new Error('Email/ID karyawan atau password tidak valid.');
  }
  var token = Utilities.getUuid() + Utilities.getUuid();
  CacheService.getScriptCache().put('hr_session_' + token, JSON.stringify({ email: employee.data.Email }), 21600);
  audit_('LOGIN', 'Employees', employee.data.Email, 'Login dengan email/ID karyawan');
  return { token: token };
}

/**
 * Mengaktifkan password pertama untuk akun HRGA. Ini hanya dapat dilakukan
 * sekali, selama akun aktif dan belum memiliki password.
 */
function setupInitialAdminPassword(input) {
  var employee = findEmployeeByIdentifier_(input && input.identifier);
  var password = clean_(input && input.password);
  if (!isInitialAdminCandidate_(employee)) {
    throw new Error('Akun admin tidak dapat diaktifkan. Periksa email/ID karyawan atau hubungi administrator sistem.');
  }
  if (employee.data['Password Hash'] || employee.data['Password Salt']) {
    throw new Error('Password akun admin ini sudah diatur. Silakan masuk atau gunakan lupa password.');
  }
  if (password.length < 8) throw new Error('Password minimal 8 karakter.');

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    // Baca ulang setelah mendapatkan lock agar password awal tidak dapat ditetapkan dua kali.
    employee = findEmployeeByIdentifier_(input.identifier);
    if (!isInitialAdminCandidate_(employee)) throw new Error('Akun admin tidak dapat diaktifkan. Periksa email/ID karyawan atau hubungi administrator sistem.');
    if (employee.data['Password Hash'] || employee.data['Password Salt']) throw new Error('Password akun admin ini sudah diatur. Silakan masuk atau gunakan lupa password.');
    var credentials = passwordRecord_(password);
    var employeeSheet = sheet_(CONFIG.SHEETS.EMPLOYEES);
    employeeSheet.getRange(employee.row, 8, 1, 2).setValues([[credentials.hash, credentials.salt]]);
    audit_('ATUR_PASSWORD_AWAL_ADMIN', 'Employees', employee.data.Email, 'Password awal admin diatur sendiri');
    clearCache_();
    return { message: 'Password admin berhasil diatur. Silakan masuk menggunakan password baru Anda.' };
  } finally { lock.releaseLock(); }
}

function requestPasswordReset(input) {
  var employee = findEmployeeByIdentifier_(input && input.identifier);
  // Jangan mengungkap apakah akun tertentu terdaftar.
  if (!employee) return { message: 'Jika akun terdaftar, permohonan reset telah dikirim ke admin HRGA.' };
  var recipients = getEmployees_().filter(function(e) { return String(e.Aktif).toLowerCase() !== 'false' && isHrga_({ role: e.Role, department: e.Departemen }); }).map(function(e) { return normalizeEmail_(e.Email); }).filter(String);
  if (!recipients.length) throw new Error('Admin HRGA belum dikonfigurasi. Hubungi administrator sistem.');
  var note = clean_(input.note).slice(0, 300);
  MailApp.sendEmail({ to: recipients.join(','), subject: '[Portal Cuti] Permohonan reset password', htmlBody: '<p>Ada permohonan reset password.</p><p><b>Nama:</b> ' + html_(employee.data.Nama) + '<br><b>ID Karyawan:</b> ' + html_(employee.data['ID Karyawan']) + '<br><b>Email:</b> ' + html_(employee.data.Email) + '</p><p><b>Catatan:</b> ' + html_(note || '-') + '</p><p>Silakan atur password baru melalui menu Administrasi HRGA.</p>' });
  audit_('MINTA_RESET_PASSWORD', 'Employees', employee.data.Email, 'Permohonan dikirim ke HRGA');
  return { message: 'Jika akun terdaftar, permohonan reset telah dikirim ke admin HRGA.' };
}

function getBootstrapData(input) {
  var user = requireUser_(input && input.token);
  var result = { user: publicEmployee_(user), requests: getOwnRequests_(user.email), syncedAt: getCache_().syncedAt };
  if (isHrga_(user)) result.allRequests = getRequests_();
  return result;
}
function submitLeaveRequest(form) {
  var user = requireUser_(form && form.token);
  validateRequest_(form, user);
  var start = parseDate_(form.startDate), end = parseDate_(form.endDate);
  var duration = businessDays_(start, end);
  if (duration > Number(user.balance)) throw new Error('Saldo cuti tahunan tidak mencukupi.');
  var id = Utilities.getUuid();
  var row = [id, user.email, clean_(form.leaveType), start, end, duration, clean_(form.reason), 'Menunggu', '', new Date()];
  sheet_(CONFIG.SHEETS.REQUESTS).appendRow(row);
  audit_('BUAT_PENGAJUAN', 'LeaveRequests', id, 'Pengajuan cuti dibuat');
  clearCache_();
  return { id: id, message: 'Pengajuan cuti berhasil dikirim.' };
}

function saveEmployee(data) {
  var actor = requireHrga_(data && data.token);
  var email = normalizeEmail_(data.email), employeeId = clean_(data.employeeId);
  if (!email || !employeeId || !data.name || !data.department || !data.role) throw new Error('Lengkapi data karyawan yang wajib diisi.');
  var existingId = findEmployeeByIdentifier_(employeeId);
  if (existingId && normalizeEmail_(existingId.data.Email) !== email) throw new Error('Nomor ID karyawan sudah digunakan akun lain.');
  var balance = Number(data.balance);
  if (!isFinite(balance) || balance < 0) throw new Error('Saldo cuti harus berupa angka nol atau lebih.');
  var employees = sheet_(CONFIG.SHEETS.EMPLOYEES);
  var found = findEmployeeRow_(email);
  if ((!found && clean_(data.password).length < 8) || (clean_(data.password) && clean_(data.password).length < 8)) throw new Error('Password minimal 8 karakter wajib diisi untuk akun baru atau saat diubah.');
  var old = found ? found.data : {};
  var credentials = clean_(data.password) ? passwordRecord_(data.password) : { hash: old['Password Hash'], salt: old['Password Salt'] };
  var values = [employeeId, email, clean_(data.name), clean_(data.department), clean_(data.role), balance, data.active !== false, credentials.hash, credentials.salt];
  if (found) employees.getRange(found.row, 1, 1, values.length).setValues([values]);
  else employees.appendRow(values);
  audit_('SIMPAN_KARYAWAN', 'Employees', email, (found ? 'Memperbarui' : 'Menambah') + ' akun oleh ' + actor.email);
  clearCache_();
  return { message: 'Data karyawan disimpan.' };
}

function decideLeaveRequest(input) {
  var approver = requireHrga_(input && input.token);
  var requestId = input && input.requestId;
  var decision = input && input.decision;
  if (['Disetujui', 'Ditolak'].indexOf(decision) === -1) throw new Error('Keputusan tidak valid.');
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var request = findRequestRow_(requestId);
    if (!request) throw new Error('Pengajuan tidak ditemukan.');
    if (request.data.Status !== 'Menunggu') throw new Error('Pengajuan ini sudah diproses.');
    if (decision === 'Disetujui') changeBalance_(request.data.Email, -Number(request.data.Durasi), requestId, approver.email);
    var headers = CONFIG.REQUEST_HEADERS;
    var row = request.row;
    var requestSheet = sheet_(CONFIG.SHEETS.REQUESTS);
    requestSheet.getRange(row, headers.indexOf('Status') + 1).setValue(decision);
    requestSheet.getRange(row, headers.indexOf('Approver') + 1).setValue(approver.email);
    requestSheet.getRange(row, headers.indexOf('Timestamp') + 1).setValue(new Date());
    audit_('STATUS_CUTI', 'LeaveRequests', requestId, decision + ' oleh ' + approver.email);
    clearCache_();
    return { message: 'Pengajuan ' + decision.toLowerCase() + '.' };
  } finally { lock.releaseLock(); }
}

/** Trigger berkala: menyegarkan cache dan memastikan struktur master tetap valid. */
function syncMasterData() {
  setupMasterSheets();
  var employees = getEmployees_();
  CacheService.getScriptCache().put('hr_sync', JSON.stringify({ syncedAt: new Date().toISOString(), employeeCount: employees.length }), 21600);
  Logger.log('Master data disinkronkan: %s karyawan.', employees.length);
  return { syncedAt: new Date(), employeeCount: employees.length };
}

/** Trigger on-edit installable, misalnya setelah admin mengubah master sheet langsung. */
function onMasterSheetEdit(e) {
  if (e && Object.keys(CONFIG.SHEETS).indexOf(e.range.getSheet().getName()) !== -1) {
    clearCache_(); Logger.log('Cache dibersihkan setelah perubahan master sheet.');
  }
}

function createSyncTrigger() {
  ScriptApp.newTrigger('syncMasterData').timeBased().everyHours(1).create();
}

function requireUser_(token) {
  if (!token) throw new Error('Sesi login tidak ditemukan.');
  var saved = CacheService.getScriptCache().get('hr_session_' + token);
  if (!saved) throw new Error('Sesi login berakhir. Silakan masuk kembali.');
  var email = normalizeEmail_(JSON.parse(saved).email);
  var employee = findEmployeeRow_(email);
  if (!employee || String(employee.data.Aktif).toLowerCase() === 'false') throw new Error('Akun Anda belum terdaftar atau tidak aktif.');
  return { email: email, name: employee.data.Nama, department: employee.data.Departemen, role: employee.data.Role, balance: Number(employee.data['Saldo Cuti']) };
}
function requireHrga_(token) { var user = requireUser_(token); if (!isHrga_(user)) throw new Error('Akses hanya tersedia untuk HRGA.'); return user; }
function isHrga_(user) { return String(user.role).toUpperCase() === 'HRGA' || String(user.department).toUpperCase() === 'HRGA'; }
function isInitialAdminCandidate_(employee) { return Boolean(employee && String(employee.data.Aktif).toLowerCase() !== 'false' && isHrga_({ role: employee.data.Role, department: employee.data.Departemen })); }
function publicEmployee_(u) { return { email: u.email, name: u.name, department: u.department, role: u.role, balance: u.balance, isHrga: isHrga_(u) }; }

function changeBalance_(email, change, reference, actor) {
  var found = findEmployeeRow_(email);
  if (!found) throw new Error('Karyawan pemohon tidak ditemukan.');
  var before = Number(found.data['Saldo Cuti']), after = before + change;
  if (after < 0) throw new Error('Saldo cuti pemohon sudah tidak mencukupi.');
  sheet_(CONFIG.SHEETS.EMPLOYEES).getRange(found.row, 6).setValue(after);
  sheet_(CONFIG.SHEETS.BALANCE_HISTORY).appendRow([new Date(), email, change, before, after, reference, actor]);
  audit_('UBAH_SALDO', 'Employees', email, 'Saldo ' + before + ' menjadi ' + after + '; referensi ' + reference);
}
function getOwnRequests_(email) { return getRequests_().filter(function (r) { return r.Email === email; }); }
function getRequests_() { return rowsAsObjects_(sheet_(CONFIG.SHEETS.REQUESTS), CONFIG.REQUEST_HEADERS).map(serialize_); }
function getEmployees_() { return rowsAsObjects_(sheet_(CONFIG.SHEETS.EMPLOYEES), CONFIG.EMPLOYEE_HEADERS); }
function findEmployeeRow_(email) { return findRow_(CONFIG.SHEETS.EMPLOYEES, CONFIG.EMPLOYEE_HEADERS, 'Email', email); }
function findEmployeeByIdentifier_(value) { var identifier = clean_(value); if (!identifier) return null; var byEmail = findEmployeeRow_(normalizeEmail_(identifier)); return byEmail || findRow_(CONFIG.SHEETS.EMPLOYEES, CONFIG.EMPLOYEE_HEADERS, 'ID Karyawan', identifier); }
function findRequestRow_(id) { return findRow_(CONFIG.SHEETS.REQUESTS, CONFIG.REQUEST_HEADERS, 'ID', id); }
function findRow_(name, headers, field, value) { var data = rowsAsObjects_(sheet_(name), headers, true); return data.filter(function(x) { return String(x.data[field]).toLowerCase() === String(value).toLowerCase(); })[0] || null; }
function rowsAsObjects_(sheet, headers, withRow) { var values = sheet.getDataRange().getValues(); return values.slice(1).filter(function(r) { return r.some(String); }).map(function(r, i) { var data = {}; headers.forEach(function(h,j) { data[h] = r[j]; }); return withRow ? { row: i + 2, data: data } : data; }); }
function sheet_(name) { var ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID); var sh = ss.getSheetByName(name); if (!sh) throw new Error('Sheet ' + name + ' tidak ditemukan. Jalankan setupMasterSheets.'); return sh; }
function migrateEmployeeHeaders_() { var sh = sheet_(CONFIG.SHEETS.EMPLOYEES); var first = sh.getRange(1, 1).getValue(); if (first === 'Email') sh.insertColumnBefore(1); var existing = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), CONFIG.EMPLOYEE_HEADERS.length)).getValues()[0]; CONFIG.EMPLOYEE_HEADERS.forEach(function(header, i) { if (existing[i] !== header) sh.getRange(1, i + 1).setValue(header); }); }
function ensureSheet_(name, headers) { var ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID); var sh = ss.getSheetByName(name) || ss.insertSheet(name); if (sh.getLastRow() === 0) sh.appendRow(headers); return sh; }
function audit_(action, entity, id, detail) { sheet_(CONFIG.SHEETS.AUDIT).appendRow([new Date(), Session.getActiveUser().getEmail() || 'system', action, entity, id, detail]); Logger.log('%s: %s', action, detail); }
function validateRequest_(form, user) { if (!form || !form.leaveType || !form.startDate || !form.endDate || !form.reason) throw new Error('Lengkapi seluruh data pengajuan.'); var s=parseDate_(form.startDate), e=parseDate_(form.endDate); if (e < s) throw new Error('Tanggal selesai tidak boleh sebelum tanggal mulai.'); if (s < new Date(new Date().setHours(0,0,0,0))) throw new Error('Tanggal mulai tidak boleh di masa lalu.'); if (!user.email) throw new Error('Sesi pengguna tidak valid.'); }
function parseDate_(v) { var d = new Date(v + 'T00:00:00'); if (isNaN(d)) throw new Error('Format tanggal tidak valid.'); return d; }
function businessDays_(start,end) { var days=0, d=new Date(start); while(d<=end) { if(d.getDay() !== 0 && d.getDay() !== 6) days++; d.setDate(d.getDate()+1); } if(!days) throw new Error('Pilih setidaknya satu hari kerja.'); return days; }
function passwordRecord_(password) { var salt = Utilities.getUuid(); return { salt: salt, hash: hashPassword_(password, salt) }; }
function verifyPassword_(password, employee) { return Boolean(employee['Password Salt'] && employee['Password Hash']) && hashPassword_(password, employee['Password Salt']) === String(employee['Password Hash']); }
function hashPassword_(password, salt) { var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(salt) + ':' + String(password), Utilities.Charset.UTF_8); return bytes.map(function(b) { var n = b < 0 ? b + 256 : b; return ('0' + n.toString(16)).slice(-2); }).join(''); }
function html_(value) { return clean_(value).replace(/[&<>"']/g, function(c) { return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
function clean_(v) { return String(v || '').trim(); }
function normalizeEmail_(v) { return clean_(v).toLowerCase(); }
function serialize_(data) { Object.keys(data).forEach(function(k) { if (Object.prototype.toString.call(data[k]) === '[object Date]') data[k] = Utilities.formatDate(data[k], Session.getScriptTimeZone(), 'yyyy-MM-dd'); }); return data; }
function getCache_() { var value = CacheService.getScriptCache().get('hr_sync'); return value ? JSON.parse(value) : {}; }
function clearCache_() { CacheService.getScriptCache().remove('hr_sync'); }
