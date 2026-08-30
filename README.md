# remindcare

![node.js](https://img.shields.io/badge/node.js-20%2B-339933?style=flat-square&logo=nodedotjs&logoColor=white)
![whatsapp](https://img.shields.io/badge/whatsapp-web.js-25d366?style=flat-square&logo=whatsapp&logoColor=white)
![sqlite](https://img.shields.io/badge/database-sqlite-003b57?style=flat-square&logo=sqlite&logoColor=white)
![license](https://img.shields.io/badge/license-restricted-f59e0b?style=flat-square)

bot whatsapp untuk mengingatkan konsumsi tablet fe setiap hari.

## status

`v1.0.0` | personal healthtech project

sistem ini adalah alat pengingat. bukan pengganti tenaga kesehatan dan bukan alat diagnosis.

## fitur

- reminder konsumsi tablet fe
- pengaturan jam reminder
- informasi hpl dan fase kehamilan
- validasi tanggal persalinan
- reminder masa nifas
- reminder kelas ibu
- penyimpanan lokal sqlite
- command `start`, `stop`, `info`, `edit data`, dan `batal`

## install

```bash
npm install
cp .env.example .env
npm test
npm start
```

scan qr whatsapp dari terminal saat aplikasi dimulai.

## konfigurasi

- `pregnancy_weeks_limit`: batas reminder kehamilan
- credential whatsapp dikelola oleh whatsapp web session
- database lokal berada di `data/remindcare.db`

jangan commit `.env`, database, atau folder session whatsapp.

## test

```bash
npm test
```

## data dan privacy

repository ini tidak menyertakan database pengguna. data aplikasi bersifat sensitif dan harus disimpan di deployment privat dengan akses terbatas.

## dokumentasi

- [changelog](CHANGELOG.md)
- [roadmap](ROADMAP.md)

## license

restricted use. penggunaan, modifikasi, dan redistribusi harus mendapat izin tertulis dari azra hudaya. lihat [license.md](LICENSE.md).
