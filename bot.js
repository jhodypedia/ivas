require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const cheerio = require('cheerio');
const sqlite3 = require('sqlite3').verbose();
const { promisify } = require('util');

// ==========================================
// ⚙️ KONFIGURASI SISTEM
// ==========================================
const BOT_TOKEN = process.env.BOT_TOKEN;
const SUPERADMIN_ID = parseInt(process.env.SUPERADMIN_ID);
const FLARE_URL = process.env.FLARE_URL || 'http://localhost:8191/v1';
const BASE_URL = 'https://www.ivasms.com';

if (!BOT_TOKEN || !SUPERADMIN_ID) {
    console.error('❌ ERROR: BOT_TOKEN dan SUPERADMIN_ID wajib diisi di file .env!');
    process.exit(1);
}

// ==========================================
// 📦 INISIALISASI DATABASE SQLITE
// ==========================================
const db = new sqlite3.Database('pansa_otp.db');
const dbRun = promisify(db.run).bind(db);
const dbGet = promisify(db.get).bind(db);
const dbAll = promisify(db.all).bind(db);

async function initDb() {
    await dbRun(`
        CREATE TABLE IF NOT EXISTS users (
            telegram_id INTEGER PRIMARY KEY,
            role TEXT DEFAULT 'admin',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);
    
    // Perombakan Tabel untuk Support Multi-Account iVAS
    await dbRun(`
        CREATE TABLE IF NOT EXISTS ivas_accounts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE,
            ivas_sms_session TEXT,
            xsrf_token TEXT,
            cf_clearance TEXT,
            csrf_token TEXT,
            user_agent TEXT,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);
}

// ==========================================
// 🤖 INISIALISASI BOT
// ==========================================
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// ==========================================
// 🛠️ FUNGSI HELPER & AUTH
// ==========================================
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function isAuthorized(userId) {
    if (userId === SUPERADMIN_ID) return { authorized: true, role: 'superadmin' };
    const row = await dbGet('SELECT role FROM users WHERE telegram_id = ?', [userId]);
    if (row) return { authorized: true, role: row.role };
    return { authorized: false, role: null };
}

function extractOTP(text) {
    const otpRegex = /\b\d{4,6}\b/; 
    const match = text.match(otpRegex);
    return match ? match[0] : 'Tidak terdeteksi';
}

function buildCookieString(account) {
    return Object.entries({ 
        ivas_sms_session: account.ivas_sms_session, 
        'XSRF-TOKEN': account.xsrf_token, 
        cf_clearance: account.cf_clearance 
    }).map(([k, v]) => `${k}=${v}`).join('; ');
}

// ==========================================
// 🕸️ CORE SCRAPER (FLARESOLVERR & AXIOS)
// ==========================================
async function flareGet(url, cookies = null) {
    const payload = { cmd: 'request.get', url: url, maxTimeout: 120000 };
    if (cookies) {
        payload.cookies = Object.entries(cookies)
            .filter(([_, v]) => v !== null)
            .map(([k, v]) => ({ name: k, value: v }));
    }
    const res = await axios.post(FLARE_URL, payload);
    if (res.data.status !== 'ok') throw new Error(`FlareSolverr: ${res.data.message}`);
    return res.data.solution;
}

async function refreshCfClearance(accountName, ivas, xsrf) {
    const sol = await flareGet(BASE_URL);
    const cf = sol.cookies.find(c => c.name === 'cf_clearance');
    const cfValue = cf ? cf.value : null;

    const cookiesTemp = { ivas_sms_session: ivas, 'XSRF-TOKEN': xsrf, cf_clearance: cfValue };
    const solPortal = await flareGet(`${BASE_URL}/portal`, cookiesTemp);
    const $ = cheerio.load(solPortal.response);
    const csrfToken = $('meta[name="csrf-token"]').attr('content') || null;

    await dbRun(`
        INSERT INTO ivas_accounts (name, ivas_sms_session, xsrf_token, cf_clearance, csrf_token, user_agent, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(name) DO UPDATE SET
            ivas_sms_session=excluded.ivas_sms_session,
            xsrf_token=excluded.xsrf_token,
            cf_clearance=excluded.cf_clearance,
            csrf_token=excluded.csrf_token,
            user_agent=excluded.user_agent,
            updated_at=CURRENT_TIMESTAMP
    `, [accountName, ivas, xsrf, cfValue, csrfToken, sol.userAgent]);

    return { csrfToken, userAgent: sol.userAgent };
}

