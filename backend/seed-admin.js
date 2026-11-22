require('dotenv').config();

const bcrypt = require('bcryptjs');
const { initializeSchema, sequelize, User } = require('./database/schema');

async function seedAdmin() {
  const { ADMIN_NAME, ADMIN_EMAIL, ADMIN_PASSWORD } = process.env;
  if (!ADMIN_NAME || !ADMIN_EMAIL || !ADMIN_PASSWORD || ADMIN_PASSWORD.length < 8) {
    throw new Error('Set ADMIN_NAME, ADMIN_EMAIL, and an ADMIN_PASSWORD of at least 8 characters.');
  }
  await initializeSchema();
  const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 12);
  const [user, created] = await User.findOrCreate({
    where: { email: ADMIN_EMAIL.trim().toLowerCase() },
    defaults: { name: ADMIN_NAME.trim(), password_hash: passwordHash, role: 'admin' },
  });
  if (!created) await user.update({ name: ADMIN_NAME.trim(), password_hash: passwordHash, role: 'admin' });
  console.log(`Administrator account ready: ${ADMIN_EMAIL.trim().toLowerCase()}`);
}

seedAdmin()
  .catch((error) => {
    console.error('Failed to seed administrator:', error);
    process.exitCode = 1;
  })
  .finally(() => sequelize.close());
