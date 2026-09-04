/** Konfigurasi: set ID master spreadsheet sebelum deployment. */
const CONFIG = {
  SPREADSHEET_ID: 'PASTE_MASTER_SPREADSHEET_ID_HERE',
  SHEETS: {
    EMPLOYEES: 'Employees',
    REQUESTS: 'LeaveRequests',
    BALANCE_HISTORY: 'LeaveBalanceHistory',
    AUDIT: 'AuditLog'
  },
  EMPLOYEE_HEADERS: ['Email', 'Nama', 'Departemen', 'Role', 'Saldo Cuti', 'Aktif'],
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
  ensureSheet_(CONFIG.SHEETS.REQUESTS, CONFIG.REQUEST_HEADERS);
  ensureSheet_(CONFIG.SHEETS.BALANCE_HISTORY, CONFIG.BALANCE_HEADERS);
  ensureSheet_(CONFIG.SHEETS.AUDIT, CONFIG.AUDIT_HEADERS);
}

function getBootstrapData() {
  var user = requireUser_();
  var result = { user: publicEmployee_(user), requests: getOwnRequests_(user.email), syncedAt: getCache_().syncedAt };
  if (isHrga_(user)) result.allRequests = getRequests_();
  return result;
}

function submitLeaveRequest(form) {
  var user = requireUser_();
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
  var actor = requireHrga_();
  var email = normalizeEmail_(data.email);
  if (!email || !data.name || !data.department || !data.role) throw new Error('Lengkapi data karyawan yang wajib diisi.');
  var balance = Number(data.balance);
  if (!isFinite(balance) || balance < 0) throw new Error('Saldo cuti harus berupa angka nol atau lebih.');
  var employees = sheet_(CONFIG.SHEETS.EMPLOYEES);
  var found = findEmployeeRow_(email);
  var values = [email, clean_(data.name), clean_(data.department), clean_(data.role), balance, data.active !== false];
  if (found) employees.getRange(found.row, 1, 1, values.length).setValues([values]);
  else employees.appendRow(values);
  audit_('SIMPAN_KARYAWAN', 'Employees', email, (found ? 'Memperbarui' : 'Menambah') + ' akun oleh ' + actor.email);
  clearCache_();
  return { message: 'Data karyawan disimpan.' };
}

