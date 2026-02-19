# RemindCare WhatsApp Bot

Bot WhatsApp sederhana untuk mengingatkan ibu hamil minum tablet FE setiap hari.

## Menjalankan
1. Install dependency:
   - npm install
2. Jalankan bot:
   - npm start
3. Scan QR di terminal dengan WhatsApp.

Data tersimpan di `data/remindcare.db` (SQLite).

Durasi pengingat default sampai 42 minggu (bisa diubah lewat env `PREGNANCY_WEEKS_LIMIT`).

## Perintah cepat
- start
- stop
- ubah jam 17:00
