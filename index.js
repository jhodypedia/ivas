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
    
    await dbRun(`
        CREATE TABLE IF NOT EXISTS sessions (
            telegram_id INTEGER PRIMARY KEY,
            ivas_sms_session TEXT,
            xsrf_token TEXT,
            cf_clearance TEXT,
            csrf_token TEXT,
            user_agent TEXT,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(telegram_id) REFERENCES users(telegram_id)
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

async function refreshCfClearance(userId, ivas, xsrf) {
    const sol = await flareGet(BASE_URL);
    const cf = sol.cookies.find(c => c.name === 'cf_clearance');
    const cfValue = cf ? cf.value : null;

    const cookiesTemp = { ivas_sms_session: ivas, 'XSRF-TOKEN': xsrf, cf_clearance: cfValue };
    const solPortal = await flareGet(`${BASE_URL}/portal`, cookiesTemp);
    const $ = cheerio.load(solPortal.response);
    const csrfToken = $('meta[name="csrf-token"]').attr('content') || null;

    await dbRun(`
        INSERT INTO sessions (telegram_id, ivas_sms_session, xsrf_token, cf_clearance, csrf_token, user_agent, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(telegram_id) DO UPDATE SET
            ivas_sms_session=excluded.ivas_sms_session,
            xsrf_token=excluded.xsrf_token,
            cf_clearance=excluded.cf_clearance,
            csrf_token=excluded.csrf_token,
            user_agent=excluded.user_agent,
            updated_at=CURRENT_TIMESTAMP
    `, [userId, ivas, xsrf, cfValue, csrfToken, sol.userAgent]);

    return { csrfToken, userAgent: sol.userAgent };
}

async function autoRefreshSessionsOnStartup() {
    console.log('🔄 [PANSA BOOT] Sinkronisasi sesi di database...');
    try {
        const activeSessions = await dbAll('SELECT * FROM sessions');
        for (const session of activeSessions) {
            try {
                await refreshCfClearance(session.telegram_id, session.ivas_sms_session, session.xsrf_token);
                console.log(`✅ [PANSA BOOT] Sesi User ID: ${session.telegram_id} Siap.`);
            } catch (err) {
                console.error(`❌ [PANSA BOOT] Gagal auto-login ID: ${session.telegram_id}`);
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
            [{ text: '🔍 Lacak Kode OTP', callback_data: 'btn_howto_otp' }, { text: '🔄 Cek Status Sesi', callback_data: 'btn_status' }],
            [{ text: '⚙️ Konfigurasi Cookies', callback_data: 'btn_howto_cookie' }],
            [{ text: '👨‍💻 Hubungi Founder', url: 'https://t.me/pansagr' }]
        ];
        if (role === 'superadmin') {
            kb.push([{ text: '👑 Admin Console (Superadmin)', callback_data: 'btn_admin' }]);
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
    let text = UI.header('Dashboard Utama');
    text += `🔹 <b>User ID:</b> <code>${userId}</code>\n`;
    text += `🔹 <b>Akses:</b> ${auth.authorized ? `✅ Whitelisted (<b>${auth.role.toUpperCase()}</b>)` : '❌ Guest'}\n`;
    text += UI.divider;

    if (!auth.authorized) {
        text += `📢 Akses ditolak. Hubungi Founder @pansagr untuk mendaftarkan ID Telegram Anda ke dalam sistem.\n`;
        text += UI.divider + UI.footer;
        if (messageId) {
            return bot.editMessageText(text, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' });
        }
        return bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
    }

    text += `Pilih menu pada panel interaktif di bawah ini untuk mengoperasikan sistem.\n`;
    text += UI.divider + UI.footer;
    const opts = { parse_mode: 'HTML', ...KEYBOARDS.mainMenu(auth.role) };

    if (messageId) {
        bot.editMessageText(text, { chat_id: chatId, message_id: messageId, ...opts }).catch(()=>{});
    } else {
        bot.sendMessage(chatId, text, opts);
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
        
        else if (action === 'btn_status') {
            const session = await dbGet('SELECT updated_at FROM sessions WHERE telegram_id = ?', [userId]);
            let text = UI.header('Status Koneksi');
            if (!session) {
                text += `❌ <b>Sesi Kosong:</b> Anda belum menautkan Cookie.\n`;
            } else {
                text += `🟢 <b>Sesi Terhubung & Aktif</b>\n\n`;
                text += `▪️ <b>User ID:</b> <code>${userId}</code>\n`;
                text += `▪️ <b>Sinkronisasi Terakhir:</b>\n<code>${session.updated_at}</code>\n`;
            }
            text += UI.divider + UI.footer;
            bot.editMessageText(text, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', ...KEYBOARDS.backButton });
        } 
        
        else if (action === 'btn_howto_otp') {
            let text = UI.header('Cara Melacak OTP');
            text += `Untuk mencari OTP dari nomor tertentu, Anda tidak perlu mengklik tombol, cukup ketik format perintah berikut di chat:\n\n`;
            text += `👉 <code>/otp 4-digit-terakhir</code>\n\n`;
            text += `<b>Contoh:</b>\nJika nomor target adalah 5916570<b>0241</b>, maka ketik:\n<code>/otp 0241</code>\n\n`;
            text += `<i>Sistem akan otomatis melakukan Live Tracking selama 80 detik.</i>\n`;
            text += UI.divider + UI.footer;
            bot.editMessageText(text, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', ...KEYBOARDS.backButton });
        }

        else if (action === 'btn_howto_cookie') {
            let text = UI.header('Cara Set Cookies');
            text += `Untuk menautkan sesi iVAS Anda, gunakan perintah:\n\n`;
            text += `👉 <code>/setcookies [ivas_session] [XSRF-TOKEN]</code>\n\n`;
            text += `<b>Contoh:</b>\n<code>/setcookies eyJpd... VZDLZ...</code>\n\n`;
            text += `<i>Cookie Anda akan dienkripsi dan diisolasi khusus untuk User ID Anda.</i>\n`;
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

        bot.answerCallbackQuery(query.id); // Matikan efek loading di tombol
    } catch (e) {
        bot.answerCallbackQuery(query.id, { text: 'Terjadi Kesalahan!', show_alert: true });
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
        let text = UI.header('Admin Added');
        text += `🎯 <b>Admin Berhasil Ditambahkan</b>\n🔹 <b>Telegram ID:</b> <code>${targetId}</code>\n` + UI.divider + UI.footer;
        bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
    } catch (e) { bot.sendMessage(chatId, UI.error(e.message), { parse_mode: 'HTML' }); }
});


// --- COMMAND: /setcookies ---
bot.onText(/\/setcookies\s+(.+)\s+(.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const auth = await isAuthorized(userId);
    if (!auth.authorized) return;

    const loadingMsg = await bot.sendMessage(chatId, `⏳ <b>[PANSA SYSTEM]</b> Mengamankan cookie & menembus FlareSolverr...`, { parse_mode: 'HTML' });

    try {
        const data = await refreshCfClearance(userId, match[1].trim(), match[2].trim());
        let text = UI.header('Sesi Terhubung');
        text += `✅ <b>Kredensial Sesi Berhasil Disimpan!</b>\n\n🔑 <b>CSRF Token:</b>\n<code>${data.csrfToken ? data.csrfToken.substring(0, 24) : 'N/A'}...</code>\n🌐 <b>Status DB:</b> Terisolasi.\n` + UI.divider + UI.footer;
        bot.deleteMessage(chatId, loadingMsg.message_id).catch(() => {});
        bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
    } catch (e) {
        bot.deleteMessage(chatId, loadingMsg.message_id).catch(() => {});
        bot.sendMessage(chatId, UI.error(e.message), { parse_mode: 'HTML' });
    }
});


// --- COMMAND: /otp (Live Tracking System) ---
bot.onText(/\/otp\s+(\d{4})/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const last4 = match[1];

    const auth = await isAuthorized(userId);
    if (!auth.authorized) return;

    const session = await dbGet('SELECT * FROM sessions WHERE telegram_id = ?', [userId]);
    if (!session || !session.ivas_sms_session) {
        return bot.sendMessage(chatId, UI.header('Sesi Kosong') + `❌ Cookies Anda belum di-set.` + '\n' + UI.divider + UI.footer, { parse_mode: 'HTML' });
    }

    let currentStatusMsg = await bot.sendMessage(chatId, `📡 <b>[PANSA RADAR]</b> Memulai pemindaian untuk nomor [<b>${last4}</b>]...`, { parse_mode: 'HTML' });

    const cookies = { ivas_sms_session: session.ivas_sms_session, 'XSRF-TOKEN': session.xsrf_token, cf_clearance: session.cf_clearance };
    const ua = session.user_agent || 'Mozilla/5.0';
    const csrf = session.csrf_token;
    const dateStr = new Date().toISOString().split('T')[0];
    const MAX_ATTEMPTS = 20; 
    let otpFound = false;

    try {
        // TAHAP 1: Ambil Full Number via FlareSolverr (Regex Match)
        const sol = await flareGet(`${BASE_URL}/portal/sms/received`, cookies);
        const allNumbers = sol.response.match(/\b\d{8,16}\b/g) || [];
        const finalNumbers = Array.from(new Set(allNumbers.filter(num => num.endsWith(last4))));

        if (finalNumbers.length === 0) {
            bot.deleteMessage(chatId, currentStatusMsg.message_id).catch(() => {});
            return bot.sendMessage(chatId, UI.header('Hasil Radar') + `📭 Tidak ditemukan nomor aktif dengan akhiran <b>${last4}</b>.\n` + UI.divider + UI.footer, { parse_mode: 'HTML' });
        }

        const targetNumber = finalNumbers[0];

        // TAHAP 2: Live Tracking via Axios
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            await bot.editMessageText(
                `🛰️ <b>[PANSA TRACKING]</b>\n${UI.divider}🎯 <b>Target:</b> <code>${targetNumber}</code>\n🔄 <b>Status:</b> Menunggu OTP...\n⏱️ <b>Percobaan:</b> <code>[${attempt}/${MAX_ATTEMPTS}]</code>\n<i>Mohon tunggu sebentar...</i>`,
                { chat_id: chatId, message_id: currentStatusMsg.message_id, parse_mode: 'HTML' }
            ).catch(() => {});

            const formData = new URLSearchParams();
            formData.append('_token', csrf); formData.append('start', dateStr); formData.append('end', dateStr); formData.append('Number', targetNumber); formData.append('Range', '');

            const res = await axios.post(`${BASE_URL}/portal/sms/received/getsms/number/sms`, formData, {
                headers: {
                    'User-Agent': ua, 'X-Requested-With': 'XMLHttpRequest', 'Referer': `${BASE_URL}/portal/sms/received`, 'Origin': BASE_URL,
                    'Content-Type': 'application/x-www-form-urlencoded', 'Cookie': Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ')
                }
            });

            const $2 = cheerio.load(res.data);
            let latestSms = null;
            $2('tbody tr').each((i, row) => {
                const cols = $2(row).find('td');
                if (cols.length >= 3) {
                    const text = $2(cols[1]).text().replace(/\s+/g, ' ').trim();
                    if (text) {
                        latestSms = { sender: $2(cols[0]).text().trim(), text, time: $2(cols[2]).text().trim() };
                        return false; 
                    }
                }
            });

            if (latestSms) {
                otpFound = true;
                bot.deleteMessage(chatId, currentStatusMsg.message_id).catch(() => {});
                
                let replyMsg = UI.header(`OTP TEMBUS`);
                replyMsg += `📱 <b>Target:</b> <code>${targetNumber}</code>\n`;
                replyMsg += `🏢 <b>Pengirim:</b> <b>${latestSms.sender}</b>\n`;
                replyMsg += `💬 <b>Pesan:</b>\n<code>${latestSms.text}</code>\n\n`;
                replyMsg += `🔑 <b>KODE OTP:</b>\n<code>${extractOTP(latestSms.text)}</code>\n\n`;
                replyMsg += `🕐 <b>Waktu:</b> <i>${latestSms.time}</i>\n`;
                replyMsg += UI.divider + UI.footer;

                bot.sendMessage(chatId, replyMsg, { parse_mode: 'HTML' });
                break;
            }
            await delay(4000); 
        }

        if (!otpFound) {
            bot.deleteMessage(chatId, currentStatusMsg.message_id).catch(() => {});
            bot.sendMessage(chatId, UI.header('Timeout') + `⏱️ <b>Batas Waktu Habis</b>\nOTP tidak tiba setelah 80 detik.\nKirim ulang dari aplikasi, lalu ketik /otp kembali.\n` + UI.divider + UI.footer, { parse_mode: 'HTML' });
        }
    } catch (e) {
        bot.deleteMessage(chatId, currentStatusMsg.message_id).catch(() => {});
        bot.sendMessage(chatId, UI.error(e.message), { parse_mode: 'HTML' });
    }
});

// ==========================================
// 🚀 BOOTSTRAP (STARTUP)
// ==========================================
async function bootstrap() {
    await initDb();
    await autoRefreshSessionsOnStartup();
    console.log('🤖 PANSA GROUP OTP Bot (Premium Edition) berjalan...');
}
bootstrap().catch(console.error);