function decideLeaveRequest(input) {
  var approver = requireHrga_();
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

function requireUser_() {
  var email = normalizeEmail_(Session.getActiveUser().getEmail());
  if (!email) throw new Error('Email akun tidak tersedia. Gunakan deployment Google Workspace yang mengizinkan identitas pengguna.');
  var employee = findEmployeeRow_(email);
  if (!employee || String(employee.data.Aktif).toLowerCase() === 'false') throw new Error('Akun Anda belum terdaftar atau tidak aktif.');
  return { email: email, name: employee.data.Nama, department: employee.data.Departemen, role: employee.data.Role, balance: Number(employee.data['Saldo Cuti']) };
}
function requireHrga_() { var user = requireUser_(); if (!isHrga_(user)) throw new Error('Akses hanya tersedia untuk HRGA.'); return user; }
function isHrga_(user) { return String(user.role).toUpperCase() === 'HRGA' || String(user.department).toUpperCase() === 'HRGA'; }
function publicEmployee_(u) { return { email: u.email, name: u.name, department: u.department, role: u.role, balance: u.balance, isHrga: isHrga_(u) }; }

function changeBalance_(email, change, reference, actor) {
  var found = findEmployeeRow_(email);
  if (!found) throw new Error('Karyawan pemohon tidak ditemukan.');
  var before = Number(found.data['Saldo Cuti']), after = before + change;
  if (after < 0) throw new Error('Saldo cuti pemohon sudah tidak mencukupi.');
  sheet_(CONFIG.SHEETS.EMPLOYEES).getRange(found.row, 5).setValue(after);
  sheet_(CONFIG.SHEETS.BALANCE_HISTORY).appendRow([new Date(), email, change, before, after, reference, actor]);
  audit_('UBAH_SALDO', 'Employees', email, 'Saldo ' + before + ' menjadi ' + after + '; referensi ' + reference);
}
function getOwnRequests_(email) { return getRequests_().filter(function (r) { return r.Email === email; }); }
function getRequests_() { return rowsAsObjects_(sheet_(CONFIG.SHEETS.REQUESTS), CONFIG.REQUEST_HEADERS).map(serialize_); }
function getEmployees_() { return rowsAsObjects_(sheet_(CONFIG.SHEETS.EMPLOYEES), CONFIG.EMPLOYEE_HEADERS); }
function findEmployeeRow_(email) { return findRow_(CONFIG.SHEETS.EMPLOYEES, CONFIG.EMPLOYEE_HEADERS, 'Email', email); }
function findRequestRow_(id) { return findRow_(CONFIG.SHEETS.REQUESTS, CONFIG.REQUEST_HEADERS, 'ID', id); }
function findRow_(name, headers, field, value) { var data = rowsAsObjects_(sheet_(name), headers, true); return data.filter(function(x) { return String(x.data[field]).toLowerCase() === String(value).toLowerCase(); })[0] || null; }
function rowsAsObjects_(sheet, headers, withRow) { var values = sheet.getDataRange().getValues(); return values.slice(1).filter(function(r) { return r.some(String); }).map(function(r, i) { var data = {}; headers.forEach(function(h,j) { data[h] = r[j]; }); return withRow ? { row: i + 2, data: data } : data; }); }
function sheet_(name) { var ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID); var sh = ss.getSheetByName(name); if (!sh) throw new Error('Sheet ' + name + ' tidak ditemukan. Jalankan setupMasterSheets.'); return sh; }
function ensureSheet_(name, headers) { var ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID); var sh = ss.getSheetByName(name) || ss.insertSheet(name); if (sh.getLastRow() === 0) sh.appendRow(headers); return sh; }
function audit_(action, entity, id, detail) { sheet_(CONFIG.SHEETS.AUDIT).appendRow([new Date(), Session.getActiveUser().getEmail() || 'system', action, entity, id, detail]); Logger.log('%s: %s', action, detail); }
function validateRequest_(form, user) { if (!form || !form.leaveType || !form.startDate || !form.endDate || !form.reason) throw new Error('Lengkapi seluruh data pengajuan.'); var s=parseDate_(form.startDate), e=parseDate_(form.endDate); if (e < s) throw new Error('Tanggal selesai tidak boleh sebelum tanggal mulai.'); if (s < new Date(new Date().setHours(0,0,0,0))) throw new Error('Tanggal mulai tidak boleh di masa lalu.'); if (!user.email) throw new Error('Sesi pengguna tidak valid.'); }
function parseDate_(v) { var d = new Date(v + 'T00:00:00'); if (isNaN(d)) throw new Error('Format tanggal tidak valid.'); return d; }
function businessDays_(start,end) { var days=0, d=new Date(start); while(d<=end) { if(d.getDay() !== 0 && d.getDay() !== 6) days++; d.setDate(d.getDate()+1); } if(!days) throw new Error('Pilih setidaknya satu hari kerja.'); return days; }
function clean_(v) { return String(v || '').trim(); }
function normalizeEmail_(v) { return clean_(v).toLowerCase(); }
function serialize_(data) { Object.keys(data).forEach(function(k) { if (Object.prototype.toString.call(data[k]) === '[object Date]') data[k] = Utilities.formatDate(data[k], Session.getScriptTimeZone(), 'yyyy-MM-dd'); }); return data; }
function getCache_() { var value = CacheService.getScriptCache().get('hr_sync'); return value ? JSON.parse(value) : {}; }
function clearCache_() { CacheService.getScriptCache().remove('hr_sync'); }
