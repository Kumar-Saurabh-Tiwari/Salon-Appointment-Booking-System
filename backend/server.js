require('dotenv').config();

const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const mysql = require('mysql2/promise');
const nodemailer = require('nodemailer');
const cron = require('node-cron');
const Stripe = require('stripe');

const app = express();
const PORT = Number(process.env.PORT || 4000);
const JWT_SECRET = process.env.JWT_SECRET;
const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'salon_booking',
  waitForConnections: true,
  connectionLimit: 10,
  dateStrings: true,
});
const mailTransport = process.env.SMTP_HOST
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === 'true',
      auth: process.env.SMTP_USER
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD }
        : undefined,
    })
  : null;
const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

const schema = [
  `CREATE TABLE IF NOT EXISTS users (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(120) NOT NULL,
    email VARCHAR(254) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    phone VARCHAR(32),
    preferences JSON,
    role ENUM('customer', 'staff', 'admin') NOT NULL DEFAULT 'customer',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS services (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(120) NOT NULL,
    description TEXT,
    duration_minutes SMALLINT UNSIGNED NOT NULL,
    price DECIMAL(10,2) NOT NULL,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS staff (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    user_id BIGINT UNSIGNED NULL UNIQUE,
    name VARCHAR(120) NOT NULL,
    bio TEXT,
    specializations JSON,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    CONSTRAINT fk_staff_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS staff_services (
    staff_id BIGINT UNSIGNED NOT NULL,
    service_id BIGINT UNSIGNED NOT NULL,
    PRIMARY KEY (staff_id, service_id),
    CONSTRAINT fk_staff_services_staff FOREIGN KEY (staff_id) REFERENCES staff(id) ON DELETE CASCADE,
    CONSTRAINT fk_staff_services_service FOREIGN KEY (service_id) REFERENCES services(id) ON DELETE CASCADE
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS staff_availability (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    staff_id BIGINT UNSIGNED NOT NULL,
    weekday TINYINT UNSIGNED NOT NULL,
    start_time TIME NOT NULL,
    end_time TIME NOT NULL,
    is_available BOOLEAN NOT NULL DEFAULT TRUE,
    UNIQUE KEY uq_staff_weekday_start (staff_id, weekday, start_time),
    CONSTRAINT fk_availability_staff FOREIGN KEY (staff_id) REFERENCES staff(id) ON DELETE CASCADE
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS appointments (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    customer_id BIGINT UNSIGNED NOT NULL,
    staff_id BIGINT UNSIGNED NOT NULL,
    service_id BIGINT UNSIGNED NOT NULL,
    appointment_date DATE NOT NULL,
    start_time TIME NOT NULL,
    end_time TIME NOT NULL,
    status ENUM('confirmed', 'cancelled', 'completed') NOT NULL DEFAULT 'confirmed',
    notes TEXT,
    reminder_sent_at DATETIME NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_appointment_schedule (staff_id, appointment_date, status, start_time, end_time),
    KEY idx_appointment_customer (customer_id, appointment_date),
    CONSTRAINT fk_appointment_customer FOREIGN KEY (customer_id) REFERENCES users(id),
    CONSTRAINT fk_appointment_staff FOREIGN KEY (staff_id) REFERENCES staff(id),
    CONSTRAINT fk_appointment_service FOREIGN KEY (service_id) REFERENCES services(id)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS payments (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    appointment_id BIGINT UNSIGNED NOT NULL UNIQUE,
    provider VARCHAR(32) NOT NULL,
    provider_session_id VARCHAR(255),
    amount DECIMAL(10,2) NOT NULL,
    status ENUM('pending', 'paid', 'failed') NOT NULL DEFAULT 'pending',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_payment_appointment FOREIGN KEY (appointment_id) REFERENCES appointments(id) ON DELETE CASCADE
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS invoices (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    appointment_id BIGINT UNSIGNED NOT NULL UNIQUE,
    invoice_number VARCHAR(40) NOT NULL UNIQUE,
    amount DECIMAL(10,2) NOT NULL,
    issued_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_invoice_appointment FOREIGN KEY (appointment_id) REFERENCES appointments(id)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS reviews (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    appointment_id BIGINT UNSIGNED NOT NULL UNIQUE,
    customer_id BIGINT UNSIGNED NOT NULL,
    staff_id BIGINT UNSIGNED NOT NULL,
    rating TINYINT UNSIGNED NOT NULL,
    comment TEXT,
    staff_response TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_review_appointment FOREIGN KEY (appointment_id) REFERENCES appointments(id),
    CONSTRAINT fk_review_customer FOREIGN KEY (customer_id) REFERENCES users(id),
    CONSTRAINT fk_review_staff FOREIGN KEY (staff_id) REFERENCES staff(id)
  ) ENGINE=InnoDB`,
];

