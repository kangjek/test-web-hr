# Portal Cuti HR — Google Apps Script

Portal web-app untuk Google Sites: karyawan masuk dengan **email atau nomor ID karyawan dan password**, lalu hanya dapat mengakses profil, saldo, dan pengajuan miliknya. HRGA mendapat administrasi akun serta approval. Autentikasi tidak lagi bergantung pada `Session.getActiveUser()`, sehingga web app tetap dapat dibuka saat identitas akun Google tidak tersedia.

## Konfigurasi master spreadsheet

1. Buat Google Spreadsheet master, lalu salin ID pada URL-nya ke `CONFIG.SPREADSHEET_ID` di `Code.gs`.
2. Di editor Apps Script, jalankan `setupMasterSheets` sekali dan beri otorisasi. Untuk spreadsheet baru, fungsi itu membuat header berikut:
   - `Employees`: `ID Karyawan, Email, Nama, Departemen, Role, Saldo Cuti, Aktif, Password Hash, Password Salt`
   - `LeaveRequests`: `ID, Email, Jenis Cuti, Tanggal Mulai, Tanggal Selesai, Durasi, Alasan, Status, Approver, Timestamp`
   - `LeaveBalanceHistory`: `Timestamp, Email, Perubahan, Saldo Sebelum, Saldo Sesudah, Referensi, Aktor`
   - `AuditLog`: `Timestamp, Aktor, Aksi, Entitas, ID Entitas, Detail`
3. Untuk spreadsheet dari versi sebelumnya, `setupMasterSheets` menyisipkan kolom **ID Karyawan** dan menambahkan kolom hash/salt password tanpa mengubah data karyawan yang ada. Untuk admin HRGA pertama yang belum memiliki password, gunakan tautan **Admin HRGA belum punya password?** pada halaman login untuk mengatur password sendiri. Tautan ini hanya berlaku sekali untuk akun HRGA aktif yang belum memiliki password. Setelah masuk, HRGA dapat mengelola password akun lain melalui menu administrasi.
4. Tambahkan setidaknya satu akun HRGA dengan **Role** atau **Departemen** bernilai `HRGA`, serta email yang valid. Akun tersebut menerima permohonan reset password melalui `MailApp` dan dapat mengganti password karyawan pada menu **Administrasi HRGA**.

## Login dan reset password

* Karyawan memasukkan email **atau** ID karyawan serta password. Password tidak disimpan dalam teks biasa: yang tersimpan di sheet adalah hash SHA-256 dengan salt unik.
* Akun HRGA aktif tanpa password dapat menetapkan password awalnya sendiri dari halaman login. Akun yang sudah memiliki password harus masuk seperti biasa atau menggunakan alur reset password.
* Sesi login memakai token acak di Script Cache selama enam jam. Operasi pengajuan, approval, dan administrasi selalu memvalidasi token dan peran di server.
* Tombol **Lupa password?** mengirim email permohonan reset kepada semua akun HRGA aktif. Untuk privasi, layar selalu menunjukkan respons yang sama, baik akun ditemukan maupun tidak.

## Deployment dan Google Sites

1. Di Apps Script, **Deploy → New deployment → Web app**. Jalankan sebagai pengguna yang mendeploy; akun tersebut membutuhkan akses editor ke spreadsheet master dan izin mengirim email melalui `MailApp`.
2. Karena portal menggunakan login internal, deployment dapat diakses oleh pengguna yang diperlukan tanpa mengandalkan email Google yang diteruskan oleh Apps Script. Tetap batasi akses deployment sesuai kebijakan organisasi.
3. Salin URL deployment. Di Google Sites, pilih **Insert → Embed → By URL**, lalu masukkan URL tersebut. `doGet` menggunakan `ALLOWALL` agar dapat dibingkai oleh Sites.

## Sinkronisasi dan audit

* Jalankan `createSyncTrigger` sekali untuk trigger setiap jam yang menjalankan `syncMasterData`; fungsi ini memastikan struktur sheet dan menyegarkan cache metadata.
* Buat **installable trigger** untuk `onMasterSheetEdit` dari spreadsheet master bila data sering diubah langsung. Trigger tersebut membuang cache saat sheet master berubah.
* Setiap login, permohonan reset, pengajuan, status approval, mutasi saldo, dan perubahan akun ditulis ke `AuditLog`; mutasi saldo juga dicatat di `LeaveBalanceHistory`. Approval memakai `LockService` dan memeriksa status kembali, sehingga saldo tidak bisa terpotong dua kali.

## Pengembangan lokal

Gunakan [clasp](https://github.com/google/clasp) untuk push file ini ke proyek Apps Script, misalnya `clasp push`. Jangan simpan ID spreadsheet produksi atau data pribadi dalam repositori publik.
