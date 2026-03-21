# ⚡ Dindyz Data — Backend API
### Node.js + Firebase + VTPass + Paystack

This is the complete backend for the Dindyz Data VTU app. It handles user auth, wallet funding, data/airtime/cable/electricity purchases, and the admin dashboard.

---

## 📁 Project Structure

```
dindyz-backend/
├── server.js              ← Main entry point
├── package.json
├── .env.example           ← Copy to .env and fill in your keys
│
├── config/
│   └── firebase.js        ← Firebase Admin SDK setup
│
├── middleware/
│   └── auth.js            ← JWT authentication + admin guard
│
├── routes/
│   ├── auth.js            ← Register, login, OTP
│   ├── vtu.js             ← Data, airtime, cable, electricity
│   ├── wallet.js          ← Fund wallet, verify Paystack payment
│   ├── user.js            ← Profile, history, loyalty, schedules
│   └── admin.js           ← Admin dashboard endpoints
│
└── services/
    ├── vtpass.js          ← VTPass API (actual VTU delivery)
    ├── paystack.js        ← Paystack (wallet funding payments)
    └── sms.js             ← Termii (OTP + transaction SMS)
```

---

## 🚀 Quick Setup (Step by Step)

### Step 1 — Install Node.js
Download Node.js from https://nodejs.org (choose LTS version)

### Step 2 — Install dependencies
```bash
cd dindyz-backend
npm install
```

### Step 3 — Set up Firebase
1. Go to https://console.firebase.google.com
2. Create a new project called **dindyz-data**
3. Enable **Firestore Database** (start in test mode)
4. Go to **Project Settings → Service Accounts**
5. Click **Generate new private key** → download JSON file
6. Copy the values into your `.env` file

### Step 4 — Sign up for VTPass
1. Go to https://vtpass.com → click **Become a Reseller**
2. Fund your VTPass wallet (start with ₦10,000)
3. Go to **Settings → API** to get your API keys
4. For testing use: https://sandbox.vtpass.com/api

### Step 5 — Sign up for Paystack
1. Go to https://paystack.com → create a free account
2. Go to **Settings → API Keys**
3. Copy your test secret key (starts with `sk_test_`)
4. For live payments, verify your business and use live keys

### Step 6 — Sign up for Termii (SMS)
1. Go to https://termii.com → create account
2. Top up with units (very cheap, ~₦4 per SMS)
3. Copy your API key from the dashboard

### Step 7 — Create your .env file
```bash
cp .env.example .env
```
Open `.env` and fill in all your keys from steps 3–6.

### Step 8 — Create your first admin user
Run this once to create your admin account in Firestore:
```bash
node scripts/createAdmin.js
```

### Step 9 — Start the server
```bash
# Development (auto-restarts on file changes)
npm run dev

# Production
npm start
```

Your API will be running at: **http://localhost:5000**

---

## 📡 API Endpoints

### Auth
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/auth/send-otp` | Send OTP to phone |
| POST | `/api/auth/verify-otp` | Verify OTP |
| POST | `/api/auth/register` | Create new account |
| POST | `/api/auth/login` | Login with phone + PIN |
| POST | `/api/auth/change-pin` | Reset PIN |

### VTU (requires login token)
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/vtu/data` | Buy data bundle |
| POST | `/api/vtu/airtime` | Buy airtime |
| POST | `/api/vtu/cable` | Pay cable TV |
| POST | `/api/vtu/electricity` | Pay electricity |
| POST | `/api/vtu/verify-meter` | Verify meter/smart card |
| GET | `/api/vtu/variations/:serviceID` | Get bundle list |

### Wallet (requires login token)
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/wallet/balance` | Get wallet balance |
| POST | `/api/wallet/fund` | Initialize Paystack payment |
| GET | `/api/wallet/verify/:ref` | Verify payment + credit wallet |
| POST | `/api/wallet/webhook` | Paystack webhook (auto) |
| GET | `/api/wallet/transactions` | Transaction history |

### Admin (requires admin token)
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/admin/stats` | Dashboard overview stats |
| GET | `/api/admin/transactions` | All transactions |
| GET | `/api/admin/users` | All users |
| PATCH | `/api/admin/users/:uid` | Suspend/edit user |
| POST | `/api/admin/refund` | Refund an order |
| GET | `/api/admin/vtpass-balance` | Check VTPass wallet |
| GET | `/api/admin/revenue-chart` | Revenue chart data |

---

## 🔐 How Authentication Works

1. User enters phone → POST `/api/auth/send-otp` → OTP sent via SMS
2. User enters OTP → POST `/api/auth/verify-otp` → Phone confirmed
3. User creates PIN → POST `/api/auth/register` → Account created
4. Login → POST `/api/auth/login` → Returns a **JWT token**
5. Every protected request must include: `Authorization: Bearer <token>`

---

## 💡 How a Purchase Works

```
User clicks "Buy Data"
       ↓
App sends POST /api/vtu/data with token
       ↓
Backend checks wallet balance
       ↓
Backend creates "pending" order
       ↓
Backend deducts wallet balance
       ↓
Backend calls VTPass API
       ↓
VTPass delivers data to phone
       ↓
Backend marks order "success" + records profit
       ↓
Backend sends SMS confirmation to user
       ↓
App shows success modal
```

If VTPass fails at any point → user is automatically refunded.

---

## 🌐 Deploying to Production

### Option A — Render.com (Free / Easy)
1. Go to https://render.com → create account
2. Click **New → Web Service**
3. Connect your GitHub repo
4. Set build command: `npm install`
5. Set start command: `npm start`
6. Add all your `.env` variables in **Environment**
7. Deploy! Your API will be at `https://your-app.onrender.com`

### Option B — Railway.app (Simple)
1. Go to https://railway.app
2. Deploy from GitHub in 2 clicks
3. Add environment variables
4. Done — free $5/month credit included

### Option C — VPS (DigitalOcean / Contabo)
For higher traffic, get a ₦3,000/month VPS and use PM2:
```bash
npm install -g pm2
pm2 start server.js --name dindyz-api
pm2 startup
pm2 save
```

---

## 🆘 Support
Need help? The code is heavily commented.
Contact: admin@dindyzdata.com
