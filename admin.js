// routes/admin.js
// Admin-only endpoints powering the Dindyz Admin Dashboard

const express = require('express');
const { protect, adminOnly } = require('../middleware/auth');
const { collections } = require('../config/firebase');
const vtpass = require('../services/vtpass');

const router = express.Router();
router.use(protect, adminOnly);

// ── GET /api/admin/stats ──────────────────────────────────────
// Dashboard overview numbers
router.get('/stats', async (req, res) => {
  try {
    const [usersSnap, txnSnap, ordersSnap] = await Promise.all([
      collections.users.get(),
      collections.transactions.orderBy('createdAt', 'desc').limit(500).get(),
      collections.orders.where('status', '==', 'success').get(),
    ]);

    const txns = txnSnap.docs.map(d => d.data());
    const revenue = txns.filter(t => t.type !== 'wallet_funding').reduce((s, t) => s + (t.amount || 0), 0);
    const profit  = txns.filter(t => t.type !== 'wallet_funding').reduce((s, t) => s + (t.profit || 0), 0);
    const deposits = txns.filter(t => t.type === 'wallet_funding').reduce((s, t) => s + (t.amount || 0), 0);
    const failed = await collections.orders.where('status', '==', 'failed').get();

    return res.json({
      success: true,
      stats: {
        totalUsers: usersSnap.size,
        totalRevenue: revenue,
        totalProfit: profit,
        totalDeposits: deposits,
        totalOrders: ordersSnap.size,
        failedOrders: failed.size,
        successRate: ordersSnap.size > 0 ? ((ordersSnap.size / (ordersSnap.size + failed.size)) * 100).toFixed(1) : 100,
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /api/admin/transactions ───────────────────────────────
router.get('/transactions', async (req, res) => {
  try {
    const { limit = 50, type, status, startDate, endDate } = req.query;
    let query = collections.transactions.orderBy('createdAt', 'desc').limit(Number(limit));
    if (type) query = query.where('type', '==', type);
    if (status) query = query.where('status', '==', status);

    const snap = await query.get();
    const transactions = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    return res.json({ success: true, transactions });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /api/admin/users ──────────────────────────────────────
router.get('/users', async (req, res) => {
  try {
    const { limit = 50, tier, status } = req.query;
    let query = collections.users.orderBy('createdAt', 'desc').limit(Number(limit));
    if (tier) query = query.where('tier', '==', tier);
    if (status) query = query.where('status', '==', status);

    const snap = await query.get();
    const users = snap.docs.map(d => {
      const u = d.data();
      const { pin, ...safe } = u;
      return safe;
    });
    return res.json({ success: true, users });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ── PATCH /api/admin/users/:uid ───────────────────────────────
router.patch('/users/:uid', async (req, res) => {
  try {
    const { status, tier, walletBalance } = req.body;
    const updates = {};
    if (status) updates.status = status;
    if (tier) updates.tier = tier;
    if (walletBalance !== undefined) updates.walletBalance = walletBalance;

    await collections.users.doc(req.params.uid).update(updates);
    return res.json({ success: true, message: 'User updated.' });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /api/admin/refund ────────────────────────────────────
router.post('/refund', async (req, res) => {
  try {
    const { orderId } = req.body;
    const orderDoc = await collections.orders.doc(orderId).get();
    if (!orderDoc.exists) return res.status(404).json({ success: false, message: 'Order not found.' });

    const order = orderDoc.data();
    if (order.status === 'refunded') return res.status(400).json({ success: false, message: 'Already refunded.' });

    // Credit user wallet
    const userDoc = await collections.users.doc(order.userId).get();
    const currentBal = userDoc.data()?.walletBalance || 0;
    await collections.users.doc(order.userId).update({
      walletBalance: currentBal + order.amount,
    });

    // Update order status
    await collections.orders.doc(orderId).update({ status: 'refunded', refundedAt: new Date().toISOString() });

    // Record refund transaction
    await collections.transactions.add({
      userId: order.userId,
      type: 'refund',
      amount: order.amount,
      orderId,
      status: 'success',
      createdAt: new Date().toISOString(),
    });

    return res.json({ success: true, message: `₦${order.amount} refunded to user.` });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /api/admin/vtpass-balance ─────────────────────────────
router.get('/vtpass-balance', async (req, res) => {
  try {
    const result = await vtpass.getBalance();
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /api/admin/revenue-chart ──────────────────────────────
router.get('/revenue-chart', async (req, res) => {
  try {
    const { days = 7 } = req.query;
    const since = new Date();
    since.setDate(since.getDate() - Number(days));

    const snap = await collections.transactions
      .where('createdAt', '>=', since.toISOString())
      .where('type', '!=', 'wallet_funding')
      .get();

    // Group by date
    const map = {};
    snap.docs.forEach(d => {
      const date = d.data().createdAt?.split('T')[0];
      if (!map[date]) map[date] = { revenue: 0, profit: 0 };
      map[date].revenue += d.data().amount || 0;
      map[date].profit += d.data().profit || 0;
    });

    const chart = Object.entries(map).sort().map(([date, vals]) => ({ date, ...vals }));
    return res.json({ success: true, chart });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
