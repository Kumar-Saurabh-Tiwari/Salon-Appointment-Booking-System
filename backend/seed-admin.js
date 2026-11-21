require('dotenv').config();

const bcrypt = require('bcryptjs');
const { pool, initializeSchema } = require('./server');

async function seedAdmin() {
  const { ADMIN_NAME, ADMIN_EMAIL, ADMIN_PASSWORD } = process.env;
  if (!ADMIN_NAME || !ADMIN_EMAIL || !ADMIN_PASSWORD || ADMIN_PASSWORD.length < 8) {
    throw new Error('Set ADMIN_NAME, ADMIN_EMAIL, and an ADMIN_PASSWORD of at least 8 characters.');
  }
  await initializeSchema();
  const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 12);
  await pool.execute(
    `INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, 'admin')
     ON DUPLICATE KEY UPDATE name = VALUES(name), password_hash = VALUES(password_hash), role = 'admin'`,
    [ADMIN_NAME.trim(), ADMIN_EMAIL.trim().toLowerCase(), passwordHash],
  );
  console.log(`Administrator account ready: ${ADMIN_EMAIL.trim().toLowerCase()}`);
}

seedAdmin()
  .catch((error) => {
    console.error('Failed to seed administrator:', error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