const fail = (status, message) => Object.assign(new Error(message), { status });
const asyncRoute = (handler) => (req, res, next) =>
  Promise.resolve(handler(req, res, next)).catch(next);
const parseId = (value) => {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw fail(400, 'A valid ID is required.');
  return id;
};
const isDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
const toMinutes = (value) => {
  if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(value)) {
    throw fail(400, 'Time must use HH:MM format.');
  }
  const [hours, minutes] = value.split(':').map(Number);
  return hours * 60 + minutes;
};
const asTime = (minutes) =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}:00`;

function authenticate(req, _res, next) {
  const token = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return next(fail(401, 'Authentication is required.'));
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    return next();
  } catch {
    return next(fail(401, 'Your session is invalid or has expired.'));
  }
}

const allowRoles = (...roles) => (req, _res, next) =>
  roles.includes(req.user.role) ? next() : next(fail(403, 'You do not have permission to do this.'));
const getUser = async (id) => {
  const [rows] = await pool.execute(
    'SELECT id, name, email, phone, preferences, role, created_at FROM users WHERE id = ?',
    [id],
  );
  return rows[0] || null;
};
const toPublicUser = (user) => ({
  ...user,
  preferences: typeof user.preferences === 'string' ? JSON.parse(user.preferences) : user.preferences,
});
const sendEmail = async ({ to, subject, text }) => {
  if (!mailTransport || !process.env.SMTP_FROM) {
    console.warn(`Email not sent (SMTP is not configured): ${subject} -> ${to}`);
    return;
  }
  await mailTransport.sendMail({ from: process.env.SMTP_FROM, to, subject, text });
};
const notifyBooking = async (appointment, kind = 'confirmed') => {
  const [rows] = await pool.execute(
    `SELECT u.email, u.name AS customer_name, s.name AS service_name, st.name AS staff_name
     FROM appointments a JOIN users u ON u.id = a.customer_id
     JOIN services s ON s.id = a.service_id JOIN staff st ON st.id = a.staff_id
     WHERE a.id = ?`,
    [appointment.id],
  );
  if (!rows[0]) return;
  const booking = rows[0];
  await sendEmail({
    to: booking.email,
    subject: `Salon appointment ${kind}`,
    text: `Hi ${booking.customer_name}, your ${booking.service_name} appointment with ${booking.staff_name} is ${kind} for ${appointment.appointment_date} at ${appointment.start_time}.`,
  });
};
const transaction = async (callback) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await callback(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
};

app.use(cors({ origin: process.env.FRONTEND_ORIGIN || true }));
app.use((req, res, next) => {
  if (req.originalUrl === '/api/payments/webhook') return next();
  return express.json({ limit: '1mb' })(req, res, next);
});

app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

app.post('/api/auth/register', asyncRoute(async (req, res) => {
  const { name, email, password, phone } = req.body;
  if (!name?.trim() || !email?.trim() || !password) throw fail(400, 'Name, email, and password are required.');
  if (password.length < 8) throw fail(400, 'Password must be at least 8 characters.');
  const normalizedEmail = email.trim().toLowerCase();
  const passwordHash = await bcrypt.hash(password, 12);
  const [result] = await pool.execute(
    'INSERT INTO users (name, email, password_hash, phone, role) VALUES (?, ?, ?, ?, "customer")',
    [name.trim(), normalizedEmail, passwordHash, phone?.trim() || null],
  );
  const user = await getUser(result.insertId);
  const token = jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '12h' });
  res.status(201).json({ token, user: toPublicUser(user) });
}));

app.post('/api/auth/login', asyncRoute(async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) throw fail(400, 'Email and password are required.');
  const [rows] = await pool.execute('SELECT * FROM users WHERE email = ?', [email.trim().toLowerCase()]);
  if (!rows[0] || !(await bcrypt.compare(password, rows[0].password_hash))) {
    throw fail(401, 'Email or password is incorrect.');
  }
  const user = toPublicUser(await getUser(rows[0].id));
  const token = jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '12h' });
  res.json({ token, user });
}));

app.get('/api/profile', authenticate, asyncRoute(async (req, res) => {
  const user = await getUser(req.user.id);
  if (!user) throw fail(404, 'User not found.');
  res.json(toPublicUser(user));
}));

app.patch('/api/profile', authenticate, asyncRoute(async (req, res) => {
  const { name, phone, preferences } = req.body;
  if (name !== undefined && (!name.trim() || name.trim().length > 120)) throw fail(400, 'Name must be between 1 and 120 characters.');
  if (phone !== undefined && phone !== null && typeof phone !== 'string') throw fail(400, 'Phone must be a string.');
  if (preferences !== undefined && (!preferences || typeof preferences !== 'object' || Array.isArray(preferences))) {
    throw fail(400, 'Preferences must be an object.');
  }
  await pool.execute(
    `UPDATE users SET name = COALESCE(?, name), phone = ?, preferences = COALESCE(?, preferences)
     WHERE id = ?`,
    [
      name === undefined ? null : name.trim(),
      phone === undefined ? (await getUser(req.user.id)).phone : phone,
      preferences === undefined ? null : JSON.stringify(preferences),
      req.user.id,
    ],
  );
  res.json(toPublicUser(await getUser(req.user.id)));
}));

app.get('/api/services', asyncRoute(async (_req, res) => {
  const [rows] = await pool.execute('SELECT id, name, description, duration_minutes, price FROM services WHERE active = TRUE ORDER BY name');
  res.json(rows);
}));

app.post('/api/services', authenticate, allowRoles('admin'), asyncRoute(async (req, res) => {
  const { name, description = '', durationMinutes, price } = req.body;
  if (!name?.trim() || !Number.isInteger(durationMinutes) || durationMinutes < 5 || !Number.isFinite(Number(price)) || Number(price) < 0) {
    throw fail(400, 'Name, a duration of at least 5 minutes, and a non-negative price are required.');
  }
  const [result] = await pool.execute(
    'INSERT INTO services (name, description, duration_minutes, price) VALUES (?, ?, ?, ?)',
    [name.trim(), description, durationMinutes, Number(price)],
  );
  res.status(201).json({ id: result.insertId, name: name.trim(), description, duration_minutes: durationMinutes, price: Number(price) });
}));

app.patch('/api/services/:id', authenticate, allowRoles('admin'), asyncRoute(async (req, res) => {
  const id = parseId(req.params.id);
  const { name, description, durationMinutes, price, active } = req.body;
  const [result] = await pool.execute(
    `UPDATE services SET name = COALESCE(?, name), description = COALESCE(?, description),
     duration_minutes = COALESCE(?, duration_minutes), price = COALESCE(?, price), active = COALESCE(?, active)
     WHERE id = ?`,
    [name?.trim() || null, description ?? null, durationMinutes ?? null, price ?? null, active ?? null, id],
  );
  if (!result.affectedRows) throw fail(404, 'Service not found.');
  const [rows] = await pool.execute('SELECT id, name, description, duration_minutes, price, active FROM services WHERE id = ?', [id]);
  res.json(rows[0]);
}));

app.delete('/api/services/:id', authenticate, allowRoles('admin'), asyncRoute(async (req, res) => {
  const [result] = await pool.execute('UPDATE services SET active = FALSE WHERE id = ?', [parseId(req.params.id)]);
  if (!result.affectedRows) throw fail(404, 'Service not found.');
  res.status(204).end();
}));

app.get('/api/staff', asyncRoute(async (_req, res) => {
  const [rows] = await pool.execute(
    `SELECT st.id, st.name, st.bio, st.specializations, st.active,
      COALESCE(JSON_ARRAYAGG(IF(s.id IS NULL, NULL, JSON_OBJECT('id', s.id, 'name', s.name))), JSON_ARRAY()) AS services
     FROM staff st LEFT JOIN staff_services ss ON ss.staff_id = st.id
     LEFT JOIN services s ON s.id = ss.service_id AND s.active = TRUE
     WHERE st.active = TRUE GROUP BY st.id ORDER BY st.name`,
  );
  res.json(rows.map((staff) => ({
    ...staff,
    specializations: typeof staff.specializations === 'string' ? JSON.parse(staff.specializations) : staff.specializations,
    services: typeof staff.services === 'string' ? JSON.parse(staff.services).filter(Boolean) : staff.services,
  })));
}));

app.post('/api/staff', authenticate, allowRoles('admin'), asyncRoute(async (req, res) => {
  const { name, bio = '', specializations = [], userId = null } = req.body;
  if (!name?.trim() || !Array.isArray(specializations)) throw fail(400, 'Name and a specializations array are required.');
  const [result] = await pool.execute(
    'INSERT INTO staff (name, bio, specializations, user_id) VALUES (?, ?, ?, ?)',
    [name.trim(), bio, JSON.stringify(specializations), userId ? parseId(userId) : null],
  );
  res.status(201).json({ id: result.insertId, name: name.trim(), bio, specializations });
}));

app.patch('/api/staff/:id', authenticate, allowRoles('admin'), asyncRoute(async (req, res) => {
  const id = parseId(req.params.id);
  const { name, bio, specializations, active, userId } = req.body;
  const [result] = await pool.execute(
    `UPDATE staff SET name = COALESCE(?, name), bio = COALESCE(?, bio),
     specializations = COALESCE(?, specializations), active = COALESCE(?, active),
     user_id = COALESCE(?, user_id) WHERE id = ?`,
    [
      name?.trim() || null, bio ?? null,
      specializations === undefined ? null : JSON.stringify(specializations),
      active ?? null, userId === undefined ? null : (userId === null ? null : parseId(userId)), id,
    ],
  );
  if (!result.affectedRows) throw fail(404, 'Staff member not found.');
  const [rows] = await pool.execute('SELECT id, name, bio, specializations, active FROM staff WHERE id = ?', [id]);
  res.json(rows[0]);
}));

app.delete('/api/staff/:id', authenticate, allowRoles('admin'), asyncRoute(async (req, res) => {
  const [result] = await pool.execute('UPDATE staff SET active = FALSE WHERE id = ?', [parseId(req.params.id)]);
  if (!result.affectedRows) throw fail(404, 'Staff member not found.');
  res.status(204).end();
}));

app.put('/api/staff/:id/services/:serviceId', authenticate, allowRoles('admin'), asyncRoute(async (req, res) => {
  const staffId = parseId(req.params.id);
  const serviceId = parseId(req.params.serviceId);
  await pool.execute('INSERT IGNORE INTO staff_services (staff_id, service_id) VALUES (?, ?)', [staffId, serviceId]);
  res.status(204).end();
}));

app.delete('/api/staff/:id/services/:serviceId', authenticate, allowRoles('admin'), asyncRoute(async (req, res) => {
  await pool.execute('DELETE FROM staff_services WHERE staff_id = ? AND service_id = ?', [parseId(req.params.id), parseId(req.params.serviceId)]);
  res.status(204).end();
}));

app.put('/api/staff/:id/availability', authenticate, allowRoles('admin'), asyncRoute(async (req, res) => {
  const staffId = parseId(req.params.id);
  const { weekday, startTime, endTime, isAvailable = true } = req.body;
  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) throw fail(400, 'Weekday must be 0 (Sunday) through 6 (Saturday).');
  const start = toMinutes(startTime);
  const end = toMinutes(endTime);
  if (end <= start) throw fail(400, 'End time must be after start time.');
  await pool.execute(
    `INSERT INTO staff_availability (staff_id, weekday, start_time, end_time, is_available)
     VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE end_time = VALUES(end_time), is_available = VALUES(is_available)`,
    [staffId, weekday, asTime(start), asTime(end), Boolean(isAvailable)],
  );
  res.status(204).end();
}));

app.get('/api/availability', asyncRoute(async (req, res) => {
  const serviceId = parseId(req.query.serviceId);
  const date = String(req.query.date || '');
  if (!isDate(date)) throw fail(400, 'Date must use YYYY-MM-DD format.');
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  const staffId = req.query.staffId ? parseId(req.query.staffId) : null;
  const [staff] = await pool.execute(
    `SELECT st.id, st.name, av.start_time, av.end_time, s.duration_minutes
     FROM staff st JOIN staff_services ss ON ss.staff_id = st.id
     JOIN services s ON s.id = ss.service_id AND s.active = TRUE
     JOIN staff_availability av ON av.staff_id = st.id AND av.weekday = ? AND av.is_available = TRUE
     WHERE st.active = TRUE AND s.id = ? AND (? IS NULL OR st.id = ?)
     ORDER BY st.name, av.start_time`,
    [weekday, serviceId, staffId, staffId],
  );
  const [booked] = await pool.execute(
    `SELECT staff_id, start_time, end_time FROM appointments
     WHERE appointment_date = ? AND status = 'confirmed'`,
    [date],
  );
  const slots = [];
  for (const schedule of staff) {
    const opening = toMinutes(schedule.start_time);
    const closing = toMinutes(schedule.end_time);
    const busy = booked.filter((item) => item.staff_id === schedule.id).map((item) => ({
      start: toMinutes(item.start_time), end: toMinutes(item.end_time),
    }));
    for (let start = opening; start + schedule.duration_minutes <= closing; start += 15) {
      const end = start + schedule.duration_minutes;
      if (!busy.some((item) => start < item.end && end > item.start)) {
        slots.push({ staffId: schedule.id, staffName: schedule.name, startTime: asTime(start).slice(0, 5), endTime: asTime(end).slice(0, 5) });
      }
    }
  }
  res.json(slots);
}));

app.post('/api/appointments', authenticate, asyncRoute(async (req, res) => {
  const customerId = req.user.id;
  const serviceId = parseId(req.body.serviceId);
  const staffId = parseId(req.body.staffId);
  const date = String(req.body.date || '');
  const start = toMinutes(req.body.startTime);
  if (!isDate(date) || date < new Date().toISOString().slice(0, 10)) throw fail(400, 'Choose a valid date that is not in the past.');
  const [services] = await pool.execute(
    `SELECT s.duration_minutes FROM services s JOIN staff_services ss ON ss.service_id = s.id
     JOIN staff st ON st.id = ss.staff_id WHERE s.id = ? AND s.active = TRUE AND st.id = ? AND st.active = TRUE`,
    [serviceId, staffId],
  );
  if (!services[0]) throw fail(400, 'This staff member is not available for the selected service.');
  const end = start + services[0].duration_minutes;
  const appointment = await transaction(async (connection) => {
    await connection.execute('SELECT id FROM staff WHERE id = ? FOR UPDATE', [staffId]);
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    const [availability] = await connection.execute(
      `SELECT id FROM staff_availability WHERE staff_id = ? AND weekday = ? AND is_available = TRUE
       AND start_time <= ? AND end_time >= ? LIMIT 1`,
      [staffId, weekday, asTime(start), asTime(end)],
    );
    if (!availability[0]) throw fail(409, 'The selected time is outside this staff member’s working hours.');
    const [conflicts] = await connection.execute(
      `SELECT id FROM appointments WHERE staff_id = ? AND appointment_date = ? AND status = 'confirmed'
       AND start_time < ? AND end_time > ? LIMIT 1`,
      [staffId, date, asTime(end), asTime(start)],
    );
    if (conflicts[0]) throw fail(409, 'That time slot has just been booked. Please choose another.');
    const [result] = await connection.execute(
      `INSERT INTO appointments (customer_id, staff_id, service_id, appointment_date, start_time, end_time, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [customerId, staffId, serviceId, date, asTime(start), asTime(end), req.body.notes?.trim() || null],
    );
    return { id: result.insertId, appointment_date: date, start_time: asTime(start), end_time: asTime(end), status: 'confirmed' };
  });
  await notifyBooking(appointment).catch((error) => console.error('Appointment confirmation email failed:', error.message));
  res.status(201).json(appointment);
}));

