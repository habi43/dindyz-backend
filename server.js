// server.js — Dindyz Data Backend Entry Point
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 5000;

// ── Security Middleware ───────────────────────────────────────
app.use(helmet());

// Allow requests from your frontend domains
app.use(cors({
  origin: [
    'http://localhost:3000',
    'https://dindyzdata.com',
    'https://www.dindyzdata.com',
    'https://admin.dindyzdata.com',
  ],
  credentials: true,
}));

// Rate limiting — prevent abuse (100 requests per 15 min per IP)
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { success: false, message: 'Too many requests. Please slow down.' },
});
app.use('/api/', limiter);

// Stricter limit on auth routes to prevent brute force
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { success: false, message: 'Too many login attempts. Try again in 15 minutes.' },
});

// ── Body Parsing ─────────────────────────────────────────────
// Note: /api/wallet/webhook needs raw body, so register it BEFORE json parser
const walletRoutes = require('./routes/wallet');
app.use('/api/wallet/webhook', express.raw({ type: 'application/json' }), (req, res, next) => {
  req.rawBody = req.body;
  next();
});

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ── Logging ───────────────────────────────────────────────────
if (process.env.NODE_ENV !== 'test') {
  app.use(morgan('dev'));
}

// ── Health Check ─────────────────────────────────────────────
app.get('/', (req, res) => res.json({
  success: true,
  app: 'Dindyz Data API',
  version: '1.0.0',
  status: 'running',
  environment: process.env.NODE_ENV,
  timestamp: new Date().toISOString(),
}));

app.get('/api/health', async (req, res) => {
  try {
    // Check VTPass balance
    const vtpass = require('./services/vtpass');
    const balResult = await vtpass.getBalance();
    return res.json({
      success: true,
      status: 'healthy',
      vtpassBalance: balResult.balance || 'N/A',
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    return res.status(503).json({ success: false, status: 'unhealthy', error: err.message });
  }
});

// ── Routes ────────────────────────────────────────────────────
app.use('/api/auth',   authLimiter, require('./routes/auth'));
app.use('/api/vtu',    require('./routes/vtu'));
app.use('/api/wallet', walletRoutes);
app.use('/api/user',   require('./routes/user'));
app.use('/api/admin',  require('./routes/admin'));

// ── 404 Handler ───────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ success: false, message: `Route ${req.method} ${req.url} not found.` });
});

// ── Global Error Handler ──────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.stack);
  res.status(500).json({
    success: false,
    message: process.env.NODE_ENV === 'development' ? err.message : 'Internal server error.',
  });
});

// ── Start Server ──────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
  ╔═══════════════════════════════════════╗
  ║     🚀 Dindyz Data API is running      ║
  ║     Port: ${PORT}                        ║
  ║     Env:  ${process.env.NODE_ENV || 'development'}                ║
  ╚═══════════════════════════════════════╝
  `);
});

module.exports = app;
