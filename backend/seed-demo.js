require('dotenv').config();

const { sequelize, initializeSchema, Service, Staff, StaffService, StaffAvailability } = require('./database/schema');

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
  await sequelize.transaction(async (transaction) => {
    const [serviceCount, staffCount] = await Promise.all([
      Service.count({ transaction }),
      Staff.count({ transaction }),
    ]);
    if (serviceCount || staffCount) {
      console.log('Existing services or staff found; demo catalog was not added.');
      return;
    }

    const services = await Service.bulkCreate(demoServices.map(([name, description, duration_minutes, price]) => ({
      name, description, duration_minutes, price,
    })), { transaction });
    const member = await Staff.create({
      name: 'Alex Morgan',
      bio: 'A friendly stylist for your next little reset.',
      specializations: ['Hair', 'Nails', 'Brows', 'Skincare', 'Massage', 'Makeup'],
    }, { transaction });
    await StaffService.bulkCreate(services.map((service) => ({
      staff_id: member.id,
      service_id: service.id,
    })), { transaction });
    const availability = Array.from({ length: 7 }, (_, weekday) => ({
      staff_id: member.id,
      weekday,
      start_time: weekday === 0 || weekday === 6 ? '10:00:00' : '09:00:00',
      end_time: weekday === 0 || weekday === 6 ? '16:00:00' : '17:00:00',
    }));
    await StaffAvailability.bulkCreate(availability, { transaction });
    console.log(`Added ${demoServices.length} demo services, one stylist, and weekly availability.`);
  });
}

seedDemo()
  .catch((error) => {
    console.error('Failed to seed demo catalog:', error);
    process.exitCode = 1;
  })
  .finally(() => sequelize.close());