const appointmentSelect = `SELECT a.id, a.customer_id, u.name AS customer_name, u.email AS customer_email,
  a.staff_id, st.name AS staff_name, a.service_id, s.name AS service_name, s.duration_minutes,
  s.price, a.appointment_date, a.start_time, a.end_time, a.status, a.notes, a.created_at
  FROM appointments a JOIN users u ON u.id = a.customer_id
  JOIN staff st ON st.id = a.staff_id JOIN services s ON s.id = a.service_id`;

app.get('/api/appointments', authenticate, asyncRoute(async (req, res) => {
  const filters = [];
  const params = [];
  if (req.user.role === 'customer') {
    filters.push('a.customer_id = ?');
    params.push(req.user.id);
  }
  if (req.query.status) {
    if (!['confirmed', 'cancelled', 'completed'].includes(req.query.status)) throw fail(400, 'Unknown appointment status.');
    filters.push('a.status = ?');
    params.push(req.query.status);
  }
  const [rows] = await pool.execute(
    `${appointmentSelect} ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''} ORDER BY a.appointment_date DESC, a.start_time DESC`,
    params,
  );
  res.json(rows);
}));

app.get('/api/appointments/:id', authenticate, asyncRoute(async (req, res) => {
  const id = parseId(req.params.id);
  const [rows] = await pool.execute(`${appointmentSelect} WHERE a.id = ?`, [id]);
  if (!rows[0]) throw fail(404, 'Appointment not found.');
  if (req.user.role === 'customer' && rows[0].customer_id !== req.user.id) throw fail(403, 'You cannot view this appointment.');
  res.json(rows[0]);
}));

