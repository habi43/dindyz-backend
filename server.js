// server.js — Dindyz Data Backend (Single File Version)
// This version works perfectly when all files are in the same folder on GitHub

require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const axios   = require('axios');

const app  = express();
const PORT = process.env.PORT || 5000;

// ── Middleware ────────────────────────────────────────────────
app.use(cors({ origin: '*', credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Simple in-memory database (works without Firebase) ───────
// In production you can add Firebase later
const DB = {
  users:        {},   // phone -> user object
  tokens:       {},   // uid   -> token
  transactions: [],   // array of transaction objects
  orders:       [],   // array of order objects
  otps:         {},   // phone -> { otp, expires }
};

// ── Helpers ───────────────────────────────────────────────────
const makeRef  = () => 'DD-' + Date.now().toString(36).toUpperCase();
const makeCode = (name) => 'DD-' + name.slice(0,3).toUpperCase() + Math.random().toString(36).substr(2,4).toUpperCase();

const genToken = (uid) => jwt.sign({ uid }, process.env.JWT_SECRET || 'dindyz_secret_2026', { expiresIn: '30d' });

const protect = (req, res, next) => {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer '))
    return res.status(401).json({ success: false, message: 'Not authorized. Please login.' });
  try {
    const decoded = jwt.verify(auth.split(' ')[1], process.env.JWT_SECRET || 'dindyz_secret_2026');
    const user = DB.users[decoded.uid];
    if (!user) return res.status(401).json({ success: false, message: 'User not found.' });
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ success: false, message: 'Session expired. Please login again.' });
  }
};

const updateTier = (user) => {
  const xp = user.xp || 0;
  if (xp >= 5000) user.tier = 'Platinum';
  else if (xp >= 1000) user.tier = 'Gold';
  else if (xp >= 300)  user.tier = 'Silver';
  else user.tier = 'Bronze';
};

// ── Health Check ─────────────────────────────────────────────
app.get('/', (req, res) => res.json({
  success: true, app: 'Dindyz Data API', version: '2.0.0',
  status: 'running', time: new Date().toISOString()
}));

app.get('/api/health', (req, res) => res.json({
  success: true, status: 'healthy', users: Object.keys(DB.users).length,
  transactions: DB.transactions.length, time: new Date().toISOString()
}));

// ═══════════════════════════════════════════════════
// AUTH ROUTES
// ═══════════════════════════════════════════════════

// Send OTP
app.post('/api/auth/send-otp', (req, res) => {
  const { phone } = req.body;
  if (!phone || phone.length < 10)
    return res.status(400).json({ success: false, message: 'Enter a valid phone number.' });
  const otp     = String(Math.floor(100000 + Math.random() * 900000));
  const expires = Date.now() + 5 * 60 * 1000;
  DB.otps[phone] = { otp, expires };
  // In development return OTP directly so you can test
  return res.json({ success: true, message: `OTP sent to ${phone}`, devOTP: otp });
});

// Verify OTP
app.post('/api/auth/verify-otp', (req, res) => {
  const { phone, otp } = req.body;
  const stored = DB.otps[phone];
  if (!stored || Date.now() > stored.expires)
    return res.status(400).json({ success: false, message: 'OTP expired. Request a new one.' });
  if (stored.otp !== otp)
    return res.status(400).json({ success: false, message: 'Incorrect OTP.' });
  delete DB.otps[phone];
  return res.json({ success: true, message: 'Phone verified.' });
});

// Register (no OTP required)
app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, phone, email, pin, referralCode } = req.body;
    if (!name || name.length < 2)
      return res.status(400).json({ success: false, message: 'Enter your full name.' });
    if (!phone || phone.length < 10)
      return res.status(400).json({ success: false, message: 'Enter a valid phone number.' });
    if (!pin || pin.length < 4)
      return res.status(400).json({ success: false, message: 'Create a 4-digit PIN.' });

    // Check if phone already registered
    if (DB.users[phone])
      return res.status(400).json({ success: false, message: 'Phone number already registered.' });

    const uid       = uuidv4();
    const hashedPin = await bcrypt.hash(pin, 10);
    const refCode   = makeCode(name);

    // Handle referral bonus
    if (referralCode) {
      const referrer = Object.values(DB.users).find(u => u.referralCode === referralCode);
      if (referrer) {
        referrer.walletBalance  = (referrer.walletBalance  || 0) + 500;
        referrer.referralCount  = (referrer.referralCount  || 0) + 1;
        referrer.referralEarnings = (referrer.referralEarnings || 0) + 500;
        referrer.xp             = (referrer.xp             || 0) + 50;
        updateTier(referrer);
      }
    }

    const user = {
      uid, name, phone, email: email || '',
      pin: hashedPin, role: 'user', status: 'active',
      tier: 'Bronze', xp: 0,
      walletBalance: 0, totalSpent: 0, totalOrders: 0,
      referralCode: refCode, referralCount: 0, referralEarnings: 0,
      createdAt: new Date().toISOString(),
    };

    DB.users[phone] = user;
    DB.users[uid]   = user; // index by uid too

    const token = genToken(uid);
    const { pin: _, ...safeUser } = user;
    return res.status(201).json({ success: true, message: 'Account created!', token, user: safeUser });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { phone, pin } = req.body;
    const user = DB.users[phone];
    if (!user)
      return res.status(401).json({ success: false, message: 'Phone number not found.' });
    if (user.status === 'suspended')
      return res.status(403).json({ success: false, message: 'Account suspended.' });
    const match = await bcrypt.compare(pin, user.pin);
    if (!match)
      return res.status(401).json({ success: false, message: 'Incorrect PIN.' });
    const token = genToken(user.uid);
    const { pin: _, ...safeUser } = user;
    return res.json({ success: true, message: 'Login successful.', token, user: safeUser });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Reset PIN
