// services/sms.js
// Sends OTP via Termii (Nigerian SMS API) for phone number verification

const axios = require('axios');

// ── Send OTP SMS ─────────────────────────────────────────────
const sendOTP = async (phone, otp) => {
  try {
    const res = await axios.post('https://api.ng.termii.com/api/sms/send', {
      to: phone,
      from: process.env.TERMII_SENDER_ID || 'Dindyz',
      sms: `Your Dindyz Data verification code is: ${otp}. Valid for 5 minutes. Do not share this code.`,
      type: 'plain',
      channel: 'generic',
      api_key: process.env.TERMII_API_KEY,
    });
    return { success: true, messageId: res.data?.message_id };
  } catch (err) {
    console.error('SMS Error:', err.message);
    return { success: false, error: err.message };
  }
};

// ── Send transaction notification SMS ───────────────────────
const sendTransactionSMS = async (phone, message) => {
  try {
    await axios.post('https://api.ng.termii.com/api/sms/send', {
      to: phone,
      from: process.env.TERMII_SENDER_ID || 'Dindyz',
      sms: message,
      type: 'plain',
      channel: 'generic',
      api_key: process.env.TERMII_API_KEY,
    });
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
};

// ── Generate a random 6-digit OTP ───────────────────────────
const generateOTP = () => String(Math.floor(100000 + Math.random() * 900000));

module.exports = { sendOTP, sendTransactionSMS, generateOTP };