app.patch('/api/appointments/:id/reschedule', authenticate, asyncRoute(async (req, res) => {
  const id = parseId(req.params.id);
  const date = String(req.body.date || '');
  const start = toMinutes(req.body.startTime);
  if (!isDate(date) || date < new Date().toISOString().slice(0, 10)) throw fail(400, 'Choose a valid date that is not in the past.');
  const [existingRows] = await pool.execute('SELECT * FROM appointments WHERE id = ?', [id]);
  const existing = existingRows[0];
  if (!existing) throw fail(404, 'Appointment not found.');
  if (req.user.role === 'customer' && existing.customer_id !== req.user.id) throw fail(403, 'You cannot change this appointment.');
  if (existing.status !== 'confirmed') throw fail(409, 'Only confirmed appointments can be rescheduled.');
  const cutoff = Number(process.env.CANCELLATION_CUTOFF_HOURS || 24);
  if (new Date(`${existing.appointment_date}T${existing.start_time}`) - Date.now() < cutoff * 3600000) {
    throw fail(409, `Appointments can only be changed at least ${cutoff} hours in advance.`);
  }
  const end = start + existing.end_time.split(':').reduce((minutes, part, index) => minutes + Number(part) * (index === 0 ? 60 : index === 1 ? 1 : 1 / 60), 0)
    - existing.start_time.split(':').reduce((minutes, part, index) => minutes + Number(part) * (index === 0 ? 60 : index === 1 ? 1 : 1 / 60), 0);
  const updated = await transaction(async (connection) => {
    await connection.execute('SELECT id FROM staff WHERE id = ? FOR UPDATE', [existing.staff_id]);
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    const [availability] = await connection.execute(
      `SELECT id FROM staff_availability WHERE staff_id = ? AND weekday = ? AND is_available = TRUE
       AND start_time <= ? AND end_time >= ? LIMIT 1`,
      [existing.staff_id, weekday, asTime(start + end), asTime(start)],
    );
    if (!availability[0]) throw fail(409, 'The selected time is outside this staff member’s working hours.');
    const [conflicts] = await connection.execute(
      `SELECT id FROM appointments WHERE id <> ? AND staff_id = ? AND appointment_date = ? AND status = 'confirmed'
       AND start_time < ? AND end_time > ? LIMIT 1`,
      [id, existing.staff_id, date, asTime(start + end), asTime(start)],
    );
    if (conflicts[0]) throw fail(409, 'That time slot is already booked.');
    await connection.execute('UPDATE appointments SET appointment_date = ?, start_time = ?, end_time = ? WHERE id = ?', [
      date, asTime(start), asTime(start + end), id,
    ]);
    return { id, appointment_date: date, start_time: asTime(start), end_time: asTime(start + end), status: 'confirmed' };
  });
  await notifyBooking(updated, 'rescheduled').catch((error) => console.error('Reschedule email failed:', error.message));
  res.json(updated);
}));

