// server.js — Dindyz Data Backend v3.0 with Firebase (Permanent Storage)
require('dotenv').config();

const express  = require('express');
const cors     = require('cors');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const axios    = require('axios');
const admin    = require('firebase-admin');

const app  = express();
const PORT = process.env.PORT || 5000;

// ── Firebase Setup ────────────────────────────────────────────
let db = null;
try {
  if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_PRIVATE_KEY && process.env.FIREBASE_CLIENT_EMAIL) {
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert({
          type:         'service_account',
          project_id:   process.env.FIREBASE_PROJECT_ID,
          private_key:  process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
          client_email: process.env.FIREBASE_CLIENT_EMAIL,
        }),
      });
    }
    db = admin.firestore();
    console.log('✅ Firebase connected — data saved permanently');
  } else {
    console.log('⚠️  No Firebase — using memory (data resets on restart)');
  }
} catch (err) {
  console.error('Firebase init error:', err.message);
}

// ── In-memory fallback ────────────────────────────────────────
const MEM = { users: {}, transactions: [], orders: [] };

// ── Firebase/Memory helpers ───────────────────────────────────
const FS = {
  async getUserByPhone(phone) {
    if (!db) return MEM.users[phone] || null;
    const snap = await db.collection('users').where('phone', '==', phone).limit(1).get();
    if (snap.empty) return null;
    return { id: snap.docs[0].id, ...snap.docs[0].data() };
  },
  async getUserById(uid) {
    if (!db) return MEM.users[uid] || null;
    const doc = await db.collection('users').doc(uid).get();
    if (!doc.exists) return null;
    return { id: doc.id, ...doc.data() };
  },
  async saveUser(uid, data) {
    if (!db) { MEM.users[uid] = data; MEM.users[data.phone] = data; return; }
    await db.collection('users').doc(uid).set(data, { merge: true });
  },
  async updateUser(uid, updates) {
    if (!db) {
      const user = MEM.users[uid];
      if (user) { Object.assign(user, updates); if (user.phone) MEM.users[user.phone] = user; }
      return;
    }
    await db.collection('users').doc(uid).update(updates);
  },
  async addTransaction(data) {
    if (!db) { MEM.transactions.unshift(data); return; }
    await db.collection('transactions').doc(data.id).set(data);
  },
  async getTransactions(userId, limit = 20, type = null) {
    if (!db) {
      let t = MEM.transactions.filter(x => x.userId === userId);
      if (type) t = t.filter(x => x.type === type);
      return t.slice(0, limit);
    }
    let q = db.collection('transactions').where('userId', '==', userId).orderBy('createdAt', 'desc').limit(limit);
    if (type) q = q.where('type', '==', type);
    const snap = await q.get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  },
  async isRefProcessed(ref) {
    if (!db) return MEM.transactions.some(t => t.paystackRef === ref);
    const snap = await db.collection('transactions').where('paystackRef', '==', ref).limit(1).get();
    return !snap.empty;
  },
  async getAllUsers() {
    if (!db) return Object.values(MEM.users).filter((u, i, a) => a.findIndex(x => x.uid === u.uid) === i);
    const snap = await db.collection('users').orderBy('createdAt', 'desc').limit(200).get();
    return snap.docs.map(d => d.data());
  },
  async getAllTransactions() {
    if (!db) return MEM.transactions.slice(0, 200);
    const snap = await db.collection('transactions').orderBy('createdAt', 'desc').limit(200).get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  },
};

