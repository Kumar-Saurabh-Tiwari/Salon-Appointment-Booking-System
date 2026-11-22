require('dotenv').config();
process.env.TZ = process.env.SALON_TIMEZONE || 'UTC';

const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const { sequelize, initializeSchema } = require('./database/schema');
const { router: apiRouter, startReminderJob } = require('./routes/api');

const app = express();
const PORT = Number(process.env.PORT || 4000);

app.use(cors({ origin: process.env.FRONTEND_ORIGIN || 'http://localhost:5173' }));
app.use('/api/payments/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '1mb' }));
app.use((req, _res, next) => {
  req.body = req.body || {};
  next();
});
app.use('/api', apiRouter);
app.use((error, _req, res, _next) => {
  if (error.name === 'SequelizeUniqueConstraintError' || error.name === 'SequelizeForeignKeyConstraintError') {
    return res.status(error.name === 'SequelizeUniqueConstraintError' ? 409 : 404).json({
      error: error.name === 'SequelizeUniqueConstraintError' ? 'A record with that value already exists.' : 'A referenced record was not found.',
    });
  }
  const status = error.status || error.statusCode || 500;
  if (status >= 500) console.error(error);
  res.status(status).json({ error: status < 500 ? error.message : 'An unexpected server error occurred.' });
});

async function start() {
  await initializeSchema();
  startReminderJob(cron);
  return app.listen(PORT, () => console.log(`Salon booking API listening on http://localhost:${PORT}`));
}

if (require.main === module) {
  start().catch((error) => {
    console.error('Failed to start the API:', error);
    process.exitCode = 1;
  });
}

module.exports = { app, sequelize, initializeSchema, start };