app.patch('/api/appointments/:id/cancel', authenticate, asyncRoute(async (req, res) => {
  const id = parseId(req.params.id);
  const [rows] = await pool.execute('SELECT * FROM appointments WHERE id = ?', [id]);
  const appointment = rows[0];
  if (!appointment) throw fail(404, 'Appointment not found.');
  if (req.user.role === 'customer' && appointment.customer_id !== req.user.id) throw fail(403, 'You cannot cancel this appointment.');
  if (appointment.status !== 'confirmed') throw fail(409, 'Only confirmed appointments can be cancelled.');
  const cutoff = Number(process.env.CANCELLATION_CUTOFF_HOURS || 24);
  if (req.user.role === 'customer' && new Date(`${appointment.appointment_date}T${appointment.start_time}`) - Date.now() < cutoff * 3600000) {
    throw fail(409, `Appointments can only be cancelled at least ${cutoff} hours in advance.`);
  }
  await pool.execute('UPDATE appointments SET status = "cancelled" WHERE id = ?', [id]);
  await notifyBooking(appointment, 'cancelled').catch((error) => console.error('Cancellation email failed:', error.message));
  res.json({ id, status: 'cancelled' });
}));

app.patch('/api/appointments/:id/status', authenticate, allowRoles('admin'), asyncRoute(async (req, res) => {
  const id = parseId(req.params.id);
  const { status } = req.body;
  if (!['confirmed', 'cancelled', 'completed'].includes(status)) throw fail(400, 'Status must be confirmed, cancelled, or completed.');
  const [result] = await pool.execute('UPDATE appointments SET status = ? WHERE id = ?', [status, id]);
  if (!result.affectedRows) throw fail(404, 'Appointment not found.');
  res.json({ id, status });
}));