async function autoRefreshSessionsOnStartup() {
    console.log('🔄 [PANSA BOOT] Sinkronisasi Multi-Account di database...');
    try {
        const accounts = await dbAll('SELECT * FROM ivas_accounts');
        if (accounts.length === 0) return console.log('ℹ️ [PANSA BOOT] Belum ada akun terdaftar.');
        
        for (const acc of accounts) {
            try {
                await refreshCfClearance(acc.name, acc.ivas_sms_session, acc.xsrf_token);
                console.log(`✅ [PANSA BOOT] Akun iVAS: [${acc.name}] Siap.`);
            } catch (err) {
                console.error(`❌ [PANSA BOOT] Gagal auto-login Akun: [${acc.name}]`);
            }
            await delay(2000);
        }
    } catch (error) {
        console.error('❌ Error startup:', error.message);
    }
}

// ==========================================
// 🎨 TEMPLATE UI & INLINE KEYBOARDS
// ==========================================
const UI = {
    header: (title) => `🪐 <b>PANSA GROUP • ${title.toUpperCase()}</b>\n━━━━━━━━━━━━━━━━━━━━━━\n`,
    divider: `━━━━━━━━━━━━━━━━━━━━━━\n`,
    footer: `⚡ <i>Powered by Pansa Labs</i>\n👨‍💻 <b>Founder:</b> @pansagr`,
    error: (msg) => `⚠️ <b>SYSTEM ERROR</b>\n<code>${msg}</code>`
};

const KEYBOARDS = {
    mainMenu: (role) => {
        const kb = [
            [{ text: '🔍 Dapatkan OTP', callback_data: 'btn_get_otp' }, { text: '📱 Daftar Nomor', callback_data: 'btn_mynumbers' }],
            [{ text: '💰 Cek Saldo Total', callback_data: 'btn_balance' }, { text: '🔄 Status Multi-Akun', callback_data: 'btn_status' }],
            [{ text: '⚙️ Tambah Akun / Cookie', callback_data: 'btn_howto_cookie' }],
            [{ text: '👨‍💻 Hubungi Founder', url: 'https://t.me/pansagr' }]
        ];
        if (role === 'superadmin') {
            kb.push([{ text: '👑 Admin Console', callback_data: 'btn_admin' }]);
        }
        return { reply_markup: { inline_keyboard: kb } };
    },
    backButton: {
        reply_markup: { inline_keyboard: [[{ text: '🔙 Kembali ke Dashboard', callback_data: 'btn_main' }]] }
    }
};

