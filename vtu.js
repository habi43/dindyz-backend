// routes/vtu.js
// All VTU purchase endpoints — data, airtime, cable TV, electricity

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { protect } = require('../middleware/auth');
const { collections } = require('../config/firebase');
const vtpass = require('../services/vtpass');
const { sendTransactionSMS } = require('../services/sms');

const router = express.Router();
// All VTU routes require the user to be logged in
router.use(protect);

// ── Helper: deduct wallet and record transaction ─────────────
const processOrder = async ({ userId, user, amount, type, details, vtpassFn }) => {
  // 1. Check wallet balance
  if (user.walletBalance < amount) {
    return { success: false, message: 'Insufficient wallet balance. Please fund your wallet.' };
  }

  // 2. Create a pending order record
  const orderId = uuidv4();
  const ref = `DD-${Date.now().toString(36).toUpperCase()}`;

  await collections.orders.doc(orderId).set({
    orderId, ref, userId,
    type, amount, details,
    status: 'pending',
    createdAt: new Date().toISOString(),
  });

  // 3. Deduct wallet (hold the funds)
  await collections.users.doc(userId).update({
    walletBalance: user.walletBalance - amount,
  });

  // 4. Call VTPass API
  const vtResult = await vtpassFn();

  // 5. Determine outcome
  const success = vtResult.success;
  const finalStatus = success ? 'success' : 'failed';

  // 6. If failed, refund the user immediately
  if (!success) {
    await collections.users.doc(userId).update({
      walletBalance: user.walletBalance, // full refund
    });
  }

  // 7. Calculate profit margin (your selling price minus VTPass cost)
  const costMap = { data: 0.78, airtime: 0.97, cable: 0.90, electricity: 0.92 };
  const costRatio = costMap[type] || 0.85;
  const profit = Math.round(amount * (1 - costRatio));

  // 8. Update order record with final status
  await collections.orders.doc(orderId).update({
    status: finalStatus,
    vtpassRef: vtResult.reference || '',
    token: vtResult.token || '',
    profit: success ? profit : 0,
    completedAt: new Date().toISOString(),
  });

  // 9. Record transaction in transactions collection
  await collections.transactions.add({
    ref, orderId, userId,
    type, amount, profit: success ? profit : 0,
    details, status: finalStatus,
    vtpassRef: vtResult.reference || '',
    createdAt: new Date().toISOString(),
  });

  // 10. Update user stats if successful
  if (success) {
    const xpMap = { data: 10, airtime: 5, cable: 8, electricity: 8 };
    await collections.users.doc(userId).update({
      totalSpent: (user.totalSpent || 0) + amount,
      totalOrders: (user.totalOrders || 0) + 1,
      xp: (user.xp || 0) + (xpMap[type] || 5),
    });

    // Update loyalty tier
    await updateTier(userId);

    // Send SMS confirmation
    const smsMessages = {
      data: `Dindyz: ${details.size} data bundle activated on ${details.phone}. Ref: ${ref}`,
      airtime: `Dindyz: ₦${amount} ${details.network} airtime sent to ${details.phone}. Ref: ${ref}`,
      cable: `Dindyz: ${details.provider} ${details.package} activated for ${details.smartCard}. Ref: ${ref}`,
      electricity: `Dindyz: ₦${amount} electricity token for meter ${details.meterNumber}. Token: ${vtResult.token || 'Sent to meter'}. Ref: ${ref}`,
    };
    await sendTransactionSMS(user.phone, smsMessages[type] || `Dindyz: Order ${ref} completed.`);
  }

  return {
    success,
    ref,
    status: finalStatus,
    token: vtResult.token,
    message: success ? 'Order completed successfully!' : 'Order failed. You have been refunded.',
    error: vtResult.error,
  };
};

// ── Update user loyalty tier based on XP ────────────────────
const updateTier = async (userId) => {
  const userDoc = await collections.users.doc(userId).get();
  const xp = userDoc.data()?.xp || 0;
  let tier = 'Bronze';
  if (xp >= 5000) tier = 'Platinum';
  else if (xp >= 1000) tier = 'Gold';
  else if (xp >= 300) tier = 'Silver';
  await collections.users.doc(userId).update({ tier });
};