app.get('/api/appointments/:id/invoice', authenticate, asyncRoute(async (req, res) => {
  const id = parseId(req.params.id);
  const [rows] = await pool.execute(
    `${appointmentSelect} LEFT JOIN invoices i ON i.appointment_id = a.id WHERE a.id = ?`,
    [id],
  );
  const appointment = rows[0];
  if (!appointment) throw fail(404, 'Appointment not found.');
  if (req.user.role === 'customer' && appointment.customer_id !== req.user.id) throw fail(403, 'You cannot access this invoice.');
  if (appointment.status !== 'completed') throw fail(409, 'Invoices are available after an appointment is completed.');
  let invoice;
  const [existing] = await pool.execute('SELECT invoice_number, amount, issued_at FROM invoices WHERE appointment_id = ?', [id]);
  if (existing[0]) invoice = existing[0];
  else {
    const invoiceNumber = `SAL-${new Date().getFullYear()}-${String(id).padStart(6, '0')}`;
    await pool.execute('INSERT INTO invoices (appointment_id, invoice_number, amount) VALUES (?, ?, ?)', [id, invoiceNumber, appointment.price]);
    invoice = { invoice_number: invoiceNumber, amount: appointment.price, issued_at: new Date().toISOString() };
  }
  res.json({ ...invoice, appointment });
}));

