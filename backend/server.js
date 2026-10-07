const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
dotenv.config();

const { requireAuth } = require('./middleware/tenant');
const authRoutes = require('./routes/auth');
const socialRoutes = require('./routes/social');
const billingRoutes = require('./routes/billing');
const socialScheduler = require('./social/scheduler');
const socialPollers = require('./social/pollers');

const app = express();
app.use(cors());
// `verify` stashes the raw request body bytes on req.rawBody — needed by
// routes/social.js's WhatsApp webhook and routes/billing.js's Razorpay
// webhook to check their respective HMAC signature headers, which are
// computed over the exact raw bytes sent, not a re-serialization of the
// parsed JSON.
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));

// Unauthenticated by necessity: OAuth providers and payment/messaging
// webhooks call these directly and can't carry a Bearer header. Each
// authenticates itself its own way (signed state, HMAC signature) — see
// their own files for why.
app.use('/api', authRoutes);
app.use('/api', socialRoutes.publicRouter);
app.use('/api', billingRoutes.publicRouter);

app.use('/api', requireAuth);
app.use('/api', socialRoutes.protectedRouter);
app.use('/api', billingRoutes.protectedRouter);

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Social Hub API listening on port ${PORT}`);
  socialScheduler.start();
  socialPollers.start();
});

process.on('SIGTERM', async () => {
  await socialScheduler.stop();
  process.exit(0);
});
