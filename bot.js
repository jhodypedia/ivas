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
// 📦 DATABASE SQLITE
// ==========================================
const db = new sqlite3.Database('pansa_otp.db');
db.run('PRAGMA journal_mode=WAL');
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
       CREATE TABLE IF NOT EXISTS ivas_accounts (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           name TEXT UNIQUE,
           ivas_sms_session TEXT,
           xsrf_token TEXT,
           cf_clearance TEXT,
           csrf_token TEXT,
           user_agent TEXT,
           session_valid INTEGER DEFAULT 1,
           updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
       )
   `);
}

// ==========================================
// 🤖 INISIALISASI BOT
// ==========================================
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// ==========================================
// 🛠 HELPER
// ==========================================
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function isAuthorized(userId) {
   if (userId === SUPERADMIN_ID) return { authorized: true, role: 'superadmin' };
   const row = await dbGet('SELECT role FROM users WHERE telegram_id = ?', [userId]);
   if (row) return { authorized: true, role: row.role };
   return { authorized: false, role: null };
}

function extractOTP(text) {
   const patterns = [/\b(\d{6})\b/, /\b(\d{5})\b/, /\b(\d{4})\b/];
   for (const p of patterns) {
       const m = text.match(p);
       if (m) return m[1];
   }
   return 'Tidak terdeteksi';
}

function buildCookieString(account) {
   const parts = [];
   if (account.ivas_sms_session) parts.push(`ivas_sms_session=${account.ivas_sms_session}`);
   if (account.xsrf_token) parts.push(`XSRF-TOKEN=${account.xsrf_token}`);
   if (account.cf_clearance) parts.push(`cf_clearance=${account.cf_clearance}`);
   return parts.join('; ');
}

// ==========================================
// 🎨 UI TEMPLATE & KEYBOARDS
// ==========================================
const UI = {
   header: (title) => `🪐 <b>PANSA GROUP • ${title.toUpperCase()}</b>\n━━━━━━━━━━━━━━━━━━━━━━\n`,
   divider: `━━━━━━━━━━━━━━━━━━━━━━\n`,
   footer: `⚡ <i>Powered by Pansa Labs</i>\n👨‍💻 <b>Founder:</b> @pansagr`,
   error: (msg) => `⚠️ <b>SYSTEM ERROR</b>\n<code>${msg}</code>`,
};

const KEYBOARDS = {
   mainMenu: (role) => {
       const kb = [
           [{ text: '🔍 Dapatkan OTP', callback_data: 'btn_get_otp' }, { text: '📱 Daftar Nomor', callback_data: 'btn_mynumbers' }],
           [{ text: '💰 Cek Saldo Total', callback_data: 'btn_balance' }, { text: '🔄 Status Multi-Akun', callback_data: 'btn_status' }],
           [{ text: '⚙️ Tambah/Update Akun iVAS', callback_data: 'btn_add_account' }],
           [{ text: '👨 Hubungi Founder', url: 'https://t.me/pansagr' }],
       ];
       if (role === 'superadmin') {
           kb.push([{ text: '👑 Admin Console', callback_data: 'btn_admin' }]);
       }
       return { reply_markup: { inline_keyboard: kb } };
   },
   backButton: {
       reply_markup: {
           inline_keyboard: [[{ text: '🔙 Kembali ke Dashboard', callback_data: 'btn_main' }]],
       },
   },
   adminConsole: {
       reply_markup: {
           inline_keyboard: [
               [{ text: '➕ Tambah Admin', callback_data: 'btn_add_admin_prompt' }],
               [{ text: '🗑️ Hapus Admin', callback_data: 'btn_del_admin_prompt' }],
               [{ text: '🔙 Kembali ke Dashboard', callback_data: 'btn_main' }],
           ],
       },
   },
   accountMenu: {
       reply_markup: {
           inline_keyboard: [
               [{ text: '🔄 Refresh Semua Akun', callback_data: 'btn_refresh_accounts' }],
               [{ text: '🗑️ Hapus Akun', callback_data: 'btn_del_account_prompt' }],
               [{ text: '🔙 Kembali ke Dashboard', callback_data: 'btn_main' }],
           ],
       },
   },
};

// ==========================================
// 📱 RENDER MAIN MENU
// ==========================================
async function renderMainMenu(chatId, userId, messageId = null) {
   const auth = await isAuthorized(userId);
   let text = UI.header('Sistem Multi-Node');
   text += `🔹 <b>User ID:</b> <code>${userId}</code>\n`;
   text += `🔹 <b>Akses:</b> ${auth.authorized ? `✅ Whitelisted (<b>${auth.role.toUpperCase()}</b>)` : '❌ Guest'}\n`;
   text += UI.divider;

   if (!auth.authorized) {
       text += `📢 Akses ditolak. Hubungi Founder @pansagr.\n`;
       text += UI.divider + UI.footer;
       if (messageId) return bot.editMessageText(text, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' });
       return bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
   }

   text += `Silakan pilih menu di bawah ini.\n`;
   text += UI.divider + UI.footer;
   const opts = { parse_mode: 'HTML', ...KEYBOARDS.mainMenu(auth.role) };

   if (messageId) {
       bot.editMessageText(text, { chat_id: chatId, message_id: messageId, ...opts }).catch(() => {});
   } else {
       bot.sendMessage(chatId, text, opts);
   }
}

// ==========================================
// 🕸️ FLARESOLVERR
// ==========================================
async function getCfClearance() {
   console.log('🔄 [FlareSolverr] Mengambil cf_clearance...');
   let retries = 3;
   while (retries > 0) {
       try {
           const res = await axios.post(FLARE_URL, {
               cmd: 'request.get',
               url: BASE_URL,
               maxTimeout: 120000,
           }, { timeout: 180000 });

           if (res.data.status !== 'ok') throw new Error(`FlareSolverr error: ${res.data.message}`);

           const solution = res.data.solution;
           const cfCookie = solution.cookies.find(c => c.name === 'cf_clearance');
           if (!cfCookie?.value) throw new Error('cf_clearance tidak ditemukan');

           console.log(`✅ [FlareSolverr] cf_clearance berhasil didapat`);
           return { cf_clearance: cfCookie.value, userAgent: solution.userAgent };
       } catch (err) {
           retries--;
           console.error(`❌ [FlareSolverr] Gagal: ${err.message} | Sisa retry: ${retries}`);
           if (retries > 0) await delay(10000);
       }
   }
   throw new Error('FlareSolverr gagal setelah 3 kali percobaan.');
}

// ==========================================
// 🔄 SESSION MANAGEMENT
// ==========================================
async function refreshCfClearance(accountName, ivasSession, xsrfToken) {
   const { cf_clearance, userAgent } = await getCfClearance();

   let csrfToken = null;
   let sessionValid = 1;

   try {
       const res = await axios.get(`${BASE_URL}/portal`, {
           headers: {
               'User-Agent': userAgent,
               'Cookie': `ivas_sms_session=${ivasSession}; XSRF-TOKEN=${xsrfToken}; cf_clearance=${cf_clearance}`,
               'Accept': 'text/html,application/xhtml+xml',
               'Accept-Language': 'en-US,en;q=0.9',
               'Referer': BASE_URL,
           },
           maxRedirects: 5,
           timeout: 30000,
       });

       const finalUrl = res.request?.res?.responseUrl || '';
       if (finalUrl.includes('/login') || (res.data && res.data.includes('Account Login'))) {
           sessionValid = 0;
           console.warn(`⚠️ [${accountName}] Session expired!`);
       } else {
           const $ = cheerio.load(res.data);
           csrfToken = $('meta[name="csrf-token"]').attr('content') || null;
           console.log(`✅ [${accountName}] Session valid`);
       }
   } catch (err) {
       console.error(`⚠️ [${accountName}] Gagal validasi portal: ${err.message}`);
   }

   await dbRun(`
       INSERT INTO ivas_accounts (name, ivas_sms_session, xsrf_token, cf_clearance, csrf_token, user_agent, session_valid, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(name) DO UPDATE SET
           cf_clearance  = excluded.cf_clearance,
           csrf_token    = excluded.csrf_token,
           user_agent    = excluded.user_agent,
           session_valid = excluded.session_valid,
           updated_at    = CURRENT_TIMESTAMP
   `, [accountName, ivasSession, xsrfToken, cf_clearance, csrfToken, userAgent, sessionValid]);

   if (sessionValid === 0) throw new Error(`Session akun [${accountName}] expired! Perlu update cookies manual.`);
   return { cf_clearance, csrfToken, userAgent };
}

async function refreshAllAccounts(notifyOnError = true) {
   const accounts = await dbAll('SELECT * FROM ivas_accounts');
   if (accounts.length === 0) { console.log('ℹ️ Belum ada akun.'); return; }

   for (const acc of accounts) {
       try {
           await refreshCfClearance(acc.name, acc.ivas_sms_session, acc.xsrf_token);
           console.log(`✅ [${acc.name}] Refresh berhasil.`);
       } catch (err) {
           console.error(`❌ [${acc.name}] ${err.message}`);
           if (notifyOnError) {
               bot.sendMessage(SUPERADMIN_ID,
                   `⚠️ <b>SESSION EXPIRED</b>\n\nAkun <code>[${acc.name}]</code> perlu update cookies.\n\nGunakan menu ⚙️ <b>Tambah/Update Akun iVAS</b>.`,
                   { parse_mode: 'HTML' }
               ).catch(() => {});
           }
       }
       await delay(3000);
   }
}

// ==========================================
// 🔄 LIVE OTP TRACKING
// ==========================================
const seenOtp = new Map();

async function processOtpTracking(chatId, userId, fullNumber) {
   const accounts = await dbAll('SELECT * FROM ivas_accounts WHERE session_valid = 1');
   if (accounts.length === 0) {
       return bot.sendMessage(chatId,
           UI.header('Sistem Kosong') + `❌ Belum ada akun iVAS aktif.\n` + UI.divider + UI.footer,
           { parse_mode: 'HTML', ...KEYBOARDS.backButton }
       );
   }

   const statusMsg = await bot.sendMessage(chatId,
       `📡 <b>[PANSA RADAR]</b> Memindai nomor <code>${fullNumber}</code> di <b>${accounts.length} Akun</b>...`,
       { parse_mode: 'HTML' }
   );

   let targetAccount = null;
   for (const acc of accounts) {
       try {
           const params = new URLSearchParams({ draw: 1, start: 0, length: 2000, 'search[value]': '' });
           const res = await axios.get(`${BASE_URL}/portal/numbers?${params}`, {
               headers: {
                   'User-Agent': acc.user_agent,
                   'X-Requested-With': 'XMLHttpRequest',
                   'Cookie': buildCookieString(acc),
               },
               timeout: 15000,
           });
           if (res.status === 200 && res.data?.data) {
               const found = res.data.data.find(item => item.Number.toString() === fullNumber);
               if (found) { targetAccount = acc; break; }
           }
       } catch (e) {
           console.error(`[routing] [${acc.name}] ${e.message}`);
       }
   }

   if (!targetAccount) {
       bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
       return bot.sendMessage(chatId,
           UI.header('Hasil Radar') +
           `📭 Nomor <code>${fullNumber}</code> tidak ditemukan di semua akun.\n` +
           UI.divider + UI.footer,
           { parse_mode: 'HTML', ...KEYBOARDS.backButton }
       );
   }

   const MAX_ATTEMPTS = 20;
   const dateStr = new Date().toISOString().split('T')[0];
   let otpFound = false;

   for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
       await bot.editMessageText(
           `🛰️ <b>[PANSA TRACKING]</b>\n${UI.divider}` +
           `🎯 <b>Target:</b> <code>${fullNumber}</code>\n` +
           `🗄️ <b>Akun:</b> <code>[${targetAccount.name}]</code>\n` +
           `🔄 <b>Status:</b> Menunggu OTP masuk...\n` +
           `⏱️ <b>Percobaan:</b> <code>[${attempt}/${MAX_ATTEMPTS}]</code>`,
           { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: 'HTML' }
       ).catch(() => {});

       try {
           const payload = new URLSearchParams({
               '_token': targetAccount.csrf_token,
               'start': dateStr,
               'end': dateStr,
               'Number': fullNumber,
               'Range': '',
           });

           const res = await axios.post(
               `${BASE_URL}/portal/sms/received/getsms/number/sms`,
               payload.toString(),
               {
                   headers: {
                       'User-Agent': targetAccount.user_agent,
                       'X-Requested-With': 'XMLHttpRequest',
                       'Referer': `${BASE_URL}/portal/sms/received`,
                       'Origin': BASE_URL,
                       'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                       'Cookie': buildCookieString(targetAccount),
                   },
                   timeout: 15000,
               }
           );

           if (res.status === 200) {
               const $ = cheerio.load(res.data);
               let latestSms = null;

               $('tbody tr').each((i, row) => {
                   const smsText = $(row).find('.msg-text').text().trim();
                   if (smsText) {
                       latestSms = {
                           sender: $(row).find('.cli-tag').text().trim() || 'Unknown',
                           text: smsText,
                           time: $(row).find('.time-cell').text().trim(),
                       };
                       return false;
                   }
               });

               if (latestSms) {
                   const smsHash = `${latestSms.text}_${latestSms.time}`;
                   if (seenOtp.get(fullNumber) !== smsHash) {
                       seenOtp.set(fullNumber, smsHash);
                       otpFound = true;

                       bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});

                       let reply = UI.header('OTP TEMBUS');
                       reply += `📱 <b>Target:</b> <code>${fullNumber}</code>\n`;
                       reply += `🏢 <b>Pengirim:</b> <b>${latestSms.sender}</b>\n`;
                       reply += `💬 <b>Pesan:</b>\n<code>${latestSms.text}</code>\n\n`;
                       reply += `🔑 <b>KODE OTP:</b>\n<code>${extractOTP(latestSms.text)}</code>\n\n`;
                       reply += `🕐 <b>Waktu:</b> <i>${latestSms.time}</i>\n`;
                       reply += `🗄️ <b>Via Akun:</b> <i>${targetAccount.name}</i>\n`;
                       reply += UI.divider + UI.footer;

                       bot.sendMessage(chatId, reply, { parse_mode: 'HTML', ...KEYBOARDS.backButton });
                       break;
                   }
               }
           }
       } catch (e) {
           console.error(`[polling] attempt ${attempt}: ${e.message}`);
       }

       await delay(4000);
   }

   if (!otpFound) {
       bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
       bot.sendMessage(chatId,
           UI.header('Timeout') +
           `⏱️ <b>Batas Waktu Habis</b>\nOTP tidak tiba di <code>${fullNumber}</code> setelah 80 detik.\n` +
           UI.divider + UI.footer,
           { parse_mode: 'HTML', ...KEYBOARDS.backButton }
       );
   }
}

// ==========================================
// 💬 CALLBACK QUERY HANDLER
// ==========================================
bot.onText(/\/start/, (msg) => renderMainMenu(msg.chat.id, msg.from.id));

bot.on('callback_query', async (query) => {
   const chatId = query.message.chat.id;
   const messageId = query.message.message_id;
   const userId = query.from.id;
   const action = query.data;

   const auth = await isAuthorized(userId);
   if (!auth.authorized) return bot.answerCallbackQuery(query.id, { text: 'Akses Ditolak!', show_alert: true });

   try {
       // ── MAIN MENU ──
       if (action === 'btn_main') {
           await renderMainMenu(chatId, userId, messageId);
       }

       // ── GET OTP ──
       else if (action === 'btn_get_otp') {
           let text = UI.header('Dapatkan OTP');
           text += `📱 <b>Balas (reply) pesan ini dengan FULL NOMOR target:</b>\n`;
           text += `<i>Tanpa + atau spasi, contoh: 6281234567890</i>\n`;
           text += UI.divider + UI.footer;
           bot.editMessageText(text, {
               chat_id: chatId,
               message_id: messageId,
               parse_mode: 'HTML',
               reply_markup: {
                   inline_keyboard: [
                       [{ text: '🔙 Kembali ke Dashboard', callback_data: 'btn_main' }],
                   ],
               },
           }).catch(() => {
               bot.sendMessage(chatId, text, {
                   parse_mode: 'HTML',
                   reply_markup: {
                       force_reply: true,
                       selective: true,
                       inline_keyboard: [[{ text: '🔙 Kembali ke Dashboard', callback_data: 'btn_main' }]],
                   },
               });
           });
       }

       // ── TAMBAH AKUN ──
       else if (action === 'btn_add_account') {
           let text = UI.header('Tambah/Update Akun');
           text += `⚙️ <b>Balas (reply) pesan ini dengan format:</b>\n\n`;
           text += `<code>NAMA_AKUN ivas_sms_session xsrf_token</code>\n\n`;
           text += `<i>Dapatkan cookies dari browser setelah login manual ke ivasms.com</i>\n`;
           text += UI.divider + UI.footer;
           bot.editMessageText(text, {
               chat_id: chatId,
               message_id: messageId,
               parse_mode: 'HTML',
               reply_markup: {
                   inline_keyboard: [
                       [{ text: '🔙 Kembali ke Dashboard', callback_data: 'btn_main' }],
                   ],
               },
           }).catch(() => {});
       }

       // ── STATUS AKUN ──
       else if (action === 'btn_status') {
           const accounts = await dbAll('SELECT name, session_valid, updated_at FROM ivas_accounts');
           let text = UI.header('Status Multi-Akun');

           if (accounts.length === 0) {
               text += `❌ Belum ada akun terdaftar.\n`;
           } else {
               text += `📊 <b>Total: ${accounts.length} Akun</b>\n\n`;
               accounts.forEach((acc, i) => {
                   text += `<b>${i + 1}. [${acc.name}]</b>\n`;
                   text += `   Status: ${acc.session_valid ? '🟢 Aktif' : '🔴 Expired'}\n`;
                   text += `   Sync: <code>${acc.updated_at}</code>\n\n`;
               });
           }
           text += UI.divider;
           text += `<i>cf_clearance auto-refresh setiap 45 menit</i>\n`;
           text += UI.divider + UI.footer;

           bot.editMessageText(text, {
               chat_id: chatId,
               message_id: messageId,
               parse_mode: 'HTML',
               ...KEYBOARDS.accountMenu,
           });
       }

       // ── REFRESH SEMUA AKUN ──
       else if (action === 'btn_refresh_accounts') {
           bot.answerCallbackQuery(query.id, { text: 'Memulai refresh...', show_alert: false });
           bot.editMessageText(
               UI.header('Refresh Akun') + `🔄 Sedang refresh semua akun...\n` + UI.divider + UI.footer,
               { chat_id: chatId, message_id: messageId, parse_mode: 'HTML' }
           ).catch(() => {});

           await refreshAllAccounts(true);

           const accounts = await dbAll('SELECT name, session_valid FROM ivas_accounts');
           let text = UI.header('Refresh Selesai');
           accounts.forEach(acc => {
               text += `${acc.session_valid ? '🟢' : '🔴'} <b>[${acc.name}]</b>\n`;
           });
           text += UI.divider + UI.footer;

           bot.editMessageText(text, {
               chat_id: chatId,
               message_id: messageId,
               parse_mode: 'HTML',
               ...KEYBOARDS.accountMenu,
           }).catch(() => {});
       }

       // ── HAPUS AKUN ──
       else if (action === 'btn_del_account_prompt' && auth.role === 'superadmin') {
           const accounts = await dbAll('SELECT name FROM ivas_accounts');
           if (accounts.length === 0) {
               return bot.answerCallbackQuery(query.id, { text: 'Tidak ada akun!', show_alert: true });
           }

           const kb = accounts.map(acc => ([{
               text: `🗑️ ${acc.name}`,
               callback_data: `btn_del_account_${acc.name}`,
           }]));
           kb.push([{ text: '🔙 Kembali', callback_data: 'btn_status' }]);

           bot.editMessageText(
               UI.header('Hapus Akun') + `Pilih akun yang ingin dihapus:\n` + UI.divider + UI.footer,
               { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: { inline_keyboard: kb } }
           );
       }

       else if (action.startsWith('btn_del_account_') && auth.role === 'superadmin') {
           const name = action.replace('btn_del_account_', '');
           await dbRun('DELETE FROM ivas_accounts WHERE name = ?', [name]);
           bot.answerCallbackQuery(query.id, { text: `✅ Akun [${name}] dihapus`, show_alert: true });
           const accounts = await dbAll('SELECT name, session_valid, updated_at FROM ivas_accounts');
           let text = UI.header('Status Multi-Akun');
           if (accounts.length === 0) {
               text += `❌ Belum ada akun terdaftar.\n`;
           } else {
               accounts.forEach((acc, i) => {
                   text += `<b>${i + 1}. [${acc.name}]</b>\n`;
                   text += `   Status: ${acc.session_valid ? '🟢 Aktif' : '🔴 Expired'}\n`;
                   text += `   Sync: <code>${acc.updated_at}</code>\n\n`;
               });
           }
           text += UI.divider + UI.footer;
           bot.editMessageText(text, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', ...KEYBOARDS.accountMenu });
       }

       // ── DAFTAR NOMOR ──
       else if (action === 'btn_mynumbers') {
           bot.answerCallbackQuery(query.id, { text: 'Mengumpulkan data...', show_alert: false });
           const accounts = await dbAll('SELECT * FROM ivas_accounts WHERE session_valid = 1');
           let allNumbers = [];

           for (const acc of accounts) {
               try {
                   const params = new URLSearchParams({ draw: 1, start: 0, length: 2000, 'search[value]': '' });
                   const res = await axios.get(`${BASE_URL}/portal/numbers?${params}`, {
                       headers: {
                           'User-Agent': acc.user_agent,
                           'X-Requested-With': 'XMLHttpRequest',
                           'Cookie': buildCookieString(acc),
                       },
                       timeout: 15000,
                   });
                   if (res.status === 200 && res.data?.data) {
                       res.data.data.forEach(item => {
                           allNumbers.push(`<code>${item.Number}</code> (<i>${acc.name}</i>)`);
                       });
                   }
               } catch (e) {
                   console.error(`[mynumbers] [${acc.name}] ${e.message}`);
               }
           }

           let text = UI.header(`Daftar Nomor (${allNumbers.length})`);
           if (allNumbers.length > 0) {
               allNumbers.slice(0, 30).forEach((num, i) => { text += `${i + 1}. ${num}\n`; });
               if (allNumbers.length > 30) text += `\n<i>... dan ${allNumbers.length - 30} nomor lainnya.</i>\n`;
           } else {
               text += `📭 Tidak ada nomor aktif.\n`;
           }
           text += UI.divider + UI.footer;
           bot.editMessageText(text, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', ...KEYBOARDS.backButton });
       }

       // ── CEK SALDO ──
       else if (action === 'btn_balance') {
           bot.answerCallbackQuery(query.id, { text: 'Mengkalkulasi saldo...', show_alert: false });
           const accounts = await dbAll('SELECT * FROM ivas_accounts WHERE session_valid = 1');
           let text = UI.header('Balance Multi-Akun');

           if (accounts.length === 0) {
               text += `❌ Belum ada akun aktif.\n`;
           } else {
               for (const acc of accounts) {
                   try {
                       const res = await axios.get(`${BASE_URL}/portal/sms/received`, {
                           headers: {
                               'User-Agent': acc.user_agent,
                               'Cookie': buildCookieString(acc),
                               'Accept': 'text/html',
                           },
                           timeout: 15000,
                       });
                       const $ = cheerio.load(res.data);
                       const revenue = $('div:contains("REVENUE")').parent().find('.text-white, .font-bold').first().text().trim() || 'N/A';
                       text += `🗄️ <b>[${acc.name}]</b>\n💰 Saldo: <b>${revenue}</b>\n\n`;
                   } catch (e) {
                       text += `🗄️ <b>[${acc.name}]</b>\n⚠️ Gagal: <i>${e.message}</i>\n\n`;
                   }
               }
           }
           text += UI.divider + UI.footer;
           bot.editMessageText(text, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', ...KEYBOARDS.backButton });
       }

       // ── ADMIN CONSOLE ──
       else if (action === 'btn_admin' && auth.role === 'superadmin') {
           const rows = await dbAll('SELECT telegram_id, created_at FROM users WHERE role = "admin"');
           let text = UI.header('Admin Console');
           text += `📋 <b>Admin Aktif: ${rows.length}</b>\n\n`;
           rows.forEach((row, i) => { text += `${i + 1}. <code>${row.telegram_id}</code>\n`; });
           if (rows.length === 0) text += `<i>Belum ada admin.</i>\n`;
           text += '\n' + UI.divider + UI.footer;
           bot.editMessageText(text, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', ...KEYBOARDS.adminConsole });
       }

       else if (action === 'btn_add_admin_prompt' && auth.role === 'superadmin') {
           let text = UI.header('Tambah Admin');
           text += `👑 <b>Balas (reply) pesan ini dengan ID Telegram Admin Baru:</b>\n`;
           text += UI.divider + UI.footer;
           bot.editMessageText(text, {
               chat_id: chatId,
               message_id: messageId,
               parse_mode: 'HTML',
               reply_markup: {
                   inline_keyboard: [[{ text: '🔙 Kembali ke Admin Console', callback_data: 'btn_admin' }]],
               },
           }).catch(() => {});
       }

       else if (action === 'btn_del_admin_prompt' && auth.role === 'superadmin') {
           const rows = await dbAll('SELECT telegram_id FROM users WHERE role = "admin"');
           if (rows.length === 0) {
               return bot.answerCallbackQuery(query.id, { text: 'Tidak ada admin!', show_alert: true });
           }

           const kb = rows.map(row => ([{
               text: `🗑️ ${row.telegram_id}`,
               callback_data: `btn_del_admin_${row.telegram_id}`,
           }]));
           kb.push([{ text: '🔙 Kembali ke Admin Console', callback_data: 'btn_admin' }]);

           bot.editMessageText(
               UI.header('Hapus Admin') + `Pilih admin yang ingin dihapus:\n` + UI.divider + UI.footer,
               { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: { inline_keyboard: kb } }
           );
       }

       else if (action.startsWith('btn_del_admin_') && auth.role === 'superadmin') {
           const targetId = parseInt(action.replace('btn_del_admin_', ''));
           await dbRun('DELETE FROM users WHERE telegram_id = ? AND role = "admin"', [targetId]);
           bot.answerCallbackQuery(query.id, { text: `✅ Admin ${targetId} dihapus`, show_alert: true });

           const rows = await dbAll('SELECT telegram_id, created_at FROM users WHERE role = "admin"');
           let text = UI.header('Admin Console');
           text += `📋 <b>Admin Aktif: ${rows.length}</b>\n\n`;
           rows.forEach((row, i) => { text += `${i + 1}. <code>${row.telegram_id}</code>\n`; });
           if (rows.length === 0) text += `<i>Belum ada admin.</i>\n`;
           text += '\n' + UI.divider + UI.footer;
           bot.editMessageText(text, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', ...KEYBOARDS.adminConsole });
       }

       bot.answerCallbackQuery(query.id);
   } catch (e) {
       console.error('[callback]', e.message);
       bot.answerCallbackQuery(query.id, { text: 'Terjadi Kesalahan!', show_alert: true });
   }
});

// ==========================================
// 📥 MESSAGE HANDLER (FORCE REPLY)
// ==========================================
bot.on('message', async (msg) => {
   if (!msg.text || msg.text.startsWith('/start')) return;

   const chatId = msg.chat.id;
   const userId = msg.from.id;
   const text = msg.text.trim();

   if (!msg.reply_to_message?.text) return;

   const promptText = msg.reply_to_message.text;
   const auth = await isAuthorized(userId);
   if (!auth.authorized) return;

   // ── CARI OTP ──
   if (promptText.includes('FULL NOMOR')) {
       const fullNumber = text.replace(/\D/g, '');
       if (fullNumber.length < 8) {
           return bot.sendMessage(chatId,
               '❌ <b>Format salah!</b> Masukkan nomor lengkap.',
               { parse_mode: 'HTML', ...KEYBOARDS.backButton }
           );
       }
       await processOtpTracking(chatId, userId, fullNumber);
   }

   // ── TAMBAH / UPDATE AKUN ──
   else if (promptText.includes('NAMA_AKUN ivas_sms_session')) {
       const parts = text.split(/\s+/);
       if (parts.length < 3) {
           return bot.sendMessage(chatId,
               '❌ <b>Format salah!</b>\nGunakan: <code>NAMA_AKUN ivas_session xsrf_token</code>',
               { parse_mode: 'HTML', ...KEYBOARDS.backButton }
           );
       }

       const [accountName, ivasSession, xsrfToken] = parts;
       const loadingMsg = await bot.sendMessage(chatId,
           `⏳ <b>[PANSA SYSTEM]</b> Menautkan akun <b>[${accountName}]</b>...\n<i>Mengambil cf_clearance via FlareSolverr...</i>`,
           { parse_mode: 'HTML' }
       );

       try {
           const data = await refreshCfClearance(accountName, ivasSession, xsrfToken);
           let reply = UI.header('Akun Terhubung');
           reply += `✅ <b>Akun [${accountName}] Berhasil!</b>\n\n`;
           reply += `🔑 <b>CSRF Token:</b> <code>${data.csrfToken ? data.csrfToken.substring(0, 20) + '...' : 'N/A'}</code>\n`;
           reply += `🌐 <b>cf_clearance:</b> ✅ Aktif\n`;
           reply += `🟢 <b>Session:</b> Valid\n`;
           reply += UI.divider + UI.footer;

           bot.deleteMessage(chatId, loadingMsg.message_id).catch(() => {});
           bot.sendMessage(chatId, reply, { parse_mode: 'HTML', ...KEYBOARDS.backButton });
       } catch (e) {
           bot.deleteMessage(chatId, loadingMsg.message_id).catch(() => {});
           bot.sendMessage(chatId, UI.error(e.message), { parse_mode: 'HTML', ...KEYBOARDS.backButton });
       }
   }

   // ── TAMBAH ADMIN ──
   else if (promptText.includes('ID Telegram Admin Baru')) {
       if (auth.role !== 'superadmin') return bot.sendMessage(chatId, '❌ Akses Ditolak!');
       const targetId = parseInt(text.replace(/\D/g, ''));
       if (isNaN(targetId)) return bot.sendMessage(chatId, '❌ ID tidak valid!', KEYBOARDS.backButton);

       try {
           await dbRun(
               'INSERT INTO users (telegram_id, role) VALUES (?, "admin") ON CONFLICT(telegram_id) DO UPDATE SET role="admin"',
               [targetId]
           );
           bot.sendMessage(chatId,
               UI.header('Admin Added') +
               `✅ <b>Admin Ditambahkan</b>\n🔹 ID: <code>${targetId}</code>\n` +
               UI.divider + UI.footer,
               { parse_mode: 'HTML', ...KEYBOARDS.adminConsole }
           );
       } catch (e) {
           bot.sendMessage(chatId, UI.error(e.message), { parse_mode: 'HTML', ...KEYBOARDS.backButton });
       }
   }
});

// ==========================================
// 🚀 BOOTSTRAP
// ==========================================
async function bootstrap() {
   await initDb();
   console.log('🔄 [BOOT] Sinkronisasi semua akun...');
   await refreshAllAccounts(true);

   setInterval(async () => {
       console.log('🔄 [AUTO-REFRESH] Memperbarui cf_clearance...');
       await refreshAllAccounts(true);
   }, 45 * 60 * 1000);

   console.log('🤖 PANSA GROUP OTP Bot berjalan...');
}

bootstrap().catch(console.error);
