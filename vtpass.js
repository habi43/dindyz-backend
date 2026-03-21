// services/vtpass.js
// All VTU purchases go through this service — data, airtime, cable, electricity

const axios = require('axios');

const BASE_URL = process.env.VTPASS_BASE_URL || 'https://sandbox.vtpass.com/api';

// Auth headers for every VTPass request
const getHeaders = () => ({
  'api-key': process.env.VTPASS_API_KEY,
  'secret-key': process.env.VTPASS_SECRET_KEY,
  'Content-Type': 'application/json',
});

// Generate a unique request ID for every transaction
const makeRequestId = () => {
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `DD${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}${Math.floor(Math.random()*9999)}`;
};

// ── Check VTPass wallet balance ──────────────────────────────
const getBalance = async () => {
  try {
    const res = await axios.get(`${BASE_URL}/balance`, { headers: getHeaders() });
    return { success: true, balance: res.data?.contents?.balance || 0 };
  } catch (err) {
    return { success: false, error: err.message };
  }
};

// ── Verify a meter number or smart card before purchase ──────
const verifyMeter = async (meterNumber, serviceID, type) => {
  try {
    const res = await axios.post(`${BASE_URL}/merchant-verify`, {
      billersCode: meterNumber,
      serviceID,
      type,
    }, { headers: getHeaders() });
    return { success: true, data: res.data };
  } catch (err) {
    return { success: false, error: err.message };
  }
};

// ── DATA BUNDLE Purchase ─────────────────────────────────────
// serviceID examples: mtn-data, airtel-data, glo-data, etisalat-data
// variationCode examples: mtn-10mb-100, mtn-1gb-1000, etc.
const buyData = async ({ phone, serviceID, variationCode, amount }) => {
  try {
    const requestId = makeRequestId();
    const res = await axios.post(`${BASE_URL}/pay`, {
      request_id: requestId,
      serviceID,
      billersCode: phone,
      variation_code: variationCode,
      amount,
      phone,
    }, { headers: getHeaders() });

    const content = res.data?.content;
    const txnStatus = content?.transactions?.status;

    return {
      success: txnStatus === 'delivered',
      requestId,
      reference: content?.transactions?.transactionId || requestId,
      status: txnStatus,
      rawResponse: res.data,
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
};

// ── AIRTIME Purchase ─────────────────────────────────────────
const buyAirtime = async ({ phone, serviceID, amount }) => {
  try {
    const requestId = makeRequestId();
    const res = await axios.post(`${BASE_URL}/pay`, {
      request_id: requestId,
      serviceID,          // mtn, airtel, glo, etisalat
      billersCode: phone,
      variation_code: serviceID, // same as serviceID for airtime
      amount,
      phone,
    }, { headers: getHeaders() });

    const content = res.data?.content;
    const txnStatus = content?.transactions?.status;

    return {
      success: txnStatus === 'delivered',
      requestId,
      reference: content?.transactions?.transactionId || requestId,
      status: txnStatus,
      rawResponse: res.data,
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
};

// ── CABLE TV Subscription ────────────────────────────────────
// serviceID: dstv, gotv, startimes
const payCable = async ({ smartCardNumber, serviceID, variationCode, amount, phone }) => {
  try {
    const requestId = makeRequestId();
    const res = await axios.post(`${BASE_URL}/pay`, {
      request_id: requestId,
      serviceID,
      billersCode: smartCardNumber,
      variation_code: variationCode,
      amount,
      phone,
      subscription_type: 'change',
    }, { headers: getHeaders() });

    const content = res.data?.content;
    const txnStatus = content?.transactions?.status;

    return {
      success: txnStatus === 'delivered',
      requestId,
      reference: content?.transactions?.transactionId || requestId,
      status: txnStatus,
      rawResponse: res.data,
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
};

// ── ELECTRICITY Token ────────────────────────────────────────
// serviceID: ikeja-electric, eko-electric, abuja-electric, etc.
const payElectricity = async ({ meterNumber, serviceID, variationCode, amount, phone }) => {
  try {
    const requestId = makeRequestId();
    const res = await axios.post(`${BASE_URL}/pay`, {
      request_id: requestId,
      serviceID,
      billersCode: meterNumber,
      variation_code: variationCode,  // prepaid or postpaid
      amount,
      phone,
    }, { headers: getHeaders() });

    const content = res.data?.content;
    const txnStatus = content?.transactions?.status;

    // Extract the electricity TOKEN from the response
    const token = content?.transactions?.product_name || 
                  content?.cards?.[0]?.Serial || '';

    return {
      success: txnStatus === 'delivered',
      requestId,
      reference: content?.transactions?.transactionId || requestId,
      token,
      status: txnStatus,
      rawResponse: res.data,
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
};

// ── Get service variations (bundles/packages) ────────────────
const getVariations = async (serviceID) => {
  try {
    const res = await axios.get(
      `${BASE_URL}/service-variations?serviceID=${serviceID}`,
      { headers: getHeaders() }
    );
    return { success: true, variations: res.data?.content?.varations || [] };
  } catch (err) {
    return { success: false, error: err.message };
  }
};

// ── Map network names to VTPass service IDs ──────────────────
const networkToDataServiceID = {
  MTN: 'mtn-data',
  Airtel: 'airtel-data',
  Glo: 'glo-data',
  '9Mobile': 'etisalat-data',
};

const networkToAirtimeServiceID = {
  MTN: 'mtn',
  Airtel: 'airtel',
  Glo: 'glo',
  '9Mobile': 'etisalat',
};

module.exports = {
  getBalance,
  verifyMeter,
  buyData,
  buyAirtime,
  payCable,
  payElectricity,
  getVariations,
  networkToDataServiceID,
  networkToAirtimeServiceID,
};