// ==========================================
// 📱 FUNGSI NAVIGASI MENU (SPA STYLE)
// ==========================================
async function renderMainMenu(chatId, userId, messageId = null) {
    const auth = await isAuthorized(userId);
    let text = UI.header('Sistem Multi-Node');
    text += `🔹 <b>User ID:</b> <code>${userId}</code>\n`;
    text += `🔹 <b>Akses:</b> ${auth.authorized ? `✅ Whitelisted (<b>${auth.role.toUpperCase()}</b>)` : '❌ Guest'}\n`;
    text += UI.divider;

    if (!auth.authorized) {
        text += `📢 Akses ditolak. Hubungi Founder @pansagr untuk mendaftarkan ID Telegram Anda ke dalam sistem.\n`;
        text += UI.divider + UI.footer;
        if (messageId) return bot.editMessageText(text, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' });
        return bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
    }

    text += `Pilih menu pada panel interaktif di bawah ini untuk mengoperasikan sistem jaringan Multi-Account.\n`;
    text += UI.divider + UI.footer;
    const opts = { parse_mode: 'HTML', ...KEYBOARDS.mainMenu(auth.role) };

    if (messageId) {
        bot.editMessageText(text, { chat_id: chatId, message_id: messageId, ...opts }).catch(()=>{});
    } else {
        bot.sendMessage(chatId, text, opts);
    }
}

// ==========================================
// 🔄 LOGIKA INTI MULTI-ACCOUNT LIVE TRACKING
// ==========================================
async function processOtpTracking(chatId, userId, fullNumber) {
    const accounts = await dbAll('SELECT * FROM ivas_accounts');
    if (accounts.length === 0) {
        return bot.sendMessage(chatId, UI.header('Sistem Kosong') + `❌ Belum ada akun iVAS yang tertaut di database.\n` + UI.divider + UI.footer, { parse_mode: 'HTML' });
    }

    let currentStatusMsg = await bot.sendMessage(chatId, `📡 <b>[PANSA RADAR]</b> Memindai kepemilikan nomor <code>${fullNumber}</code> di <b>${accounts.length} Akun</b>...`, { parse_mode: 'HTML' });

    let targetAccount = null;
    const dateStr = new Date().toISOString().split('T')[0];

    // TAHAP 1: AUTO-ROUTING (Cari akun mana yang memiliki nomor ini)
    for (const acc of accounts) {
        try {
            const params = new URLSearchParams({ draw: 1, start: 0, length: 2000, 'search[value]': '' });
            const res = await axios.get(`${BASE_URL}/portal/numbers?${params.toString()}`, {
                headers: { 'User-Agent': acc.user_agent, 'X-Requested-With': 'XMLHttpRequest', 'Cookie': buildCookieString(acc) }
            });
            
            if (res.status === 200 && res.data?.data) {
                // Cek apakah nomor target (full number) ada di akun ini
                const found = res.data.data.find(item => item.Number.toString() === fullNumber);
                if (found) {
                    targetAccount = acc;
                    break;
                }
            }
        } catch (e) { /* Lanjut cek akun berikutnya jika terjadi error */ }
    }

    if (!targetAccount) {
        bot.deleteMessage(chatId, currentStatusMsg.message_id).catch(() => {});
        return bot.sendMessage(chatId, UI.header('Hasil Radar') + `📭 Nomor <code>${fullNumber}</code> tidak ditemukan di semua akun yang terdaftar.\n` + UI.divider + UI.footer, { parse_mode: 'HTML' });
    }

    // TAHAP 2: Live Tracking di Akun Target
    const MAX_ATTEMPTS = 20; 
    let otpFound = false;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        await bot.editMessageText(
            `🛰️ <b>[PANSA TRACKING]</b>\n${UI.divider}🎯 <b>Target:</b> <code>${fullNumber}</code>\n🗄️ <b>Akun:</b> <code>[${targetAccount.name}]</code>\n🔄 <b>Status:</b> Menunggu OTP masuk...\n⏱️ <b>Percobaan:</b> <code>[${attempt}/${MAX_ATTEMPTS}]</code>`,
            { chat_id: chatId, message_id: currentStatusMsg.message_id, parse_mode: 'HTML' }
        ).catch(() => {});

        const payload = new URLSearchParams({ 
            '_token': targetAccount.csrf_token, 'start': dateStr, 'end': dateStr, 'Number': fullNumber, 'Range': '' 
        });

        try {
            const res = await axios.post(`${BASE_URL}/portal/sms/received/getsms/number/sms`, payload.toString(), {
                headers: {
                    'User-Agent': targetAccount.user_agent, 'X-Requested-With': 'XMLHttpRequest', 'Referer': `${BASE_URL}/portal/sms/received`, 'Origin': BASE_URL,
                    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'Cookie': buildCookieString(targetAccount)
                }
            });

            if (res.status === 200) {
                const $2 = cheerio.load(res.data);
                let latestSms = null;
                
                $2('tbody tr').each((i, row) => {
                    const text = $2(row).find('.msg-text').text().trim();
                    if (text) {
                        const sender = $2(row).find('.cli-tag').text().trim();
                        const time = $2(row).find('.time-cell').text().trim();
                        latestSms = { sender: sender || 'Unknown', text, time };
                        return false; 
                    }
                });

                if (latestSms) {
                    otpFound = true;
                    bot.deleteMessage(chatId, currentStatusMsg.message_id).catch(() => {});
                    
                    let replyMsg = UI.header(`OTP TEMBUS`);
                    replyMsg += `📱 <b>Target:</b> <code>${fullNumber}</code>\n`;
                    replyMsg += `🏢 <b>Pengirim:</b> <b>${latestSms.sender}</b>\n`;
                    replyMsg += `💬 <b>Pesan:</b>\n<code>${latestSms.text}</code>\n\n`;
                    replyMsg += `🔑 <b>KODE OTP:</b>\n<code>${extractOTP(latestSms.text)}</code>\n\n`;
                    replyMsg += `🕐 <b>Waktu:</b> <i>${latestSms.time}</i>\n`;
                    replyMsg += `🗄️ <b>Via Akun:</b> <i>${targetAccount.name}</i>\n`;
                    replyMsg += UI.divider + UI.footer;

                    bot.sendMessage(chatId, replyMsg, { parse_mode: 'HTML' });
                    break;
                }
            }
        } catch(e) {}
        await delay(4000); 
    }

    if (!otpFound) {
        bot.deleteMessage(chatId, currentStatusMsg.message_id).catch(() => {});
        bot.sendMessage(chatId, UI.header('Timeout') + `⏱️ <b>Batas Waktu Habis</b>\nOTP tidak tiba di nomor <code>${fullNumber}</code> setelah 80 detik.\nKirim ulang dari aplikasi, lalu ulangi proses.\n` + UI.divider + UI.footer, { parse_mode: 'HTML' });
    }
}