// ── Middleware ────────────────────────────────────────────────
app.use(cors({ origin: '*', credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ── Helpers ───────────────────────────────────────────────────
const makeRef  = () => 'DD-' + Date.now().toString(36).toUpperCase();
const makeCode = (name) => 'DD-' + name.slice(0, 3).toUpperCase() + Math.random().toString(36).substr(2, 4).toUpperCase();
const genToken = (uid) => jwt.sign({ uid }, process.env.JWT_SECRET || 'dindyz_secret_2026', { expiresIn: '30d' });
const getTier  = (xp) => xp >= 5000 ? 'Platinum' : xp >= 1000 ? 'Gold' : xp >= 300 ? 'Silver' : 'Bronze';

const protect = async (req, res, next) => {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer '))
    return res.status(401).json({ success: false, message: 'Not authorized. Please login.' });
  try {
    const decoded = jwt.verify(auth.split(' ')[1], process.env.JWT_SECRET || 'dindyz_secret_2026');
    const user = await FS.getUserById(decoded.uid);
    if (!user) return res.status(401).json({ success: false, message: 'User not found.' });
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ success: false, message: 'Session expired. Please login again.' });
  }
};

// ── Health ────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ success: true, app: 'Dindyz Data API', version: '3.0.0', storage: db ? 'Firebase' : 'Memory', status: 'running' }));
app.get('/api/health', (req, res) => res.json({ success: true, status: 'healthy', storage: db ? 'Firebase (permanent)' : 'Memory (temporary)' }));

// ══════════════════════════════════════
// AUTH
// ══════════════════════════════════════
app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, phone, email, pin, referralCode } = req.body;
    if (!name  || name.length < 2)      return res.status(400).json({ success: false, message: 'Enter your full name.' });
    if (!phone || phone.length < 10)    return res.status(400).json({ success: false, message: 'Enter a valid phone number.' });
    if (!email || !email.includes('@')) return res.status(400).json({ success: false, message: 'Enter a valid email address.' });
    if (!pin   || pin.length < 4)       return res.status(400).json({ success: false, message: 'Create a 4-digit PIN.' });

    const existing = await FS.getUserByPhone(phone);
    if (existing) return res.status(400).json({ success: false, message: 'Phone number already registered.' });

    const uid       = uuidv4();
    const hashedPin = await bcrypt.hash(pin, 10);

    // Referral bonus
    if (referralCode && db) {
      try {
        const rSnap = await db.collection('users').where('referralCode', '==', referralCode).limit(1).get();
        if (!rSnap.empty) {
          const rd = rSnap.docs[0].data();
          await FS.updateUser(rSnap.docs[0].id, {
            walletBalance:    (rd.walletBalance    || 0) + 500,
            referralCount:    (rd.referralCount    || 0) + 1,
            referralEarnings: (rd.referralEarnings || 0) + 500,
            xp:               (rd.xp               || 0) + 50,
          });
        }
      } catch (e) {}
    }

    const user = {
      uid, name, phone, email, pin: hashedPin,
      role: 'user', status: 'active', tier: 'Bronze', xp: 0,
      walletBalance: 0, totalSpent: 0, totalOrders: 0,
      referralCode: makeCode(name), referralCount: 0, referralEarnings: 0,
      createdAt: new Date().toISOString(),
    };
    await FS.saveUser(uid, user);

    const { pin: _, ...safe } = user;
    return res.status(201).json({ success: true, message: 'Account created!', token: genToken(uid), user: safe });
  } catch (err) { return res.status(500).json({ success: false, message: err.message }); }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { phone, pin } = req.body;
    const user = await FS.getUserByPhone(phone);
    if (!user) return res.status(401).json({ success: false, message: 'Phone number not found.' });
    if (!(await bcrypt.compare(pin, user.pin))) return res.status(401).json({ success: false, message: 'Incorrect PIN.' });
    const { pin: _, ...safe } = user;
    return res.json({ success: true, message: 'Login successful.', token: genToken(user.uid), user: safe });
  } catch (err) { return res.status(500).json({ success: false, message: err.message }); }
});

app.post('/api/auth/send-otp',   (req, res) => res.json({ success: true, message: 'OTP sent.', devOTP: '123456' }));
app.post('/api/auth/verify-otp', (req, res) => res.json({ success: true, message: 'Verified.' }));

app.post('/api/auth/reset-pin', async (req, res) => {
  try {
    const { phone, newPin } = req.body;
    const user = await FS.getUserByPhone(phone);
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
    await FS.updateUser(user.uid, { pin: await bcrypt.hash(newPin, 10) });
    return res.json({ success: true, message: 'PIN reset successfully.' });
  } catch (err) { return res.status(500).json({ success: false, message: err.message }); }
});

