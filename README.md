# 🪐 PANSA GROUP OTP BOT

Bot Telegram premium berbasis Node.js untuk melakukan live tracking OTP dari iVASMS menggunakan integrasi:

- Telegram Bot API
- FlareSolverr
- Axios
- SQLite
- Cheerio

Bot ini mendukung:

✅ Multi user & multi session  
✅ Sistem whitelist admin  
✅ Auto refresh Cloudflare clearance  
✅ Live tracking OTP realtime  
✅ Inline menu Telegram modern  
✅ SQLite database persistence  
✅ Superadmin console  

---

# 📦 Features

- 🔍 Tracking OTP berdasarkan 4 digit terakhir nomor
- 🔐 Penyimpanan session cookies per user
- ☁️ Bypass Cloudflare menggunakan FlareSolverr
- 👑 Sistem role:
  - Superadmin
  - Admin
- 🗄️ Database SQLite ringan & cepat
- ⚡ Auto reconnect session saat bot restart
- 🎨 Tampilan UI Telegram premium

---

# 🛠️ Requirements

Pastikan VPS/server sudah terinstall:

- Node.js 18+
- npm
- FlareSolverr
- SQLite3

---

# 📥 Installation

## 1. Clone Project

```bash
git clone https://github.com/yourusername/pansa-otp-bot.git
cd pansa-otp-bot
```

---

## 2. Install Dependencies

```bash
npm install
```

Dependencies yang digunakan:

```bash
npm install dotenv node-telegram-bot-api axios cheerio sqlite3
```

---

# ⚙️ Setup Environment

Buat file `.env`

```env
BOT_TOKEN=ISI_BOT_TOKEN
SUPERADMIN_ID=ISI_TELEGRAM_ID
FLARE_URL=http://localhost:8191/v1
```

---

# 🤖 Cara Mendapatkan BOT_TOKEN

1. Buka Telegram
2. Cari BotFather
3. Jalankan:

```text
/newbot
```

4. Ikuti instruksi
5. Copy token bot

---

# 🆔 Cara Mendapatkan Telegram ID

Gunakan bot:

```text
@getmyid_bot
```

atau

```text
@userinfobot
```

---

# ☁️ Install FlareSolverr

## Docker (Recommended)

```bash
docker run -d \
  --name flaresolverr \
  -p 8191:8191 \
  ghcr.io/flaresolverr/flaresolverr:latest
```

Cek berjalan:

```bash
curl http://localhost:8191
```

---

# 🚀 Menjalankan Bot

```bash
node index.js
```

Jika berhasil:

```bash
🤖 PANSA GROUP OTP Bot (Premium Edition) berjalan...
```

---

# 📂 Struktur Database

Bot otomatis membuat database:

```text
pansa_otp.db
```

---

# 👑 Sistem Role

## Superadmin

Memiliki akses penuh:

- Menambahkan admin
- Melihat daftar admin
- Semua fitur bot

## Admin

Dapat:

- Tracking OTP
- Set cookies
- Cek status session

---

# 📱 Commands

## `/start`

Membuka dashboard utama.

---

## `/addadmin`

Menambahkan admin baru.

Format:

```bash
/addadmin 123456789
```

⚠️ Hanya superadmin.

---

## `/setcookies`

Menyimpan session iVAS.

Format:

```bash
/setcookies SESSION XSRF_TOKEN
```

---

## `/otp`

Melakukan live tracking OTP.

Format:

```bash
/otp 0241
```

Bot akan:

1. Scan nomor aktif
2. Cari nomor dengan 4 digit terakhir
3. Polling OTP realtime selama 80 detik
4. Mengambil kode OTP otomatis

---

# 🔄 Auto Session Refresh

Saat bot startup:

- Semua session di database akan dicek ulang
- Bot otomatis refresh:
  - `cf_clearance`
  - `csrf_token`
  - `user_agent`

---

# 🧠 Cara Kerja Sistem OTP

## Tahap 1 — Number Discovery

Bot mengambil semua nomor aktif dari:

```text
/portal/sms/received
```

Menggunakan:

- FlareSolverr
- Regex matching

---

## Tahap 2 — Live Tracking

Bot melakukan polling AJAX setiap 4 detik ke endpoint:

```text
/portal/sms/received/getsms/number/sms
```

Jika SMS ditemukan:

- Parsing HTML menggunakan Cheerio
- Ekstrak OTP otomatis
- Kirim hasil ke Telegram

---

# 🔐 Security

- Session diisolasi per user
- Tidak ada session sharing
- Menggunakan SQLite local database
- Auto validation role system

---

# 📦 PM2 Setup (Recommended)

Install PM2:

```bash
npm install -g pm2
```

Run bot:

```bash
pm2 start index.js --name pansa-otp
```

Save process:

```bash
pm2 save
```

Enable startup:

```bash
pm2 startup
```

---

# 📝 Logs

Melihat logs realtime:

```bash
pm2 logs pansa-otp
```

---

# ⚠️ Disclaimer

Project ini dibuat untuk kebutuhan pembelajaran, automasi, dan riset pribadi.

Gunakan dengan bijak dan tanggung jawab masing-masing.

---

# 👨‍💻 Developer

### PANSA GROUP

Founder:

```text
Jhody Pedia
```

---

# 📜 License

MIT License