// ── POST /api/vtu/data ───────────────────────────────────────
router.post('/data', async (req, res) => {
  try {
    const { phone, network, variationCode, amount, size, giftMessage } = req.body;
    if (!phone || !network || !variationCode || !amount) {
      return res.status(400).json({ success: false, message: 'Missing required fields.' });
    }

    const serviceID = vtpass.networkToDataServiceID[network];
    if (!serviceID) return res.status(400).json({ success: false, message: 'Invalid network.' });

    const result = await processOrder({
      userId: req.user.uid,
      user: req.user,
      amount: Number(amount),
      type: 'data',
      details: { phone, network, size, variationCode, giftMessage: giftMessage || '' },
      vtpassFn: () => vtpass.buyData({ phone, serviceID, variationCode, amount }),
    });

    return res.status(result.success ? 200 : 400).json(result);
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /api/vtu/airtime ────────────────────────────────────
router.post('/airtime', async (req, res) => {
  try {
    const { phone, network, amount } = req.body;
    if (!phone || !network || !amount) {
      return res.status(400).json({ success: false, message: 'Missing required fields.' });
    }
    if (amount < 50) return res.status(400).json({ success: false, message: 'Minimum airtime is ₦50.' });

    const serviceID = vtpass.networkToAirtimeServiceID[network];
    if (!serviceID) return res.status(400).json({ success: false, message: 'Invalid network.' });

    const result = await processOrder({
      userId: req.user.uid,
      user: req.user,
      amount: Number(amount),
      type: 'airtime',
      details: { phone, network },
      vtpassFn: () => vtpass.buyAirtime({ phone, serviceID, amount }),
    });

    return res.status(result.success ? 200 : 400).json(result);
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /api/vtu/cable ──────────────────────────────────────
router.post('/cable', async (req, res) => {
  try {
    const { smartCard, provider, variationCode, amount, phone } = req.body;
    if (!smartCard || !provider || !variationCode || !amount) {
      return res.status(400).json({ success: false, message: 'Missing required fields.' });
    }

    const serviceIDMap = { DStv: 'dstv', GOtv: 'gotv', Startimes: 'startimes' };
    const serviceID = serviceIDMap[provider];
    if (!serviceID) return res.status(400).json({ success: false, message: 'Invalid provider.' });

    const result = await processOrder({
      userId: req.user.uid,
      user: req.user,
      amount: Number(amount),
      type: 'cable',
      details: { smartCard, provider, variationCode, package: variationCode },
      vtpassFn: () => vtpass.payCable({ smartCardNumber: smartCard, serviceID, variationCode, amount, phone: phone || req.user.phone }),
    });

    return res.status(result.success ? 200 : 400).json(result);
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /api/vtu/electricity ────────────────────────────────
router.post('/electricity', async (req, res) => {
  try {
    const { meterNumber, disco, meterType, amount, phone } = req.body;
    if (!meterNumber || !disco || !meterType || !amount) {
      return res.status(400).json({ success: false, message: 'Missing required fields.' });
    }
    if (amount < 500) return res.status(400).json({ success: false, message: 'Minimum electricity purchase is ₦500.' });

    const discoMap = {
      'Jos (JED)': 'jos-electric',
      'Abuja (AEDC)': 'abuja-electric',
      'Lagos (EKEDC)': 'eko-electric',
      'Ikeja (IKEDC)': 'ikeja-electric',
      'Ibadan (IBEDC)': 'ibadan-electric',
      'Kano (KEDC)': 'kano-electric',
      'Enugu (EEDC)': 'enugu-electric',
      'Port Harcourt (PHEDC)': 'phed',
      'Kaduna (KAEDCO)': 'kaduna-electric',
    };
    const serviceID = discoMap[disco];
    if (!serviceID) return res.status(400).json({ success: false, message: 'Invalid Disco.' });

    const result = await processOrder({
      userId: req.user.uid,
      user: req.user,
      amount: Number(amount),
      type: 'electricity',
      details: { meterNumber, disco, meterType },
      vtpassFn: () => vtpass.payElectricity({ meterNumber, serviceID, variationCode: meterType, amount, phone: phone || req.user.phone }),
    });

    return res.status(result.success ? 200 : 400).json(result);
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /api/vtu/variations/:serviceID ──────────────────────
router.get('/variations/:serviceID', async (req, res) => {
  try {
    const result = await vtpass.getVariations(req.params.serviceID);
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /api/vtu/verify-meter ───────────────────────────────
router.post('/verify-meter', async (req, res) => {
  try {
    const { meterNumber, serviceID, type } = req.body;
    const result = await vtpass.verifyMeter(meterNumber, serviceID, type);
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