app.post('/api/appointments/:id/checkout', authenticate, asyncRoute(async (req, res) => {
  if (!stripe) throw fail(503, 'Online payments are not configured. Set STRIPE_SECRET_KEY to enable checkout.');
  const id = parseId(req.params.id);
  const [rows] = await pool.execute(`${appointmentSelect} WHERE a.id = ?`, [id]);
  const appointment = rows[0];
  if (!appointment) throw fail(404, 'Appointment not found.');
  if (req.user.role === 'customer' && appointment.customer_id !== req.user.id) throw fail(403, 'You cannot pay for this appointment.');
  if (appointment.status !== 'confirmed') throw fail(409, 'Only confirmed appointments can be paid.');
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    customer_email: appointment.customer_email,
    line_items: [{
      quantity: 1,
      price_data: {
        currency: process.env.STRIPE_CURRENCY || 'usd',
        unit_amount: Math.round(Number(appointment.price) * 100),
        product_data: { name: appointment.service_name },
      },
    }],
    metadata: { appointmentId: String(id) },
    success_url: process.env.STRIPE_SUCCESS_URL || 'http://localhost:5173/?payment=success',
    cancel_url: process.env.STRIPE_CANCEL_URL || 'http://localhost:5173/?payment=cancelled',
  });
  await pool.execute(
    `INSERT INTO payments (appointment_id, provider, provider_session_id, amount, status)
     VALUES (?, 'stripe', ?, ?, 'pending') ON DUPLICATE KEY UPDATE provider_session_id = VALUES(provider_session_id), status = 'pending'`,
    [id, session.id, appointment.price],
  );
  res.status(201).json({ checkoutUrl: session.url });
}));

app.post('/api/payments/webhook', express.raw({ type: 'application/json' }), asyncRoute(async (req, res) => {
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) throw fail(503, 'Stripe webhooks are not configured.');
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (error) {
    throw fail(400, `Invalid Stripe webhook signature: ${error.message}`);
  }
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    await pool.execute('UPDATE payments SET status = "paid" WHERE provider_session_id = ?', [session.id]);
  }
  res.json({ received: true });
}));

