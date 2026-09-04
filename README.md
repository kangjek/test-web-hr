# Portal Cuti HR — Google Apps Script

Portal web-app untuk Google Sites: karyawan hanya dapat mengakses profil, saldo, dan pengajuan miliknya; HRGA mendapat administrasi akun serta approval. Semua operasi sensitif divalidasi ulang di Apps Script, bukan hanya di UI.

## Konfigurasi master spreadsheet

1. Buat Google Spreadsheet master, lalu salin ID pada URL-nya ke `CONFIG.SPREADSHEET_ID` di `Code.gs`.
2. Di editor Apps Script, jalankan `setupMasterSheets` sekali dan beri otorisasi. Fungsi itu membuat header berikut (header harus tetap sama):
   - `Employees`: `Email, Nama, Departemen, Role, Saldo Cuti, Aktif`
   - `LeaveRequests`: `ID, Email, Jenis Cuti, Tanggal Mulai, Tanggal Selesai, Durasi, Alasan, Status, Approver, Timestamp`
   - `LeaveBalanceHistory`: `Timestamp, Email, Perubahan, Saldo Sebelum, Saldo Sesudah, Referensi, Aktor`
   - `AuditLog`: `Timestamp, Aktor, Aksi, Entitas, ID Entitas, Detail`
3. Tambahkan karyawan awal ke `Employees`; gunakan `HRGA` pada kolom **Role** atau **Departemen** bagi administrator. Set `Aktif` ke `TRUE`.

## Deployment dan Google Sites

1. Di Apps Script, **Deploy → New deployment → Web app**. Jalankan sebagai pengguna yang mendeploy (akun tersebut perlu akses editor ke spreadsheet master).
2. Untuk Workspace, pilih akses hanya pengguna di domain yang sesuai. Ini penting karena `Session.getActiveUser().getEmail()` dapat kosong pada deployment publik/anonim.
3. Salin URL deployment. Di Google Sites, pilih **Insert → Embed → By URL**, lalu masukkan URL tersebut. `doGet` menggunakan `ALLOWALL` agar dapat dibingkai oleh Sites.

## Sinkronisasi dan audit

* Jalankan `createSyncTrigger` sekali untuk trigger setiap jam yang menjalankan `syncMasterData`; fungsi ini memastikan struktur sheet dan menyegarkan cache metadata.
* Buat **installable trigger** untuk `onMasterSheetEdit` dari spreadsheet master bila data sering diubah langsung. Trigger tersebut membuang cache saat sheet master berubah.
* Setiap pengajuan, status approval, mutasi saldo, dan perubahan akun ditulis ke `AuditLog`; mutasi saldo juga dicatat di `LeaveBalanceHistory`. Approval memakai `LockService` dan memeriksa status kembali, sehingga saldo tidak bisa terpotong dua kali.

## Pengembangan lokal

Gunakan [clasp](https://github.com/google/clasp) untuk push file ini ke proyek Apps Script, misalnya `clasp push`. Jangan simpan ID spreadsheet produksi atau data pribadi dalam repositori publik.