// ══════════════════════════════════════
// USER
// ══════════════════════════════════════
app.get('/api/user/profile', protect, async (req, res) => {
  const fresh = await FS.getUserById(req.user.uid);
  const { pin, ...safe } = fresh || req.user;
  return res.json({ success: true, user: safe });
});

app.patch('/api/user/profile', protect, async (req, res) => {
  const { name, email } = req.body;
  const updates = {};
  if (name)  updates.name  = name;
  if (email) updates.email = email;
  await FS.updateUser(req.user.uid, updates);
  return res.json({ success: true, message: 'Profile updated.' });
});

app.get('/api/user/loyalty', protect, async (req, res) => {
  const u = await FS.getUserById(req.user.uid) || req.user;
  const xp = u.xp || 0;
  const tier = u.tier || 'Bronze';
  const next = { Bronze: 'Silver', Silver: 'Gold', Gold: 'Platinum', Platinum: null }[tier];
  const xpNeeded = { Bronze: 300, Silver: 1000, Gold: 5000, Platinum: 0 }[tier] || 0;
  return res.json({ success: true, loyalty: { xp, tier, nextTier: next, xpToNext: Math.max(0, xpNeeded - xp), referralCode: u.referralCode, referralCount: u.referralCount || 0, referralEarnings: u.referralEarnings || 0 } });
});

// ══════════════════════════════════════
// WALLET
// ══════════════════════════════════════
app.get('/api/wallet/balance', protect, async (req, res) => {
  const u = await FS.getUserById(req.user.uid);
  return res.json({ success: true, balance: u?.walletBalance || 0 });
});

app.get('/api/wallet/transactions', protect, async (req, res) => {
  const { limit = 20, type } = req.query;
  const txns = await FS.getTransactions(req.user.uid, Number(limit), type || null);
  return res.json({ success: true, transactions: txns });
});

app.post('/api/wallet/fund', protect, async (req, res) => {
  try {
    const { amount } = req.body;
    if (!amount || amount < 100) return res.status(400).json({ success: false, message: 'Minimum is ₦100.' });
    const key = process.env.PAYSTACK_SECRET_KEY;
    if (!key || key.includes('your_')) {
      const u = await FS.getUserById(req.user.uid);
      await FS.updateUser(req.user.uid, { walletBalance: (u?.walletBalance || 0) + Number(amount) });
      await FS.addTransaction({ id: uuidv4(), userId: req.user.uid, type: 'wallet_funding', amount: Number(amount), status: 'success', createdAt: new Date().toISOString() });
      return res.json({ success: true, demoMode: true, message: `Demo: ₦${amount} added` });
    }
    const r = await axios.post('https://api.paystack.co/transaction/initialize', {
      email:        req.user.email || req.user.phone + '@dindyz.app',
      amount:       Number(amount) * 100,
      currency:     'NGN',
      callback_url: `${process.env.FRONTEND_URL || 'https://lighthearted-kangaroo-7546e3.netlify.app'}/pages/fund.html`,
      metadata:     { userId: req.user.uid, phone: req.user.phone },
    }, { headers: { Authorization: `Bearer ${key}` } });
    return res.json({ success: true, authorizationUrl: r.data.data.authorization_url, reference: r.data.data.reference });
  } catch (err) { return res.status(500).json({ success: false, message: err.response?.data?.message || err.message }); }
});