app.post('/api/auth/reset-pin', async (req, res) => {
  try {
    const { phone, newPin } = req.body;
    const user = DB.users[phone];
    if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
    user.pin = await bcrypt.hash(newPin, 10);
    return res.json({ success: true, message: 'PIN reset successfully.' });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ═══════════════════════════════════════════════════
// USER ROUTES
// ═══════════════════════════════════════════════════

app.get('/api/user/profile', protect, (req, res) => {
  const { pin, ...safe } = req.user;
  return res.json({ success: true, user: safe });
});

app.patch('/api/user/profile', protect, (req, res) => {
  const { name, email } = req.body;
  if (name) req.user.name  = name;
  if (email) req.user.email = email;
  const { pin, ...safe } = req.user;
  return res.json({ success: true, user: safe });
});

app.get('/api/user/loyalty', protect, (req, res) => {
  const u = req.user;
  const tierMap  = { Bronze: 300, Silver: 1000, Gold: 5000, Platinum: 9999999 };
  const nextTier = { Bronze: 'Silver', Silver: 'Gold', Gold: 'Platinum', Platinum: null };
  return res.json({ success: true, loyalty: {
    xp: u.xp || 0, tier: u.tier || 'Bronze',
    nextTier: nextTier[u.tier] || null,
    xpToNext: Math.max(0, (tierMap[u.tier] || 300) - (u.xp || 0)),
    referralCode: u.referralCode,
    referralCount: u.referralCount || 0,
    referralEarnings: u.referralEarnings || 0,
  }});
});

// ═══════════════════════════════════════════════════
// WALLET ROUTES
// ═══════════════════════════════════════════════════

app.get('/api/wallet/balance', protect, (req, res) => {
  return res.json({ success: true, balance: req.user.walletBalance || 0 });
});

app.get('/api/wallet/transactions', protect, (req, res) => {
  const { limit = 20, type } = req.query;
  let txns = DB.transactions.filter(t => t.userId === req.user.uid);
  if (type) txns = txns.filter(t => t.type === type);
  txns = txns.slice(0, Number(limit));
  return res.json({ success: true, transactions: txns });
});

// Fund wallet — initialize Paystack payment
app.post('/api/wallet/fund', protect, async (req, res) => {
  try {
    const { amount } = req.body;
    if (!amount || amount < 100)
      return res.status(400).json({ success: false, message: 'Minimum funding is ₦100.' });

    const paystackKey = process.env.PAYSTACK_SECRET_KEY;
    if (!paystackKey || paystackKey.includes('your_')) {
      // Demo mode — credit wallet directly for testing
      req.user.walletBalance = (req.user.walletBalance || 0) + Number(amount);
      DB.transactions.unshift({
        id: uuidv4(), userId: req.user.uid, type: 'wallet_funding',
        amount: Number(amount), status: 'success',
        createdAt: new Date().toISOString(),
      });
      return res.json({ success: true, message: `Wallet funded with ₦${amount} (demo mode)`, demoMode: true });
    }

    const response = await axios.post('https://api.paystack.co/transaction/initialize', {
      email: req.user.email || req.user.phone + '@dindyz.app',
      amount: Number(amount) * 100,
      metadata: { userId: req.user.uid, phone: req.user.phone },
    }, { headers: { Authorization: `Bearer ${paystackKey}` } });

    return res.json({
      success: true,
      authorizationUrl: response.data.data.authorization_url,
      reference: response.data.data.reference,
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Verify Paystack payment
app.get('/api/wallet/verify/:reference', protect, async (req, res) => {
  try {
    const response = await axios.get(
      `https://api.paystack.co/transaction/verify/${req.params.reference}`,
      { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` } }
    );
    const data = response.data.data;
    if (data.status === 'success') {
      const amount = data.amount / 100;
      req.user.walletBalance = (req.user.walletBalance || 0) + amount;
      DB.transactions.unshift({
        id: uuidv4(), userId: req.user.uid, type: 'wallet_funding',
        amount, paystackRef: req.params.reference, status: 'success',
        createdAt: new Date().toISOString(),
      });
      return res.json({ success: true, message: `Wallet funded with ₦${amount}!`, newBalance: req.user.walletBalance });
    }
    return res.status(400).json({ success: false, message: 'Payment not successful.' });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// Paystack webhook
app.post('/api/wallet/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  res.sendStatus(200);
});

// ═══════════════════════════════════════════════════
// VTU ROUTES (Data, Airtime, Cable, Electricity)
// ═══════════════════════════════════════════════════

const processVTU = async (req, res, type, amount, details, vtFn) => {
  const user = req.user;
  if ((user.walletBalance || 0) < amount)
    return res.status(400).json({ success: false, message: 'Insufficient wallet balance. Please fund your wallet.' });

  // Deduct wallet
  user.walletBalance -= amount;
  user.totalOrders   = (user.totalOrders || 0) + 1;

  const ref   = makeRef();
  const order = {
    id: uuidv4(), ref, userId: user.uid, type, amount, details,
    status: 'pending', createdAt: new Date().toISOString()
  };
  DB.orders.push(order);

  // Call VTPass if keys are set
  let vtResult = { success: true, token: '' };
  const vtKey = process.env.VTPASS_API_KEY;
  if (vtKey && !vtKey.includes('your_')) {
    try { vtResult = await vtFn(); } catch { vtResult = { success: false }; }
  }

  // If VTPass failed — refund
  if (!vtResult.success) {
    user.walletBalance += amount;
    order.status = 'failed';
    DB.transactions.unshift({ id: uuidv4(), userId: user.uid, ref, type, amount, details, status: 'failed', createdAt: new Date().toISOString() });
    return res.status(400).json({ success: false, message: 'Order failed. You have been refunded.' });
  }

  // Success
  order.status = 'success';
  const xpMap  = { data: 10, airtime: 5, cable: 8, electricity: 8, gift: 15 };
  user.xp      = (user.xp || 0) + (xpMap[type] || 5);
  user.totalSpent = (user.totalSpent || 0) + amount;
  updateTier(user);

  DB.transactions.unshift({
    id: uuidv4(), userId: user.uid, ref, type, amount, details,
    status: 'success', token: vtResult.token || '',
    createdAt: new Date().toISOString()
  });

  return res.json({ success: true, ref, status: 'success', token: vtResult.token, message: 'Order completed successfully!' });
};

// Buy Data
app.post('/api/vtu/data', protect, async (req, res) => {
  const { phone, network, variationCode, amount, size, giftMessage } = req.body;
  if (!phone || !network || !amount) return res.status(400).json({ success: false, message: 'Missing required fields.' });
  await processVTU(req, res, 'data', Number(amount), { phone, network, size, giftMessage }, async () => {
    const serviceID = { MTN:'mtn-data', Airtel:'airtel-data', Glo:'glo-data', '9Mobile':'etisalat-data' }[network];
    const r = await axios.post(`${process.env.VTPASS_BASE_URL}/pay`, {
      request_id: 'DD'+Date.now(), serviceID, billersCode: phone, variation_code: variationCode, amount, phone
    }, { headers: { 'api-key': process.env.VTPASS_API_KEY, 'secret-key': process.env.VTPASS_SECRET_KEY } });
    return { success: r.data?.content?.transactions?.status === 'delivered' };
  });
});

// Buy Airtime
app.post('/api/vtu/airtime', protect, async (req, res) => {
  const { phone, network, amount } = req.body;
  if (!phone || !network || !amount) return res.status(400).json({ success: false, message: 'Missing required fields.' });
  if (amount < 50) return res.status(400).json({ success: false, message: 'Minimum airtime is ₦50.' });
  await processVTU(req, res, 'airtime', Number(amount), { phone, network }, async () => {
    const serviceID = { MTN:'mtn', Airtel:'airtel', Glo:'glo', '9Mobile':'etisalat' }[network];
    const r = await axios.post(`${process.env.VTPASS_BASE_URL}/pay`, {
      request_id: 'DD'+Date.now(), serviceID, billersCode: phone, variation_code: serviceID, amount, phone
    }, { headers: { 'api-key': process.env.VTPASS_API_KEY, 'secret-key': process.env.VTPASS_SECRET_KEY } });
    return { success: r.data?.content?.transactions?.status === 'delivered' };
  });
});

// Pay Cable TV
app.post('/api/vtu/cable', protect, async (req, res) => {
  const { smartCard, provider, variationCode, amount, phone } = req.body;
  if (!smartCard || !provider || !amount) return res.status(400).json({ success: false, message: 'Missing required fields.' });
  await processVTU(req, res, 'cable', Number(amount), { smartCard, provider, variationCode }, async () => {
    const serviceID = { DStv:'dstv', GOtv:'gotv', Startimes:'startimes' }[provider];
    const r = await axios.post(`${process.env.VTPASS_BASE_URL}/pay`, {
      request_id: 'DD'+Date.now(), serviceID, billersCode: smartCard, variation_code: variationCode, amount, phone: phone || req.user.phone, subscription_type: 'change'
    }, { headers: { 'api-key': process.env.VTPASS_API_KEY, 'secret-key': process.env.VTPASS_SECRET_KEY } });
    return { success: r.data?.content?.transactions?.status === 'delivered' };
  });
});

// Pay Electricity
app.post('/api/vtu/electricity', protect, async (req, res) => {
  const { meterNumber, disco, meterType, amount } = req.body;
  if (!meterNumber || !disco || !amount) return res.status(400).json({ success: false, message: 'Missing required fields.' });
  if (amount < 500) return res.status(400).json({ success: false, message: 'Minimum is ₦500.' });
  await processVTU(req, res, 'electricity', Number(amount), { meterNumber, disco, meterType }, async () => {
    const discoMap = { 'Jos (JED)':'jos-electric','Abuja (AEDC)':'abuja-electric','Lagos (EKEDC)':'eko-electric','Ikeja (IKEDC)':'ikeja-electric','Ibadan (IBEDC)':'ibadan-electric','Kano (KEDC)':'kano-electric','Enugu (EEDC)':'enugu-electric','Port Harcourt (PHEDC)':'phed','Kaduna (KAEDCO)':'kaduna-electric' };
    const serviceID = discoMap[disco];
    const r = await axios.post(`${process.env.VTPASS_BASE_URL}/pay`, {
      request_id: 'DD'+Date.now(), serviceID, billersCode: meterNumber, variation_code: meterType, amount, phone: req.user.phone
    }, { headers: { 'api-key': process.env.VTPASS_API_KEY, 'secret-key': process.env.VTPASS_SECRET_KEY } });
    const token = r.data?.content?.transactions?.product_name || '';
    return { success: r.data?.content?.transactions?.status === 'delivered', token };
  });
});

// ═══════════════════════════════════════════════════
// ADMIN ROUTES
// ═══════════════════════════════════════════════════

app.get('/api/admin/stats', protect, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ success: false, message: 'Admin only.' });
  const users = Object.values(DB.users).filter((u,i,a) => a.findIndex(x=>x.uid===u.uid)===i);
  const txns  = DB.transactions;
  return res.json({ success: true, stats: {
    totalUsers: users.length,
    totalRevenue: txns.filter(t=>t.type!=='wallet_funding').reduce((s,t)=>s+(t.amount||0),0),
    totalOrders: DB.orders.filter(o=>o.status==='success').length,
    totalDeposits: txns.filter(t=>t.type==='wallet_funding').reduce((s,t)=>s+(t.amount||0),0),
  }});
});

app.get('/api/admin/users', protect, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ success: false, message: 'Admin only.' });
  const users = Object.values(DB.users)
    .filter((u,i,a) => a.findIndex(x=>x.uid===u.uid)===i)
    .map(({ pin, ...u }) => u);
  return res.json({ success: true, users });
});

app.get('/api/admin/transactions', protect, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ success: false, message: 'Admin only.' });
  return res.json({ success: true, transactions: DB.transactions.slice(0, 100) });
});

// ── Start ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ Dindyz Data API running on port ${PORT}`);
  console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`📡 Health check: http://localhost:${PORT}/api/health`);
});

module.exports = app;