app.post('/api/appointments/:id/reviews', authenticate, asyncRoute(async (req, res) => {
  const id = parseId(req.params.id);
  const rating = Number(req.body.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw fail(400, 'Rating must be an integer from 1 to 5.');
  const [rows] = await pool.execute('SELECT * FROM appointments WHERE id = ?', [id]);
  const appointment = rows[0];
  if (!appointment || appointment.customer_id !== req.user.id) throw fail(404, 'Completed appointment not found.');
  if (appointment.status !== 'completed') throw fail(409, 'Only completed appointments can be reviewed.');
  const [result] = await pool.execute(
    'INSERT INTO reviews (appointment_id, customer_id, staff_id, rating, comment) VALUES (?, ?, ?, ?, ?)',
    [id, req.user.id, appointment.staff_id, rating, req.body.comment?.trim() || null],
  );
  res.status(201).json({ id: result.insertId, appointmentId: id, rating, comment: req.body.comment?.trim() || null });
}));

app.get('/api/reviews', asyncRoute(async (req, res) => {
  const staffId = req.query.staffId ? parseId(req.query.staffId) : null;
  const [rows] = await pool.execute(
    `SELECT r.id, r.rating, r.comment, r.staff_response, r.created_at, st.name AS staff_name
     FROM reviews r JOIN staff st ON st.id = r.staff_id
     WHERE (? IS NULL OR r.staff_id = ?) ORDER BY r.created_at DESC`,
    [staffId, staffId],
  );
  res.json(rows);
}));

app.patch('/api/reviews/:id/response', authenticate, allowRoles('admin', 'staff'), asyncRoute(async (req, res) => {
  const id = parseId(req.params.id);
  const response = req.body.response?.trim();
  if (!response) throw fail(400, 'A response is required.');
  if (req.user.role === 'staff') {
    const [owned] = await pool.execute('SELECT id FROM staff WHERE id = (SELECT id FROM staff WHERE user_id = ?)', [req.user.id]);
    if (!owned.length) throw fail(403, 'Your account is not linked to a staff profile.');
    const [review] = await pool.execute('SELECT id FROM reviews WHERE id = ? AND staff_id = ?', [id, owned[0].id]);
    if (!review.length) throw fail(403, 'You can only respond to reviews for your profile.');
  }
  const [result] = await pool.execute('UPDATE reviews SET staff_response = ? WHERE id = ?', [response, id]);
  if (!result.affectedRows) throw fail(404, 'Review not found.');
  res.json({ id, response });
}));

app.get('/api/admin/users', authenticate, allowRoles('admin'), asyncRoute(async (_req, res) => {
  const [rows] = await pool.execute('SELECT id, name, email, phone, role, created_at FROM users ORDER BY created_at DESC');
  res.json(rows);
}));

app.patch('/api/admin/users/:id', authenticate, allowRoles('admin'), asyncRoute(async (req, res) => {
  const id = parseId(req.params.id);
  const { role, name } = req.body;
  if (role !== undefined && !['customer', 'staff', 'admin'].includes(role)) throw fail(400, 'Role must be customer, staff, or admin.');
  const [result] = await pool.execute('UPDATE users SET role = COALESCE(?, role), name = COALESCE(?, name) WHERE id = ?', [role ?? null, name?.trim() || null, id]);
  if (!result.affectedRows) throw fail(404, 'User not found.');
  res.json(await getUser(id));
}));

app.use((req, _res, next) => next(fail(404, `Route not found: ${req.method} ${req.path}`)));
app.use((error, _req, res, _next) => {
  if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'A record with that value already exists.' });
  if (error.code === 'ER_NO_REFERENCED_ROW_2') return res.status(404).json({ error: 'A referenced record was not found.' });
  console.error(error);
  res.status(error.status || 500).json({ error: error.status ? error.message : 'An unexpected server error occurred.' });
});

async function initializeSchema() {
  if (!JWT_SECRET || JWT_SECRET.length < 32) {
    throw new Error('JWT_SECRET must be set to a random secret of at least 32 characters.');
  }
  for (const statement of schema) await pool.execute(statement);
}

function startReminderJob() {
  cron.schedule('*/15 * * * *', async () => {
    try {
      const [rows] = await pool.execute(
        `SELECT a.id, a.appointment_date, a.start_time, u.email, u.name AS customer_name,
         s.name AS service_name, st.name AS staff_name
         FROM appointments a JOIN users u ON u.id = a.customer_id
         JOIN services s ON s.id = a.service_id JOIN staff st ON st.id = a.staff_id
         WHERE a.status = 'confirmed' AND a.reminder_sent_at IS NULL
         AND TIMESTAMP(a.appointment_date, a.start_time) BETWEEN NOW() AND DATE_ADD(NOW(), INTERVAL 24 HOUR)`,
      );
      for (const appointment of rows) {
        await sendEmail({
          to: appointment.email,
          subject: 'Reminder: your salon appointment is coming up',
          text: `Hi ${appointment.customer_name}, a reminder that your ${appointment.service_name} appointment with ${appointment.staff_name} is on ${appointment.appointment_date} at ${appointment.start_time}.`,
        });
        await pool.execute('UPDATE appointments SET reminder_sent_at = NOW() WHERE id = ?', [appointment.id]);
      }
    } catch (error) {
      console.error('Appointment reminder job failed:', error);
    }
  }, { timezone: process.env.SALON_TIMEZONE || 'UTC' });
}

async function start() {
  await initializeSchema();
  startReminderJob();
  app.listen(PORT, () => console.log(`Salon booking API listening on http://localhost:${PORT}`));
}

if (require.main === module) {
  start().catch((error) => {
    console.error('Failed to start the API:', error);
    process.exitCode = 1;
  });
}

module.exports = { app, pool, initializeSchema };