app.get('/api/wallet/verify/:reference', protect, async (req, res) => {
  try {
    const { reference } = req.params;
    if (await FS.isRefProcessed(reference)) return res.json({ success: true, message: 'Already verified.', alreadyProcessed: true });
    const r    = await axios.get(`https://api.paystack.co/transaction/verify/${reference}`, { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` } });
    const data = r.data.data;
    if (data.status !== 'success') return res.status(400).json({ success: false, message: 'Payment not successful.' });
    const amount   = data.amount / 100;
    const u        = await FS.getUserById(req.user.uid);
    const newBal   = (u?.walletBalance || 0) + amount;
    await FS.updateUser(req.user.uid, { walletBalance: newBal });
    await FS.addTransaction({ id: uuidv4(), userId: req.user.uid, type: 'wallet_funding', amount, paystackRef: reference, channel: data.channel, status: 'success', createdAt: new Date().toISOString() });
    return res.json({ success: true, message: `Wallet credited ₦${amount.toLocaleString()}!`, newBalance: newBal });
  } catch (err) { return res.status(500).json({ success: false, message: err.message }); }
});

app.post('/api/wallet/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const crypto = require('crypto');
    const hash   = crypto.createHmac('sha512', process.env.PAYSTACK_SECRET_KEY || '').update(req.body).digest('hex');
    if (hash !== req.headers['x-paystack-signature']) return res.sendStatus(400);
    const event = JSON.parse(req.body);
    if (event.event === 'charge.success') {
      const { reference, amount, metadata } = event.data;
      const userId = metadata?.userId;
      if (userId && !(await FS.isRefProcessed(reference))) {
        const u = await FS.getUserById(userId);
        if (u) {
          await FS.updateUser(userId, { walletBalance: (u.walletBalance || 0) + (amount / 100) });
          await FS.addTransaction({ id: uuidv4(), userId, type: 'wallet_funding', amount: amount / 100, paystackRef: reference, status: 'success', createdAt: new Date().toISOString() });
        }
      }
    }
    return res.sendStatus(200);
  } catch { return res.sendStatus(200); }
});

// ══════════════════════════════════════
// VTU
// ══════════════════════════════════════
const processVTU = async (req, res, type, amount, details, vtFn) => {
  try {
    const u = await FS.getUserById(req.user.uid);
    if ((u?.walletBalance || 0) < amount) return res.status(400).json({ success: false, message: 'Insufficient balance. Please fund your wallet.' });
    const ref = makeRef();
    await FS.updateUser(req.user.uid, { walletBalance: (u.walletBalance || 0) - amount, totalOrders: (u.totalOrders || 0) + 1 });
    let vtResult = { success: true, token: '' };
    if (process.env.VTPASS_API_KEY && !process.env.VTPASS_API_KEY.includes('your_')) {
      try { vtResult = await vtFn(); } catch (e) { vtResult = { success: false }; }
    }
    if (!vtResult.success) {
      await FS.updateUser(req.user.uid, { walletBalance: u.walletBalance });
      await FS.addTransaction({ id: uuidv4(), userId: req.user.uid, ref, type, amount, details, status: 'failed', createdAt: new Date().toISOString() });
      return res.status(400).json({ success: false, message: 'Order failed. You have been refunded.' });
    }
    const newXP = (u.xp || 0) + ({ data: 10, airtime: 5, cable: 8, electricity: 8, gift: 15 }[type] || 5);
    await FS.updateUser(req.user.uid, { xp: newXP, tier: getTier(newXP), totalSpent: (u.totalSpent || 0) + amount });
    await FS.addTransaction({ id: uuidv4(), userId: req.user.uid, ref, type, amount, details, status: 'success', token: vtResult.token || '', createdAt: new Date().toISOString() });
    return res.json({ success: true, ref, token: vtResult.token, message: 'Order completed successfully!' });
  } catch (err) { return res.status(500).json({ success: false, message: err.message }); }
};

const vtHeaders = () => ({ 'api-key': process.env.VTPASS_API_KEY, 'secret-key': process.env.VTPASS_SECRET_KEY });
const vtPay = (body) => axios.post(`${process.env.VTPASS_BASE_URL}/pay`, { request_id: 'DD' + Date.now(), ...body }, { headers: vtHeaders() });

app.post('/api/vtu/data', protect, async (req, res) => {
  const { phone, network, variationCode, amount, size, giftMessage } = req.body;
  if (!phone || !network || !amount) return res.status(400).json({ success: false, message: 'Missing fields.' });
  await processVTU(req, res, 'data', Number(amount), { phone, network, size, giftMessage }, async () => {
    const r = await vtPay({ serviceID: { MTN: 'mtn-data', Airtel: 'airtel-data', Glo: 'glo-data', '9Mobile': 'etisalat-data' }[network], billersCode: phone, variation_code: variationCode, amount, phone });
    return { success: r.data?.content?.transactions?.status === 'delivered' };
  });
});

app.post('/api/vtu/airtime', protect, async (req, res) => {
  const { phone, network, amount } = req.body;
  if (!phone || !network || !amount) return res.status(400).json({ success: false, message: 'Missing fields.' });
  if (amount < 50) return res.status(400).json({ success: false, message: 'Minimum ₦50.' });
  await processVTU(req, res, 'airtime', Number(amount), { phone, network }, async () => {
    const sID = { MTN: 'mtn', Airtel: 'airtel', Glo: 'glo', '9Mobile': 'etisalat' }[network];
    const r   = await vtPay({ serviceID: sID, billersCode: phone, variation_code: sID, amount, phone });
    return { success: r.data?.content?.transactions?.status === 'delivered' };
  });
});

app.post('/api/vtu/cable', protect, async (req, res) => {
  const { smartCard, provider, variationCode, amount, phone } = req.body;
  if (!smartCard || !provider || !amount) return res.status(400).json({ success: false, message: 'Missing fields.' });
  await processVTU(req, res, 'cable', Number(amount), { smartCard, provider }, async () => {
    const r = await vtPay({ serviceID: { DStv: 'dstv', GOtv: 'gotv', Startimes: 'startimes' }[provider], billersCode: smartCard, variation_code: variationCode, amount, phone: phone || req.user.phone, subscription_type: 'change' });
    return { success: r.data?.content?.transactions?.status === 'delivered' };
  });
});

app.post('/api/vtu/electricity', protect, async (req, res) => {
  const { meterNumber, disco, meterType, amount } = req.body;
  if (!meterNumber || !disco || !amount) return res.status(400).json({ success: false, message: 'Missing fields.' });
  if (amount < 500) return res.status(400).json({ success: false, message: 'Minimum ₦500.' });
  await processVTU(req, res, 'electricity', Number(amount), { meterNumber, disco }, async () => {
    const map = { 'Jos (JED)': 'jos-electric', 'Abuja (AEDC)': 'abuja-electric', 'Lagos (EKEDC)': 'eko-electric', 'Ikeja (IKEDC)': 'ikeja-electric', 'Ibadan (IBEDC)': 'ibadan-electric', 'Kano (KEDC)': 'kano-electric', 'Enugu (EEDC)': 'enugu-electric', 'Port Harcourt (PHEDC)': 'phed', 'Kaduna (KAEDCO)': 'kaduna-electric' };
    const r = await vtPay({ serviceID: map[disco], billersCode: meterNumber, variation_code: meterType, amount, phone: req.user.phone });
    return { success: r.data?.content?.transactions?.status === 'delivered', token: r.data?.content?.transactions?.product_name || '' };
  });
});

// ══════════════════════════════════════
// ADMIN
// ══════════════════════════════════════
app.get('/api/admin/stats', protect, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ success: false, message: 'Admin only.' });
  const [users, txns] = await Promise.all([FS.getAllUsers(), FS.getAllTransactions()]);
  return res.json({ success: true, stats: { totalUsers: users.length, totalRevenue: txns.filter(t => t.type !== 'wallet_funding').reduce((s, t) => s + (t.amount || 0), 0), totalOrders: txns.filter(t => t.status === 'success' && t.type !== 'wallet_funding').length, totalDeposits: txns.filter(t => t.type === 'wallet_funding').reduce((s, t) => s + (t.amount || 0), 0) } });
});

app.get('/api/admin/users', protect, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ success: false, message: 'Admin only.' });
  const users = await FS.getAllUsers();
  return res.json({ success: true, users: users.map(({ pin, ...u }) => u) });
});

// ── Start ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ Dindyz Data API v3.0 — Port ${PORT}`);
  console.log(`💾 Storage: ${db ? 'Firebase (permanent ✅)' : 'Memory (temporary ⚠️)'}`);
});

module.exports = app;
