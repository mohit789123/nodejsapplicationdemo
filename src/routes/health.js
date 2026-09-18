const express = require('express');
const router = express.Router();

// Liveness: is the process up at all
router.get('/healthz', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

// Readiness: is the app ready to receive traffic
// (in a real app, check DB/queue connections here)
router.get('/readyz', (req, res) => {
  res.status(200).json({ status: 'ready' });
});

router.get('/', (req, res) => {
  res.status(200).send('nodejs-cicd-demo is running. Try /api/info, /api/items, /healthz, /metrics');
});

module.exports = router;
