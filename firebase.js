// config/firebase.js
// Initializes Firebase Admin SDK — the database for all users, wallets, and transactions

const admin = require('firebase-admin');

const serviceAccount = {
  type: 'service_account',
  project_id: process.env.FIREBASE_PROJECT_ID,
  private_key: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  client_email: process.env.FIREBASE_CLIENT_EMAIL,
};

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: `https://${process.env.FIREBASE_PROJECT_ID}-default-rtdb.firebaseio.com`,
  });
}

const db = admin.firestore();
const auth = admin.auth();

// Firestore collection references
const collections = {
  users:        db.collection('users'),
  transactions: db.collection('transactions'),
  orders:       db.collection('orders'),
  wallets:      db.collection('wallets'),
  resellers:    db.collection('resellers'),
  schedules:    db.collection('schedules'),
  notifications:db.collection('notifications'),
  settings:     db.collection('settings'),
};

module.exports = { db, auth, admin, collections };
