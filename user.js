// routes/user.js
// User profile, transaction history, loyalty, referrals

const express = require('express');
const { protect } = require('../middleware/auth');
const { collections } = require('../config/firebase');

const router = express.Router();
router.use(protect);

// ── GET /api/user/profile ────────────────────────────────────
router.get('/profile', async (req, res) => {
  try {
    const userDoc = await collections.users.doc(req.user.uid).get();
    const { pin, ...safe } = userDoc.data();
    return res.json({ success: true, user: safe });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ── PATCH /api/user/profile ──────────────────────────────────
router.patch('/profile', async (req, res) => {
  try {
    const { name, email } = req.body;
    const updates = {};
    if (name) updates.name = name;
    if (email) updates.email = email;
    await collections.users.doc(req.user.uid).update(updates);
    return res.json({ success: true, message: 'Profile updated.' });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /api/user/transactions ───────────────────────────────
router.get('/transactions', async (req, res) => {
  try {
    const { limit = 20, type } = req.query;
    let query = collections.transactions
      .where('userId', '==', req.user.uid)
      .orderBy('createdAt', 'desc')
      .limit(Number(limit));
    if (type) query = query.where('type', '==', type);
    const snap = await query.get();
    return res.json({ success: true, transactions: snap.docs.map(d => ({ id: d.id, ...d.data() })) });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /api/user/loyalty ────────────────────────────────────
router.get('/loyalty', async (req, res) => {
  try {
    const userDoc = await collections.users.doc(req.user.uid).get();
    const { xp, tier, referralCode, referralCount, referralEarnings } = userDoc.data();
    const tiers = { Bronze: 0, Silver: 300, Gold: 1000, Platinum: 5000 };
    const tierNames = Object.keys(tiers);
    const currentIndex = tierNames.indexOf(tier);
    const nextTier = tierNames[currentIndex + 1];
    const xpToNext = nextTier ? tiers[nextTier] - xp : 0;

    return res.json({
      success: true,
      loyalty: { xp, tier, nextTier, xpToNext, referralCode, referralCount, referralEarnings },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /api/user/redeem ────────────────────────────────────
const rewards = [
  { id: 'r1', name: '100MB Free Data', cost: 200, type: 'data', value: '100mb' },
  { id: 'r2', name: '₦500 Cashback', cost: 500, type: 'cash', value: 500 },
  { id: 'r3', name: '1GB Free Data', cost: 800, type: 'data', value: '1gb' },
  { id: 'r4', name: '₦1,500 Cashback', cost: 1200, type: 'cash', value: 1500 },
];

router.post('/redeem', async (req, res) => {
  try {
    const { rewardId } = req.body;
    const reward = rewards.find(r => r.id === rewardId);
    if (!reward) return res.status(404).json({ success: false, message: 'Reward not found.' });

    const userDoc = await collections.users.doc(req.user.uid).get();
    const { xp, walletBalance } = userDoc.data();

    if (xp < reward.cost) {
      return res.status(400).json({ success: false, message: `Not enough XP. Need ${reward.cost}, have ${xp}.` });
    }

    const updates = { xp: xp - reward.cost };
    if (reward.type === 'cash') updates.walletBalance = walletBalance + reward.value;

    await collections.users.doc(req.user.uid).update(updates);

    return res.json({ success: true, message: `${reward.name} redeemed successfully!`, reward });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /api/user/schedules ──────────────────────────────────
router.get('/schedules', async (req, res) => {
  try {
    const snap = await collections.schedules.where('userId', '==', req.user.uid).get();
    return res.json({ success: true, schedules: snap.docs.map(d => ({ id: d.id, ...d.data() })) });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /api/user/schedules ─────────────────────────────────
router.post('/schedules', async (req, res) => {
  try {
    const { type, details, frequency, nextRun } = req.body;
    const doc = await collections.schedules.add({
      userId: req.user.uid,
      type, details, frequency, nextRun,
      active: true,
      createdAt: new Date().toISOString(),
    });
    return res.status(201).json({ success: true, scheduleId: doc.id });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
