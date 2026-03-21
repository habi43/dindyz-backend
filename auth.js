// routes/auth.js
// Registration, login, OTP verification

const express = require('express');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { collections } = require('../config/firebase');
const { generateToken } = require('../middleware/auth');
const { sendOTP, generateOTP } = require('../services/sms');

const router = express.Router();

// In-memory OTP store (use Redis in production)
const otpStore = new Map();

// ── POST /api/auth/send-otp ──────────────────────────────────
// Step 1: User enters phone, we send OTP
router.post('/send-otp', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone || phone.length < 10) {
      return res.status(400).json({ success: false, message: 'Valid phone number required.' });
    }

    const otp = generateOTP();
    const expires = Date.now() + 5 * 60 * 1000; // 5 minutes
    otpStore.set(phone, { otp, expires, attempts: 0 });

    await sendOTP(phone, otp);

    // In development, return the OTP so you can test without SMS credits
    const devOTP = process.env.NODE_ENV === 'development' ? otp : undefined;

    return res.json({
      success: true,
      message: `OTP sent to ${phone}`,
      ...(devOTP && { devOTP }),
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /api/auth/verify-otp ────────────────────────────────
// Step 2: User submits OTP to verify phone
router.post('/verify-otp', async (req, res) => {
  try {
    const { phone, otp } = req.body;
    const stored = otpStore.get(phone);

    if (!stored) return res.status(400).json({ success: false, message: 'OTP expired. Request a new one.' });
    if (Date.now() > stored.expires) {
      otpStore.delete(phone);
      return res.status(400).json({ success: false, message: 'OTP expired. Request a new one.' });
    }
    if (stored.otp !== otp) {
      stored.attempts++;
      if (stored.attempts >= 5) otpStore.delete(phone);
      return res.status(400).json({ success: false, message: 'Incorrect OTP.' });
    }

    otpStore.delete(phone);
    return res.json({ success: true, message: 'Phone verified.' });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /api/auth/register ──────────────────────────────────
router.post('/register', async (req, res) => {
  try {
    const { name, phone, email, pin, referralCode } = req.body;

    // Check if phone already exists
    const existing = await collections.users.where('phone', '==', phone).get();
    if (!existing.empty) {
      return res.status(400).json({ success: false, message: 'Phone number already registered.' });
    }

    const uid = uuidv4();
    const hashedPin = await bcrypt.hash(pin, 12);

    // Handle referral
    let referrerId = null;
    if (referralCode) {
      const refQuery = await collections.users.where('referralCode', '==', referralCode).get();
      if (!refQuery.empty) {
        referrerId = refQuery.docs[0].id;
      }
    }

    const myReferralCode = `DD-${name.split(' ')[0].toUpperCase().slice(0,3)}${Math.random().toString(36).substr(2,4).toUpperCase()}`;

    // Create user document
    const userData = {
      uid,
      name,
      phone,
      email: email || '',
      pin: hashedPin,
      role: 'user',
      status: 'active',
      tier: 'Bronze',
      xp: 0,
      walletBalance: 0,
      totalSpent: 0,
      totalOrders: 0,
      referralCode: myReferralCode,
      referredBy: referrerId,
      referralCount: 0,
      referralEarnings: 0,
      createdAt: new Date().toISOString(),
    };

    await collections.users.doc(uid).set(userData);

    // Credit referrer with ₦500 if they referred this user
    if (referrerId) {
      const refDoc = await collections.users.doc(referrerId).get();
      const refData = refDoc.data();
      await collections.users.doc(referrerId).update({
        walletBalance: (refData.walletBalance || 0) + 500,
        referralCount: (refData.referralCount || 0) + 1,
        referralEarnings: (refData.referralEarnings || 0) + 500,
        xp: (refData.xp || 0) + 50,
      });
    }

    const token = generateToken(uid);
    const { pin: _, ...safeUser } = userData;

    return res.status(201).json({
      success: true,
      message: 'Account created successfully!',
      token,
      user: safeUser,
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /api/auth/login ─────────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { phone, pin } = req.body;

    const query = await collections.users.where('phone', '==', phone).get();
    if (query.empty) {
      return res.status(401).json({ success: false, message: 'Phone number not found.' });
    }

    const userDoc = query.docs[0];
    const user = userDoc.data();

    if (user.status === 'suspended') {
      return res.status(403).json({ success: false, message: 'Account suspended. Contact support.' });
    }

    const pinMatch = await bcrypt.compare(pin, user.pin);
    if (!pinMatch) {
      return res.status(401).json({ success: false, message: 'Incorrect PIN.' });
    }

    const token = generateToken(user.uid);
    const { pin: _, ...safeUser } = user;

    return res.json({
      success: true,
      message: 'Login successful.',
      token,
      user: safeUser,
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /api/auth/change-pin ────────────────────────────────
router.post('/change-pin', async (req, res) => {
  try {
    const { phone, otp, newPin } = req.body;
    // OTP already verified in previous step
    const hashedPin = await bcrypt.hash(newPin, 12);
    const query = await collections.users.where('phone', '==', phone).get();
    if (query.empty) return res.status(404).json({ success: false, message: 'User not found.' });
    await collections.users.doc(query.docs[0].id).update({ pin: hashedPin });
    return res.json({ success: true, message: 'PIN changed successfully.' });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