// ==========================================
// 💬 TELEGRAM COMMAND HANDLERS
// ==========================================

// --- COMMAND: /start ---
bot.onText(/\/start/, (msg) => renderMainMenu(msg.chat.id, msg.from.id));

// --- BUTTON CLICK HANDLER (CALLBACK QUERIES) ---
bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;
    const userId = query.from.id;
    const action = query.data;

    const auth = await isAuthorized(userId);
    if (!auth.authorized) return bot.answerCallbackQuery(query.id, { text: 'Akses Ditolak!', show_alert: true });

    try {
        if (action === 'btn_main') {
            await renderMainMenu(chatId, userId, messageId);
        } 
        
        // --- BUTTON: GET OTP (FULL NUMBER FORCE REPLY) ---
        else if (action === 'btn_get_otp') {
            bot.deleteMessage(chatId, messageId).catch(() => {}); 
            bot.sendMessage(chatId, `🔍 <b>Silakan balas (reply) pesan ini dengan FULL NOMOR target Anda:</b>\n(Contoh: 6281234567890)`, {
                parse_mode: 'HTML',
                reply_markup: { force_reply: true, selective: true }
            });
        }
        
        else if (action === 'btn_status') {
            const accounts = await dbAll('SELECT name, updated_at FROM ivas_accounts');
            let text = UI.header('Status Multi-Akun');
            if (accounts.length === 0) {
                text += `❌ <b>Sistem Kosong:</b> Belum ada akun yang terdaftar.\n`;
            } else {
                text += `🟢 <b>Terdapat ${accounts.length} Akun Aktif:</b>\n\n`;
                accounts.forEach((acc, idx) => {
                    text += `<b>${idx+1}. [${acc.name}]</b>\n⏳ Sync: <code>${acc.updated_at}</code>\n\n`;
                });
            }
            text += UI.divider + UI.footer;
            bot.editMessageText(text, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', ...KEYBOARDS.backButton });
        } 

        else if (action === 'btn_mynumbers') {
            bot.answerCallbackQuery(query.id, { text: 'Mengumpulkan data dari semua akun...', show_alert: false });
            const accounts = await dbAll('SELECT * FROM ivas_accounts');
            if (accounts.length === 0) return;
        
            let allNumbers = [];
            for (const acc of accounts) {
                try {
                    const params = new URLSearchParams({ draw: 1, start: 0, length: 2000, 'search[value]': '' });
                    const res = await axios.get(`${BASE_URL}/portal/numbers?${params.toString()}`, {
                        headers: { 'User-Agent': acc.user_agent, 'X-Requested-With': 'XMLHttpRequest', 'Cookie': buildCookieString(acc) }
                    });
                    if (res.status === 200 && res.data?.data) {
                        res.data.data.forEach(item => allNumbers.push(`<code>${item.Number}</code> (<i>${acc.name}</i>)`));
                    }
                } catch(e) {}
            }
        
            let text = UI.header(`Daftar Nomor (${allNumbers.length})`);
            if (allNumbers.length > 0) {
                allNumbers.slice(0, 30).forEach((num, i) => text += `${i + 1}. ${num}\n`);
                if(allNumbers.length > 30) text += `\n<i>... dan ${allNumbers.length - 30} nomor lainnya.</i>\n`;
            } else {
                text += `📭 Tidak ada nomor aktif di semua akun.\n`;
            }
            text += UI.divider + UI.footer;
            bot.editMessageText(text, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', ...KEYBOARDS.backButton });
        }

        else if (action === 'btn_balance') {
            bot.answerCallbackQuery(query.id, { text: 'Mengkalkulasi saldo semua akun...', show_alert: false });
            const accounts = await dbAll('SELECT * FROM ivas_accounts');
            
            let text = UI.header('Balance Multi-Akun');
            for (const acc of accounts) {
                try {
                    const sol = await flareGet(`${BASE_URL}/portal/sms/received`, { ivas_sms_session: acc.ivas_sms_session, 'XSRF-TOKEN': acc.xsrf_token, cf_clearance: acc.cf_clearance });
                    const $ = cheerio.load(sol.response);
                    let revenue = $('div:contains("REVENUE")').parent().find('.text-white, .font-bold').text().trim() || 'N/A';
                    text += `🗄️ <b>Akun:</b> <code>${acc.name}</code>\n💰 Saldo: <b>${revenue}</b>\n\n`;
                } catch (e) {
                    text += `🗄️ <b>Akun:</b> <code>${acc.name}</code>\n⚠️ Gagal memuat data.\n\n`;
                }
            }
            if (accounts.length === 0) text += `❌ Belum ada akun terdaftar.\n`;
            text += UI.divider + UI.footer;
            bot.editMessageText(text, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', ...KEYBOARDS.backButton });
        }

        else if (action === 'btn_howto_cookie') {
            let text = UI.header('Cara Set Multi-Akun');
            text += `Tambahkan akun iVAS ke dalam sistem dengan perintah:\n\n`;
            text += `👉 <code>/setcookies [NAMA_AKUN] [ivas_session] [XSRF-TOKEN]</code>\n\n`;
            text += `<b>Contoh:</b>\n<code>/setcookies AKUN_UTAMA eyJpd... VZDLZ...</code>\n\n`;
            text += `<i>Anda bisa menambahkan puluhan akun berbeda ke dalam 1 bot ini.</i>\n`;
            text += UI.divider + UI.footer;
            bot.editMessageText(text, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', ...KEYBOARDS.backButton });
        }

        else if (action === 'btn_admin' && auth.role === 'superadmin') {
            const rows = await dbAll('SELECT telegram_id, created_at FROM users WHERE role = "admin"');
            let text = UI.header('Admin Console');
            text += `<b>Cara Tambah Admin:</b>\nKetik: <code>/addadmin [ID_TELEGRAM]</code>\n\n`;
            text += `📋 <b>Daftar Admin Aktif:</b>\n`;
            if (rows.length === 0) {
                text += `<i>Belum ada admin yang terdaftar.</i>\n`;
            } else {
                rows.forEach((row, i) => { text += `${i + 1}. <code>${row.telegram_id}</code>\n`; });
            }
            text += UI.divider + UI.footer;
            bot.editMessageText(text, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', ...KEYBOARDS.backButton });
        }

        bot.answerCallbackQuery(query.id); 
    } catch (e) {
        bot.answerCallbackQuery(query.id, { text: 'Terjadi Kesalahan!', show_alert: true });
    }
});


// --- MESSAGE LISTENER (Menangkap input FULL NOMOR untuk OTP) ---
bot.on('message', async (msg) => {
    if (msg.text && msg.text.startsWith('/')) return;

    // Deteksi jika user membalas pesan "FULL NOMOR"
    if (msg.reply_to_message && msg.reply_to_message.text && msg.reply_to_message.text.includes('FULL NOMOR')) {
        const fullNumber = msg.text.replace(/\D/g, ''); // Hapus semua karakter selain angka (contoh: + atau spasi)
        
        // Validasi input panjang nomor (minimal 8 digit)
        if (fullNumber.length < 8) {
            return bot.sendMessage(msg.chat.id, "❌ <b>Format salah!</b> Harap masukkan nomor lengkap yang valid (tanpa +).", { parse_mode: 'HTML' });
        }

        const auth = await isAuthorized(msg.from.id);
        if (!auth.authorized) return;

        // Eksekusi Live Tracking Multi-Account
        await processOtpTracking(msg.chat.id, msg.from.id, fullNumber);
    }
});


// --- COMMAND: /addadmin (Superadmin Only) ---
bot.onText(/\/addadmin\s+(\d+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const targetId = parseInt(match[1]);

    if (userId !== SUPERADMIN_ID) return;
    try {
        await dbRun('INSERT INTO users (telegram_id, role) VALUES (?, "admin") ON CONFLICT(telegram_id) DO UPDATE SET role="admin"', [targetId]);
        bot.sendMessage(chatId, UI.header('Admin Added') + `🎯 <b>Admin Berhasil Ditambahkan</b>\n🔹 <b>Telegram ID:</b> <code>${targetId}</code>\n` + UI.divider + UI.footer, { parse_mode: 'HTML' });
    } catch (e) { bot.sendMessage(chatId, UI.error(e.message), { parse_mode: 'HTML' }); }
});


// --- COMMAND: /setcookies <NamaAkun> <ivas> <xsrf> ---
bot.onText(/\/setcookies\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const auth = await isAuthorized(userId);
    if (!auth.authorized) return;

    const accountName = match[1].trim();
    const ivasSession = match[2].trim();
    const xsrfToken = match[3].trim();

    const loadingMsg = await bot.sendMessage(chatId, `⏳ <b>[PANSA SYSTEM]</b> Menautkan Akun <b>[${accountName}]</b> ke sistem & mem-bypass proteksi...`, { parse_mode: 'HTML' });

    try {
        const data = await refreshCfClearance(accountName, ivasSession, xsrfToken);
        let text = UI.header('Akun Terhubung');
        text += `✅ <b>Akun [${accountName}] Berhasil Ditambahkan!</b>\n\n🔑 <b>CSRF Token:</b>\n<code>${data.csrfToken ? data.csrfToken.substring(0, 24) : 'N/A'}...</code>\n🌐 <b>Kapasitas Node:</b> Bertambah.\n` + UI.divider + UI.footer;
        bot.deleteMessage(chatId, loadingMsg.message_id).catch(() => {});
        bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
    } catch (e) {
        bot.deleteMessage(chatId, loadingMsg.message_id).catch(() => {});
        bot.sendMessage(chatId, UI.error(e.message), { parse_mode: 'HTML' });
    }
});


// Fallback /otp manual menggunakan Full Nomor (opsional)
bot.onText(/\/otp\s+(\d+)/, async (msg, match) => {
    const auth = await isAuthorized(msg.from.id);
    if (!auth.authorized) return;
    const fullNumber = match[1];
    if(fullNumber.length < 8) return bot.sendMessage(msg.chat.id, "❌ Harap masukkan FULL NOMOR. Contoh: /otp 6281234567890", { parse_mode: 'HTML' });
    await processOtpTracking(msg.chat.id, msg.from.id, fullNumber);
});

// ==========================================
// 🚀 BOOTSTRAP (STARTUP)
// ==========================================
async function bootstrap() {
    await initDb();
    await autoRefreshSessionsOnStartup();
    console.log('🤖 PANSA GROUP OTP Bot (Multi-Node Edition) berjalan...');
}
bootstrap().catch(console.error);
