const express = require('express');
const client = require('prom-client');
const healthRouter = require('./routes/health');

const app = express();
const PORT = process.env.PORT || 3000;
const APP_VERSION = process.env.APP_VERSION || 'dev';

app.use(express.json());

// --- Prometheus metrics (scraped by the monitoring stack) ---
const register = new client.Registry();
client.collectDefaultMetrics({ register });

const httpRequestCounter = new client.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status'],
});
register.registerMetric(httpRequestCounter);

app.use((req, res, next) => {
  res.on('finish', () => {
    httpRequestCounter.inc({
      method: req.method,
      route: req.route ? req.route.path : req.path,
      status: res.statusCode,
    });
  });
  next();
});

app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

// --- Routes ---
app.use('/', healthRouter);

app.get('/api/info', (req, res) => {
  res.json({
    service: 'nodejs-cicd-demo',
    version: APP_VERSION,
    env: process.env.NODE_ENV || 'development',
    hostname: require('os').hostname(),
    uptime_seconds: process.uptime(),
  });
});

app.get('/api/items', (req, res) => {
  res.json({
    items: [
      { id: 1, name: 'Terraform' },
      { id: 2, name: 'Jenkins' },
      { id: 3, name: 'EKS' },
    ],
  });
});

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Only start the server when run directly (not when required by tests)
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`nodejs-cicd-demo listening on port ${PORT} (version ${APP_VERSION})`);
  });
}

module.exports = app;
