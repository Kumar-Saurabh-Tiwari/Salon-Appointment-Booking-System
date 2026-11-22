require('dotenv').config();

const { pool, initializeSchema } = require('./server');

const demoServices = [
  ['Signature haircut', 'A tailored cut and finish for your style.', 45, 45],
  ['Balayage refresh', 'Dimensional colour with a polished finish.', 90, 95],
  ['Classic manicure', 'Nail shaping, cuticle care and polish.', 45, 35],
  ['Brow shape and tint', 'A tidy shape and a soft, natural tint.', 30, 28],
  ['Glow facial', 'A restorative facial for fresh, hydrated skin.', 60, 75],
  ['Relaxation massage', 'A full-body massage to help you unwind.', 60, 85],
  ['Event makeup', 'A polished makeup look for your special occasion.', 60, 70],
  ['Express wax', 'A quick, comfortable hair-removal appointment.', 30, 32],
  ['Medspa rejuvenation', 'A restorative aesthetic treatment for a fresh glow.', 45, 80],
];

async function seedDemo() {
  await initializeSchema();
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [[serviceCount]] = await connection.query('SELECT COUNT(*) AS count FROM services');
    const [[staffCount]] = await connection.query('SELECT COUNT(*) AS count FROM staff');
    if (Number(serviceCount.count) || Number(staffCount.count)) {
      await connection.rollback();
      console.log('Existing services or staff found; demo catalog was not added.');
      return;
    }

    const serviceIds = [];
    for (const [name, description, duration, price] of demoServices) {
      const [result] = await connection.execute(
        'INSERT INTO services (name, description, duration_minutes, price) VALUES (?, ?, ?, ?)',
        [name, description, duration, price],
      );
      serviceIds.push(result.insertId);
    }
    const [staffResult] = await connection.execute(
      'INSERT INTO staff (name, bio, specializations) VALUES (?, ?, ?)',
      ['Alex Morgan', 'A friendly stylist for your next little reset.', JSON.stringify(['Hair', 'Nails', 'Brows', 'Skincare', 'Massage', 'Makeup'])],
    );
    const staffId = staffResult.insertId;
    for (const serviceId of serviceIds) {
      await connection.execute(
        'INSERT INTO staff_services (staff_id, service_id) VALUES (?, ?)',
        [staffId, serviceId],
      );
    }
    for (let weekday = 0; weekday <= 6; weekday += 1) {
      await connection.execute(
        'INSERT INTO staff_availability (staff_id, weekday, start_time, end_time) VALUES (?, ?, ?, ?)',
        [staffId, weekday, weekday === 0 || weekday === 6 ? '10:00:00' : '09:00:00', weekday === 0 || weekday === 6 ? '16:00:00' : '17:00:00'],
      );
    }
    await connection.commit();
    console.log(`Added ${demoServices.length} demo services, one stylist, and weekly availability.`);
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

seedDemo()
  .catch((error) => {
    console.error('Failed to seed demo catalog:', error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
