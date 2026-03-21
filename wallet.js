// routes/wallet.js
// Wallet funding via Paystack, balance, and transaction history

const express = require('express');
const { protect } = require('../middleware/auth');
const { collections } = require('../config/firebase');
const { initializePayment, verifyPayment, verifyWebhookSignature } = require('../services/paystack');
const { sendTransactionSMS } = require('../services/sms');

const router = express.Router();

// ── GET /api/wallet/balance ──────────────────────────────────
router.get('/balance', protect, async (req, res) => {
  try {
    const userDoc = await collections.users.doc(req.user.uid).get();
    const balance = userDoc.data()?.walletBalance || 0;
    return res.json({ success: true, balance });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /api/wallet/fund ────────────────────────────────────
// Initialize Paystack payment — returns a checkout URL
router.post('/fund', protect, async (req, res) => {
  try {
    const { amount } = req.body;
    if (!amount || amount < 100) {
      return res.status(400).json({ success: false, message: 'Minimum funding amount is ₦100.' });
    }

    const result = await initializePayment({
      email: req.user.email || `${req.user.phone}@dindyz.app`,
      amount: Number(amount),
      userId: req.user.uid,
      phone: req.user.phone,
      callbackUrl: `${process.env.FRONTEND_URL || 'https://dindyzdata.com'}/payment/verify`,
    });

    return res.json(result);
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /api/wallet/verify/:reference ───────────────────────
// Called after Paystack redirects back — credits the wallet
router.get('/verify/:reference', protect, async (req, res) => {
  try {
    const { reference } = req.params;

    // Check if this reference was already processed (prevent double-credit)
    const existing = await collections.transactions
      .where('paystackRef', '==', reference).get();
    if (!existing.empty) {
      return res.json({ success: true, message: 'Payment already verified.', alreadyProcessed: true });
    }

    const payment = await verifyPayment(reference);
    if (!payment.success) {
      return res.status(400).json({ success: false, message: 'Payment not successful.' });
    }

    // Credit wallet
    const userDoc = await collections.users.doc(req.user.uid).get();
    const currentBalance = userDoc.data()?.walletBalance || 0;
    await collections.users.doc(req.user.uid).update({
      walletBalance: currentBalance + payment.amount,
    });

    // Record transaction
    await collections.transactions.add({
      userId: req.user.uid,
      type: 'wallet_funding',
      amount: payment.amount,
      paystackRef: reference,
      channel: payment.channel,
      status: 'success',
      createdAt: new Date().toISOString(),
    });

    // SMS confirmation
    await sendTransactionSMS(
      req.user.phone,
      `Dindyz: Your wallet has been funded with ₦${payment.amount.toLocaleString()}. New balance: ₦${(currentBalance + payment.amount).toLocaleString()}. Ref: ${reference}`
    );

    return res.json({
      success: true,
      message: `Wallet funded with ₦${payment.amount.toLocaleString()}!`,
      newBalance: currentBalance + payment.amount,
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /api/wallet/webhook ─────────────────────────────────
// Paystack webhook — fires automatically when payment succeeds
// This is more reliable than the redirect (handles users who close browser)
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const signature = req.headers['x-paystack-signature'];
    const payload = req.body;

    if (!verifyWebhookSignature(payload, signature)) {
      return res.status(400).json({ message: 'Invalid signature.' });
    }

    const event = JSON.parse(payload);

    if (event.event === 'charge.success') {
      const { reference, amount, metadata } = event.data;
      const userId = metadata?.userId;
      const nairaAmount = amount / 100;

      // Check not already processed
      const existing = await collections.transactions
        .where('paystackRef', '==', reference).get();
      if (!existing.empty) return res.sendStatus(200);

      if (userId) {
        const userDoc = await collections.users.doc(userId).get();
        if (userDoc.exists) {
          const currentBalance = userDoc.data()?.walletBalance || 0;
          await collections.users.doc(userId).update({
            walletBalance: currentBalance + nairaAmount,
          });
          await collections.transactions.add({
            userId,
            type: 'wallet_funding',
            amount: nairaAmount,
            paystackRef: reference,
            status: 'success',
            createdAt: new Date().toISOString(),
          });
        }
      }
    }

    return res.sendStatus(200);
  } catch (err) {
    console.error('Webhook error:', err.message);
    return res.sendStatus(200); // Always return 200 to Paystack
  }
});

// ── GET /api/wallet/transactions ─────────────────────────────
router.get('/transactions', protect, async (req, res) => {
  try {
    const { limit = 20, type } = req.query;
    let query = collections.transactions
      .where('userId', '==', req.user.uid)
      .orderBy('createdAt', 'desc')
      .limit(Number(limit));

    if (type) query = query.where('type', '==', type);

    const snap = await query.get();
    const transactions = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    return res.json({ success: true, transactions });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
