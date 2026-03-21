// services/paystack.js
// Handles wallet funding via Paystack — users pay here, wallet is credited

const axios = require('axios');

const BASE_URL = 'https://api.paystack.co';

const getHeaders = () => ({
  Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
  'Content-Type': 'application/json',
});

// ── Initialize a payment (get checkout URL) ──────────────────
// Called when user clicks "Fund Wallet"
const initializePayment = async ({ email, amount, userId, phone, callbackUrl }) => {
  try {
    const res = await axios.post(`${BASE_URL}/transaction/initialize`, {
      email,
      amount: amount * 100,   // Paystack works in kobo (multiply by 100)
      currency: 'NGN',
      callback_url: callbackUrl || `${process.env.FRONTEND_URL}/payment/verify`,
      metadata: {
        userId,
        phone,
        type: 'wallet_funding',
        custom_fields: [
          { display_name: 'Phone', variable_name: 'phone', value: phone },
          { display_name: 'User ID', variable_name: 'userId', value: userId },
        ],
      },
    }, { headers: getHeaders() });

    return {
      success: true,
      authorizationUrl: res.data.data.authorization_url,
      accessCode: res.data.data.access_code,
      reference: res.data.data.reference,
    };
  } catch (err) {
    return { success: false, error: err.response?.data?.message || err.message };
  }
};

// ── Verify a payment after redirect ─────────────────────────
// Called when Paystack redirects back to your site
const verifyPayment = async (reference) => {
  try {
    const res = await axios.get(
      `${BASE_URL}/transaction/verify/${reference}`,
      { headers: getHeaders() }
    );

    const data = res.data.data;
    return {
      success: data.status === 'success',
      amount: data.amount / 100,  // convert back from kobo to naira
      reference: data.reference,
      userId: data.metadata?.userId,
      email: data.customer?.email,
      channel: data.channel,  // card, bank_transfer, ussd, etc.
      rawData: data,
    };
  } catch (err) {
    return { success: false, error: err.response?.data?.message || err.message };
  }
};

// ── Verify Paystack webhook signature ────────────────────────
// IMPORTANT: Always verify webhooks to prevent fraud
const verifyWebhookSignature = (payload, signature) => {
  const crypto = require('crypto');
  const hash = crypto
    .createHmac('sha512', process.env.PAYSTACK_SECRET_KEY)
    .update(JSON.stringify(payload))
    .digest('hex');
  return hash === signature;
};

module.exports = { initializePayment, verifyPayment, verifyWebhookSignature };
