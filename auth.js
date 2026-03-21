// middleware/auth.js
// Protects routes — every request must include a valid JWT token

const jwt = require('jsonwebtoken');
const { collections } = require('../config/firebase');

// ── Verify JWT and attach user to request ────────────────────
const protect = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, message: 'Not authorized. Please log in.' });
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Fetch user from Firestore to ensure they still exist and are active
    const userDoc = await collections.users.doc(decoded.uid).get();
    if (!userDoc.exists) {
      return res.status(401).json({ success: false, message: 'User no longer exists.' });
    }

    const user = userDoc.data();
    if (user.status === 'suspended') {
      return res.status(403).json({ success: false, message: 'Your account has been suspended. Contact support.' });
    }

    req.user = { uid: decoded.uid, ...user };
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ success: false, message: 'Session expired. Please log in again.' });
    }
    return res.status(401).json({ success: false, message: 'Invalid token.' });
  }
};

// ── Admin-only routes ────────────────────────────────────────
const adminOnly = (req, res, next) => {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ success: false, message: 'Admin access required.' });
  }
  next();
};

// ── Generate JWT token ───────────────────────────────────────
const generateToken = (uid) => jwt.sign({ uid }, process.env.JWT_SECRET, { expiresIn: '30d' });

module.exports = { protect, adminOnly, generateToken };
