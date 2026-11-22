const express = require('express');
const { Op } = require('sequelize');
const { createHmac, randomUUID, timingSafeEqual } = require('node:crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const Stripe = require('stripe');
const { rateLimit } = require('express-rate-limit');
const {
  sequelize,
  User,
  Service,
  Staff,
  StaffService,
  StaffAvailability,
  Appointment,
  Payment,
  Invoice,
  Review,
} = require('../database/schema');

const router = express.Router();
const smtpFrom = process.env.SMTP_FROM || (
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(process.env.SMTP_USER || '') ? process.env.SMTP_USER : ''
);
const mailTransport = process.env.SMTP_HOST && smtpFrom
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === 'true',
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD } : undefined,
    })
  : null;
if (mailTransport && !process.env.SMTP_FROM) {
  console.warn('SMTP_FROM is unset; using the email SMTP_USER as the sender. Configure a verified SMTP_FROM address if delivery is rejected.');
}
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
const cashfreeClientId = process.env.CASHFREE_CLIENT_ID;
const cashfreeClientSecret = process.env.CASHFREE_CLIENT_SECRET;
const cashfreeConfigured = Boolean(cashfreeClientId && cashfreeClientSecret);
const cashfreeCurrency = (process.env.CASHFREE_CURRENCY || 'INR').toUpperCase();
if (!/^[A-Z]{3}$/.test(cashfreeCurrency)) {
  throw new Error('CASHFREE_CURRENCY must be a three-letter currency code.');
}
if (Boolean(cashfreeClientId) !== Boolean(cashfreeClientSecret)) {
  console.warn('Cashfree sandbox credentials are incomplete; checkout will use Stripe if configured.');
}
const cashfreeApiUrl = 'https://sandbox.cashfree.com/pg';
const paymentProvider = cashfreeConfigured ? 'cashfree' : stripe ? 'stripe' : null;
const paymentCurrency = paymentProvider === 'stripe'
  ? (process.env.STRIPE_CURRENCY || 'usd').toUpperCase()
  : cashfreeCurrency;
if (!paymentProvider) {
  console.warn('Online payments are disabled. Configure Cashfree sandbox credentials to enable checkout.');
}
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many authentication attempts. Try again in 15 minutes.' },
});
const fail = (status, message) => Object.assign(new Error(message), { status });
const asyncRoute = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const parseId = (value) => {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw fail(400, 'A valid ID is required.');
  return id;
};
const isDate = (value) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};
const salonDate = (date) => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: process.env.SALON_TIMEZONE || 'UTC',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date).reduce((values, part) => {
    if (part.type !== 'literal') values[part.type] = part.value;
    return values;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day}`;
};
const salonToday = () => salonDate(new Date());
const toMinutes = (value) => {
  const match = typeof value === 'string' && value.match(/^([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/);
  if (!match) throw fail(400, 'Time must use HH:MM format.');
  return Number(match[1]) * 60 + Number(match[2]);
};
const asTime = (minutes) =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}:00`;
const asPlain = (model) => model?.get({ plain: true });
const toPublicUser = (user) => {
  const result = asPlain(user);
  if (!result) return null;
  delete result.password_hash;
  return result;
};
const jsonValue = (value) => typeof value === 'string' ? JSON.parse(value) : value;

function authenticate(req, _res, next) {
  const token = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return next(fail(401, 'Authentication is required.'));
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    return next();
  } catch {
    return next(fail(401, 'Your session is invalid or has expired.'));
  }
}

const allowRoles = (...roles) => (req, _res, next) =>
  roles.includes(req.user.role) ? next() : next(fail(403, 'You do not have permission to do this.'));
const getUser = (id) => User.findByPk(id);
const appointmentIncludes = [
  { model: User, as: 'customer', attributes: ['name', 'email'] },
  { model: Staff, as: 'staff', attributes: ['name'] },
  { model: Service, as: 'service', attributes: ['name', 'duration_minutes', 'price'] },
  { model: Payment, as: 'payment', attributes: ['provider', 'status'] },
];
const serializeAppointment = (record) => {
  const appointment = asPlain(record);
  if (!appointment) return null;
  return {
    id: appointment.id,
    customer_id: appointment.customer_id,
    customer_name: appointment.customer?.name,
    customer_email: appointment.customer?.email,
    staff_id: appointment.staff_id,
    staff_name: appointment.staff?.name,
    service_id: appointment.service_id,
    service_name: appointment.service?.name,
    duration_minutes: appointment.service?.duration_minutes,
    price: appointment.service?.price,
    appointment_date: appointment.appointment_date,
    start_time: appointment.start_time,
    end_time: appointment.end_time,
    status: appointment.status,
    payment_status: appointment.payment?.status || null,
    payment_provider: appointment.payment?.provider || null,
    notes: appointment.notes,
    created_at: appointment.created_at,
  };
};
const findAppointment = (id, options = {}) => Appointment.findByPk(id, {
  include: appointmentIncludes,
  ...options,
});

async function sendEmail({ to, subject, text }) {
  if (!mailTransport) {
    console.warn(`Email not sent (SMTP is not configured): ${subject} -> ${to}`);
    return false;
  }
  await mailTransport.sendMail({ from: smtpFrom, to, subject, text });
  return true;
}

async function sendPaymentConfirmation(paymentId) {
  await sequelize.transaction(async (transaction) => {
    const payment = await Payment.findByPk(paymentId, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!payment || payment.status !== 'paid' || payment.confirmation_email_sent_at) return;

    const appointment = await findAppointment(payment.appointment_id, { transaction });
    if (!appointment) return;
    const data = serializeAppointment(appointment);
    await Appointment.update(
      { status: 'confirmed' },
      { where: { id: payment.appointment_id, status: 'pending_payment' }, transaction },
    );
    const sent = await sendEmail({
      to: data.customer_email,
      subject: 'Payment received — your salon appointment is confirmed',
      text: `Hi ${data.customer_name}, we received your payment for ${data.service_name}. Your appointment with ${data.staff_name} is confirmed for ${data.appointment_date} at ${data.start_time}.`,
    });
    if (sent) await payment.update({ confirmation_email_sent_at: new Date() }, { transaction });
  });
}

async function cashfreeRequest(path, { method = 'GET', body } = {}) {
  let response;
  try {
    response = await fetch(`${cashfreeApiUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'x-api-version': '2023-08-01',
        'x-client-id': cashfreeClientId,
        'x-client-secret': cashfreeClientSecret,
        ...(method === 'POST' ? { 'x-idempotency-key': randomUUID() } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch (error) {
    console.error('Cashfree sandbox request failed to connect:', error.message);
    throw fail(502, 'Could not connect to Cashfree sandbox. Please try again.');
  }
  if (!response.ok) {
    console.error(`Cashfree sandbox request failed with status ${response.status}.`);
    throw fail(502, 'Cashfree sandbox could not process the payment request. Check the sandbox credentials and try again.');
  }
  try {
    return await response.json();
  } catch {
    throw fail(502, 'Cashfree sandbox returned an invalid response.');
  }
}

function verifyCashfreeWebhook(rawBody, timestamp, signature) {
  if (!Buffer.isBuffer(rawBody) || !timestamp || !signature || !cashfreeClientSecret) return false;
  const expected = createHmac('sha256', cashfreeClientSecret)
    .update(timestamp + rawBody.toString('utf8'))
    .digest();
  const received = Buffer.from(signature, 'base64');
  return received.length === expected.length && timingSafeEqual(received, expected);
}

async function syncCashfreePayment(orderId) {
  const payment = await Payment.findOne({
    where: { provider: 'cashfree', provider_session_id: orderId },
  });
  if (!payment) return null;

  if (payment.status === 'pending') {
    const order = await cashfreeRequest(`/orders/${encodeURIComponent(orderId)}`);
    const amountMatches = Math.round(Number(order.order_amount) * 100) === Math.round(Number(payment.amount) * 100);
    const currencyMatches = String(order.order_currency).toUpperCase() === cashfreeCurrency;
    if (!amountMatches || !currencyMatches) {
      console.error('Cashfree order verification failed: amount or currency mismatch.');
      throw fail(502, 'Cashfree payment details could not be verified. Contact the salon before retrying.');
    }

    if (order.order_status === 'PAID') await payment.update({ status: 'paid' });
    else if (['EXPIRED', 'TERMINATED'].includes(order.order_status)) await payment.update({ status: 'failed' });
  }

  if (payment.status === 'paid') {
    try {
      await sendPaymentConfirmation(payment.id);
    } catch (error) {
      console.error('Payment confirmation email failed:', error.message);
    }
  }
  return payment;
}

async function notifyBooking(appointmentId, kind = 'confirmed') {
  const appointment = await findAppointment(appointmentId);
  if (!appointment) return;
  const data = serializeAppointment(appointment);
  await sendEmail({
    to: data.customer_email,
    subject: `Salon appointment ${kind}`,
    text: `Hi ${data.customer_name}, your ${data.service_name} appointment with ${data.staff_name} is ${kind} for ${data.appointment_date} at ${data.start_time}.`,
  });
}

router.get('/health', (_req, res) => res.json({ status: 'ok' }));
router.get('/payments/config', (_req, res) => {
  res.json({ provider: paymentProvider, currency: paymentCurrency });
});

router.post('/auth/register', authLimiter, asyncRoute(async (req, res) => {
  const { name, email, password, phone } = req.body;
  if (typeof name !== 'string' || !name.trim() || typeof email !== 'string' || !email.trim() || typeof password !== 'string') {
    throw fail(400, 'Name, email, and password are required.');
  }
  if (name.trim().length > 120 || email.trim().length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
    throw fail(400, 'Enter a valid name and email address.');
  }
  const passwordBytes = Buffer.byteLength(password, 'utf8');
  if (passwordBytes < 8 || passwordBytes > 72) throw fail(400, 'Password must be 8-72 UTF-8 bytes long.');
  if (phone !== undefined && phone !== null && (typeof phone !== 'string' || phone.length > 32)) {
    throw fail(400, 'Phone must be at most 32 characters.');
  }
  const user = await User.create({
    name: name.trim(),
    email: email.trim().toLowerCase(),
    password_hash: await bcrypt.hash(password, 12),
    phone: phone?.trim() || null,
    role: 'customer',
  });
  const publicUser = toPublicUser(user);
  const token = jwt.sign({ id: user.id, role: user.role }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '12h' });
  res.status(201).json({ token, user: publicUser });
}));

router.post('/auth/login', authLimiter, asyncRoute(async (req, res) => {
  const { email, password } = req.body;
  if (typeof email !== 'string' || !email.trim() || typeof password !== 'string' || !password) {
    throw fail(400, 'Email and password are required.');
  }
  const user = await User.findOne({ where: { email: email.trim().toLowerCase() } });
  if (!user || !(await bcrypt.compare(password, user.password_hash))) throw fail(401, 'Email or password is incorrect.');
  const publicUser = toPublicUser(user);
  const token = jwt.sign({ id: user.id, role: user.role }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '12h' });
  res.json({ token, user: publicUser });
}));

router.get('/profile', authenticate, asyncRoute(async (req, res) => {
  const user = await getUser(req.user.id);
  if (!user) throw fail(404, 'User not found.');
  res.json(toPublicUser(user));
}));

router.patch('/profile', authenticate, asyncRoute(async (req, res) => {
  const { name, phone, preferences } = req.body;
  if (name !== undefined && (typeof name !== 'string' || !name.trim() || name.trim().length > 120)) throw fail(400, 'Name must be between 1 and 120 characters.');
  if (phone !== undefined && phone !== null && (typeof phone !== 'string' || phone.length > 32)) throw fail(400, 'Phone must be at most 32 characters.');
  if (preferences !== undefined && (!preferences || typeof preferences !== 'object' || Array.isArray(preferences))) {
    throw fail(400, 'Preferences must be an object.');
  }
  const user = await getUser(req.user.id);
  if (!user) throw fail(404, 'User not found.');
  await user.update({
    name: name === undefined ? user.name : name.trim(),
    phone: phone === undefined ? user.phone : phone,
    preferences: preferences === undefined ? user.preferences : preferences,
  });
  res.json(toPublicUser(user));
}));

router.get('/services', asyncRoute(async (_req, res) => {
  const services = await Service.findAll({
    where: { active: true },
    attributes: ['id', 'name', 'description', 'duration_minutes', 'price'],
    order: [['name', 'ASC']],
  });
  res.json(services);
}));

router.post('/services', authenticate, allowRoles('admin'), asyncRoute(async (req, res) => {
  const { name, description = '', durationMinutes, price } = req.body;
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 120 ||
      typeof description !== 'string' || !Number.isInteger(durationMinutes) || durationMinutes < 5 ||
      !Number.isFinite(Number(price)) || Number(price) < 0) {
    throw fail(400, 'Name, a duration of at least 5 minutes, and a non-negative price are required.');
  }
  const service = await Service.create({
    name: name.trim(), description, duration_minutes: durationMinutes, price: Number(price),
  });
  res.status(201).json(service);
}));

router.patch('/services/:id', authenticate, allowRoles('admin'), asyncRoute(async (req, res) => {
  const service = await Service.findByPk(parseId(req.params.id));
  if (!service) throw fail(404, 'Service not found.');
  const { name, description, durationMinutes, price, active } = req.body;
  if (name !== undefined && (typeof name !== 'string' || !name.trim())) throw fail(400, 'Service name cannot be empty.');
  if (name !== undefined && name.trim().length > 120) throw fail(400, 'Service name must be at most 120 characters.');
  if (description !== undefined && description !== null && typeof description !== 'string') throw fail(400, 'Description must be a string.');
  if (durationMinutes !== undefined && (!Number.isInteger(durationMinutes) || durationMinutes < 5)) throw fail(400, 'Duration must be at least 5 minutes.');
  if (price !== undefined && (!Number.isFinite(Number(price)) || Number(price) < 0)) throw fail(400, 'Price must be a non-negative number.');
  if (active !== undefined && typeof active !== 'boolean') throw fail(400, 'Active must be a boolean.');
  await service.update({
    ...(name !== undefined && { name: name.trim() }),
    ...(description !== undefined && { description }),
    ...(durationMinutes !== undefined && { duration_minutes: durationMinutes }),
    ...(price !== undefined && { price: Number(price) }),
    ...(active !== undefined && { active }),
  });
  res.json(service);
}));

router.delete('/services/:id', authenticate, allowRoles('admin'), asyncRoute(async (req, res) => {
  const service = await Service.findByPk(parseId(req.params.id));
  if (!service) throw fail(404, 'Service not found.');
  await service.update({ active: false });
  res.status(204).end();
}));

router.get('/staff', asyncRoute(async (_req, res) => {
  const staff = await Staff.findAll({
    where: { active: true },
    attributes: ['id', 'name', 'bio', 'specializations', 'active'],
    include: [{
      model: Service,
      as: 'services',
      attributes: ['id', 'name'],
      through: { attributes: [] },
      where: { active: true },
      required: false,
    }, {
      model: StaffAvailability,
      as: 'availability',
      attributes: ['weekday', 'start_time', 'end_time', 'is_available'],
    }],
    order: [['name', 'ASC']],
  });
  res.json(staff.map((member) => ({
    ...asPlain(member),
    specializations: jsonValue(member.specializations),
    services: member.services || [],
    availability: member.availability || [],
  })));
}));

router.post('/staff', authenticate, allowRoles('admin'), asyncRoute(async (req, res) => {
  const { name, bio = '', specializations = [], userId = null } = req.body;
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 120 ||
      typeof bio !== 'string' || !Array.isArray(specializations)) {
    throw fail(400, 'Name, bio, and a specializations array are required.');
  }
  const member = await Staff.create({
    name: name.trim(), bio, specializations, user_id: userId ? parseId(userId) : null,
  });
  res.status(201).json(member);
}));

router.patch('/staff/:id', authenticate, allowRoles('admin'), asyncRoute(async (req, res) => {
  const member = await Staff.findByPk(parseId(req.params.id));
  if (!member) throw fail(404, 'Staff member not found.');
  const { name, bio, specializations, active, userId } = req.body;
  if (name !== undefined && (typeof name !== 'string' || !name.trim())) throw fail(400, 'Staff name cannot be empty.');
  if (name !== undefined && name.trim().length > 120) throw fail(400, 'Staff name must be at most 120 characters.');
  if (bio !== undefined && bio !== null && typeof bio !== 'string') throw fail(400, 'Bio must be a string.');
  if (specializations !== undefined && !Array.isArray(specializations)) throw fail(400, 'Specializations must be an array.');
  if (active !== undefined && typeof active !== 'boolean') throw fail(400, 'Active must be a boolean.');
  await member.update({
    ...(name !== undefined && { name: name.trim() }),
    ...(bio !== undefined && { bio }),
    ...(specializations !== undefined && { specializations }),
    ...(active !== undefined && { active }),
    ...(userId !== undefined && { user_id: userId === null ? null : parseId(userId) }),
  });
  res.json(member);
}));

router.delete('/staff/:id', authenticate, allowRoles('admin'), asyncRoute(async (req, res) => {
  const member = await Staff.findByPk(parseId(req.params.id));
  if (!member) throw fail(404, 'Staff member not found.');
  await member.update({ active: false });
  res.status(204).end();
}));

router.put('/staff/:id/services/:serviceId', authenticate, allowRoles('admin'), asyncRoute(async (req, res) => {
  const member = await Staff.findByPk(parseId(req.params.id));
  const service = await Service.findByPk(parseId(req.params.serviceId));
  if (!member || !service) throw fail(404, 'Staff member or service not found.');
  await member.addService(service);
  res.status(204).end();
}));

router.delete('/staff/:id/services/:serviceId', authenticate, allowRoles('admin'), asyncRoute(async (req, res) => {
  const member = await Staff.findByPk(parseId(req.params.id));
  if (!member) throw fail(404, 'Staff member not found.');
  const service = await Service.findByPk(parseId(req.params.serviceId));
  if (service) await member.removeService(service);
  res.status(204).end();
}));

router.put('/staff/:id/availability', authenticate, allowRoles('admin'), asyncRoute(async (req, res) => {
  const staffId = parseId(req.params.id);
  const { weekday, startTime, endTime, isAvailable = true } = req.body;
  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) throw fail(400, 'Weekday must be 0 (Sunday) through 6 (Saturday).');
  if (typeof isAvailable !== 'boolean') throw fail(400, 'isAvailable must be a boolean.');
  const start = toMinutes(startTime);
  const end = toMinutes(endTime);
  if (end <= start) throw fail(400, 'End time must be after start time.');
  if (!(await Staff.findByPk(staffId))) throw fail(404, 'Staff member not found.');
  const start_time = asTime(start);
  const [availability, created] = await StaffAvailability.findOrCreate({
    where: { staff_id: staffId, weekday, start_time },
    defaults: { end_time: asTime(end), is_available: isAvailable },
  });
  if (!created) await availability.update({ end_time: asTime(end), is_available: isAvailable });
  res.status(204).end();
}));

router.get('/availability', asyncRoute(async (req, res) => {
  const serviceId = parseId(req.query.serviceId);
  const date = String(req.query.date || '');
  if (!isDate(date)) throw fail(400, 'Date must use YYYY-MM-DD format.');
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  const staffId = req.query.staffId ? parseId(req.query.staffId) : null;
  const service = await Service.findOne({ where: { id: serviceId, active: true } });
  if (!service) throw fail(404, 'Service not found.');
  const staff = await Staff.findAll({
    where: { active: true, ...(staffId && { id: staffId }) },
    attributes: ['id', 'name'],
    include: [
      {
        model: Service, as: 'services', attributes: ['id'], through: { attributes: [] },
        where: { id: serviceId, active: true }, required: true,
      },
      {
        model: StaffAvailability, as: 'availability', attributes: ['start_time', 'end_time'],
        where: { weekday, is_available: true }, required: true,
      },
    ],
    order: [['name', 'ASC']],
  });
  const booked = await Appointment.findAll({
    where: { appointment_date: date, status: { [Op.in]: ['pending_payment', 'confirmed'] } },
    attributes: ['staff_id', 'start_time', 'end_time'],
  });
  const slots = [];
  const now = new Date();
  const currentMinute = now.getHours() * 60 + now.getMinutes();
  for (const member of staff) {
    const busy = booked.filter((appointment) => String(appointment.staff_id) === String(member.id)).map((appointment) => ({
      start: toMinutes(appointment.start_time), end: toMinutes(appointment.end_time),
    }));
    for (const hours of member.availability) {
      const opening = toMinutes(hours.start_time);
      const closing = toMinutes(hours.end_time);
      for (let start = opening; start + service.duration_minutes <= closing; start += 15) {
        const end = start + service.duration_minutes;
        if (date === salonToday() && start <= currentMinute) continue;
        if (!busy.some((appointment) => start < appointment.end && end > appointment.start)) {
          slots.push({ staffId: member.id, staffName: member.name, startTime: asTime(start).slice(0, 5), endTime: asTime(end).slice(0, 5) });
        }
      }
    }
  }
  res.json(slots);
}));

router.post('/appointments', authenticate, asyncRoute(async (req, res) => {
  if (!paymentProvider) {
    throw fail(503, 'Online payment is required. Configure Cashfree or Stripe before confirming a booking.');
  }
  const serviceId = parseId(req.body.serviceId);
  const staffId = parseId(req.body.staffId);
  const date = String(req.body.date || '');
  const start = toMinutes(req.body.startTime);
  if (req.body.notes !== undefined && typeof req.body.notes !== 'string') throw fail(400, 'Notes must be a string.');
  if (!isDate(date) || date < salonToday()) throw fail(400, 'Choose a valid date that is not in the past.');
  const service = await Service.findOne({
    where: { id: serviceId, active: true },
    include: [{ model: Staff, as: 'staff', where: { id: staffId, active: true }, through: { attributes: [] }, required: true }],
  });
  if (!service) throw fail(400, 'This staff member is not available for the selected service.');
  const end = start + service.duration_minutes;
  if (end > 24 * 60 || (date === salonToday() && start <= new Date().getHours() * 60 + new Date().getMinutes())) {
    throw fail(400, 'Choose a future appointment time.');
  }
  const appointment = await sequelize.transaction(async (transaction) => {
    await Staff.findByPk(staffId, { transaction, lock: transaction.LOCK.UPDATE });
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    const hours = await StaffAvailability.findOne({
      where: {
        staff_id: staffId, weekday, is_available: true,
        start_time: { [Op.lte]: asTime(start) },
        end_time: { [Op.gte]: asTime(end) },
      },
      transaction,
    });
    if (!hours) throw fail(409, "The selected time is outside this staff member's working hours.");
    const conflict = await Appointment.findOne({
      where: {
        staff_id: staffId, appointment_date: date,
        status: { [Op.in]: ['pending_payment', 'confirmed'] },
        start_time: { [Op.lt]: asTime(end) },
        end_time: { [Op.gt]: asTime(start) },
      },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (conflict) throw fail(409, 'That time slot has just been booked. Please choose another.');
    return Appointment.create({
      customer_id: req.user.id, staff_id: staffId, service_id: serviceId,
      appointment_date: date, start_time: asTime(start), end_time: asTime(end),
      notes: req.body.notes?.trim() || null,
      status: 'pending_payment',
    }, { transaction });
  });
  res.status(201).json(serializeAppointment(await findAppointment(appointment.id)));
}));

router.get('/appointments', authenticate, asyncRoute(async (req, res) => {
  const where = {};
  if (req.user.role === 'customer') where.customer_id = req.user.id;
  if (req.query.status) {
    if (!['pending_payment', 'confirmed', 'cancelled', 'completed'].includes(req.query.status)) throw fail(400, 'Unknown appointment status.');
    where.status = req.query.status;
  }
  const appointments = await Appointment.findAll({
    where,
    include: appointmentIncludes,
    order: [['appointment_date', 'DESC'], ['start_time', 'DESC']],
  });
  res.json(appointments.map(serializeAppointment));
}));

router.get('/appointments/:id', authenticate, asyncRoute(async (req, res) => {
  const appointment = await findAppointment(parseId(req.params.id));
  if (!appointment) throw fail(404, 'Appointment not found.');
  const data = serializeAppointment(appointment);
  if (req.user.role === 'customer' && String(data.customer_id) !== String(req.user.id)) {
    throw fail(403, 'You cannot view this appointment.');
  }
  res.json(data);
}));

router.patch('/appointments/:id/reschedule', authenticate, asyncRoute(async (req, res) => {
  const id = parseId(req.params.id);
  const date = String(req.body.date || '');
  const start = toMinutes(req.body.startTime);
  if (!isDate(date) || date < salonToday()) throw fail(400, 'Choose a valid date that is not in the past.');
  const existing = await Appointment.findByPk(id);
  if (!existing) throw fail(404, 'Appointment not found.');
  if (req.user.role === 'customer' && String(existing.customer_id) !== String(req.user.id)) throw fail(403, 'You cannot change this appointment.');
  if (existing.status !== 'confirmed') throw fail(409, 'Only confirmed appointments can be rescheduled.');
  const cutoff = Number(process.env.CANCELLATION_CUTOFF_HOURS || 24);
  if (new Date(`${existing.appointment_date}T${existing.start_time}`) - Date.now() < cutoff * 3600000) {
    throw fail(409, `Appointments can only be changed at least ${cutoff} hours in advance.`);
  }
  const duration = toMinutes(existing.end_time) - toMinutes(existing.start_time);
  if (start + duration > 24 * 60 || (date === salonToday() && start <= new Date().getHours() * 60 + new Date().getMinutes())) {
    throw fail(400, 'Choose a future appointment time.');
  }
  await sequelize.transaction(async (transaction) => {
    const lockedAppointment = await Appointment.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!lockedAppointment || lockedAppointment.status !== 'confirmed') throw fail(409, 'Only confirmed appointments can be rescheduled.');
    await Staff.findByPk(existing.staff_id, { transaction, lock: transaction.LOCK.UPDATE });
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    const hours = await StaffAvailability.findOne({
      where: {
        staff_id: existing.staff_id, weekday, is_available: true,
        start_time: { [Op.lte]: asTime(start + duration) },
        end_time: { [Op.gte]: asTime(start) },
      },
      transaction,
    });
    if (!hours) throw fail(409, "The selected time is outside this staff member's working hours.");
    const conflict = await Appointment.findOne({
      where: {
        id: { [Op.ne]: id }, staff_id: existing.staff_id, appointment_date: date,
        status: { [Op.in]: ['pending_payment', 'confirmed'] },
        start_time: { [Op.lt]: asTime(start + duration) },
        end_time: { [Op.gt]: asTime(start) },
      },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (conflict) throw fail(409, 'That time slot is already booked.');
    await lockedAppointment.update({ appointment_date: date, start_time: asTime(start), end_time: asTime(start + duration) }, { transaction });
  });
  await notifyBooking(id, 'rescheduled').catch((error) => console.error('Reschedule email failed:', error.message));
  res.json(serializeAppointment(await findAppointment(id)));
}));

router.patch('/appointments/:id/cancel', authenticate, asyncRoute(async (req, res) => {
  const id = parseId(req.params.id);
  const appointment = await Appointment.findByPk(id);
  if (!appointment) throw fail(404, 'Appointment not found.');
  if (req.user.role === 'customer' && String(appointment.customer_id) !== String(req.user.id)) throw fail(403, 'You cannot cancel this appointment.');
  if (!['pending_payment', 'confirmed'].includes(appointment.status)) throw fail(409, 'Only pending or confirmed appointments can be cancelled.');
  const cutoff = Number(process.env.CANCELLATION_CUTOFF_HOURS || 24);
  if (req.user.role === 'customer' && new Date(`${appointment.appointment_date}T${appointment.start_time}`) - Date.now() < cutoff * 3600000) {
    throw fail(409, `Appointments can only be cancelled at least ${cutoff} hours in advance.`);
  }
  await appointment.update({ status: 'cancelled' });
  await notifyBooking(id, 'cancelled').catch((error) => console.error('Cancellation email failed:', error.message));
  res.json({ id, status: 'cancelled' });
}));

router.patch('/appointments/:id/status', authenticate, allowRoles('admin'), asyncRoute(async (req, res) => {
  const id = parseId(req.params.id);
  const { status } = req.body;
  if (!['pending_payment', 'confirmed', 'cancelled', 'completed'].includes(status)) throw fail(400, 'Status must be pending_payment, confirmed, cancelled, or completed.');
  const appointment = await Appointment.findByPk(id);
  if (!appointment) throw fail(404, 'Appointment not found.');
  await appointment.update({ status });
  res.json({ id, status });
}));

router.get('/appointments/:id/invoice', authenticate, asyncRoute(async (req, res) => {
  const id = parseId(req.params.id);
  const appointment = await findAppointment(id);
  if (!appointment) throw fail(404, 'Appointment not found.');
  const data = serializeAppointment(appointment);
  if (req.user.role === 'customer' && String(data.customer_id) !== String(req.user.id)) throw fail(403, 'You cannot access this invoice.');
  if (data.status !== 'completed') throw fail(409, 'Invoices are available after an appointment is completed.');
  const [invoice] = await Invoice.findOrCreate({
    where: { appointment_id: id },
    defaults: {
      invoice_number: `SAL-${new Date().getFullYear()}-${String(id).padStart(6, '0')}`,
      amount: data.price,
    },
  });
  res.json({ ...asPlain(invoice), appointment: data });
}));

router.post('/appointments/:id/checkout', authenticate, asyncRoute(async (req, res) => {
  if (!cashfreeConfigured && !stripe) {
    throw fail(503, 'Online payments are not configured. Set Cashfree sandbox credentials to enable checkout.');
  }
  const id = parseId(req.params.id);
  const appointment = await findAppointment(id);
  if (!appointment) throw fail(404, 'Appointment not found.');
  const data = serializeAppointment(appointment);
  if (req.user.role === 'customer' && String(data.customer_id) !== String(req.user.id)) throw fail(403, 'You cannot pay for this appointment.');
  if (!['pending_payment', 'confirmed'].includes(data.status)) throw fail(409, 'Only pending or confirmed appointments can be paid.');
  const existingPayment = await Payment.findOne({ where: { appointment_id: id } });
  if (existingPayment?.status === 'paid') throw fail(409, 'This appointment has already been paid.');
  if (cashfreeConfigured) {
    const amount = Number(data.price);
    if (!Number.isFinite(amount) || amount <= 0) throw fail(409, 'This appointment does not have a payable amount.');
    const customer = await User.findByPk(data.customer_id, { attributes: ['phone'] });
    const phoneDigits = String(customer?.phone || '').replace(/\D/g, '');
    const customerPhone = phoneDigits.length === 12 && phoneDigits.startsWith('91') ? phoneDigits.slice(2) : phoneDigits;
    if (!/^\d{10}$/.test(customerPhone)) {
      throw fail(400, 'Add a valid 10-digit phone number to your profile before paying with Cashfree.');
    }

    const returnUrl = new URL(process.env.CASHFREE_RETURN_URL || process.env.FRONTEND_ORIGIN || 'http://localhost:5173');
    returnUrl.searchParams.set('payment', 'cashfree_return');
    returnUrl.searchParams.set('appointmentId', String(id));
    const orderId = `salon-${id}-${Date.now()}`;
    const order = await cashfreeRequest('/orders', {
      method: 'POST',
      body: {
        order_id: orderId,
        order_amount: amount,
        order_currency: cashfreeCurrency,
        customer_details: {
          customer_id: `salon-${data.customer_id}`,
          customer_name: String(data.customer_name || 'Salon customer').slice(0, 100),
          customer_email: data.customer_email,
          customer_phone: customerPhone,
        },
        order_meta: {
          return_url: returnUrl.toString(),
          ...(process.env.CASHFREE_NOTIFY_URL ? { notify_url: process.env.CASHFREE_NOTIFY_URL } : {}),
        },
        order_note: `Salon appointment ${id}`,
      },
    });
    if (!order.order_id || !order.payment_session_id) {
      throw fail(502, 'Cashfree sandbox did not return a valid payment session.');
    }
    const [payment, created] = await Payment.findOrCreate({
      where: { appointment_id: id },
      defaults: { provider: 'cashfree', provider_session_id: order.order_id, amount, status: 'pending' },
    });
    if (!created) await payment.update({ provider: 'cashfree', provider_session_id: order.order_id, amount, status: 'pending' });
    res.status(201).json({
      provider: 'cashfree',
      paymentSessionId: order.payment_session_id,
      mode: 'sandbox',
      currency: cashfreeCurrency,
    });
    return;
  }

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    customer_email: data.customer_email,
    line_items: [{
      quantity: 1,
      price_data: {
        currency: (process.env.STRIPE_CURRENCY || 'usd').toLowerCase(),
        unit_amount: Math.round(Number(data.price) * 100),
        product_data: { name: data.service_name },
      },
    }],
    metadata: { appointmentId: String(id) },
    success_url: process.env.STRIPE_SUCCESS_URL || 'http://localhost:5173/?payment=success',
    cancel_url: process.env.STRIPE_CANCEL_URL || 'http://localhost:5173/?payment=cancelled',
  });
  const [payment, created] = await Payment.findOrCreate({
    where: { appointment_id: id },
    defaults: { provider: 'stripe', provider_session_id: session.id, amount: data.price, status: 'pending' },
  });
  if (!created) await payment.update({ provider: 'stripe', provider_session_id: session.id, amount: data.price, status: 'pending' });
  res.status(201).json({ provider: 'stripe', checkoutUrl: session.url });
}));

router.get('/appointments/:id/payment', authenticate, asyncRoute(async (req, res) => {
  const id = parseId(req.params.id);
  const appointment = await findAppointment(id);
  if (!appointment) throw fail(404, 'Appointment not found.');
  const data = serializeAppointment(appointment);
  if (req.user.role === 'customer' && String(data.customer_id) !== String(req.user.id)) throw fail(403, 'You cannot access this payment.');
  const payment = await Payment.findOne({ where: { appointment_id: id } });
  if (!payment) throw fail(404, 'No payment has been started for this appointment.');
  const currentPayment = payment.provider === 'cashfree'
    ? await syncCashfreePayment(payment.provider_session_id)
    : payment;
  const refreshedPayment = await Payment.findByPk(currentPayment.id);
  res.json({
    provider: refreshedPayment.provider,
    status: refreshedPayment.status,
    amount: refreshedPayment.amount,
    currency: refreshedPayment.provider === 'cashfree' ? cashfreeCurrency : (process.env.STRIPE_CURRENCY || 'usd').toUpperCase(),
    confirmationEmailSent: Boolean(refreshedPayment.confirmation_email_sent_at),
  });
}));

router.post('/payments/webhook', asyncRoute(async (req, res) => {
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) throw fail(503, 'Stripe webhooks are not configured.');
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (error) {
    throw fail(400, `Invalid Stripe webhook signature: ${error.message}`);
  }
  if (event.type === 'checkout.session.completed') {
    const payment = await Payment.findOne({
      where: { provider: 'stripe', provider_session_id: event.data.object.id },
    });
    if (payment) {
      await payment.update({ status: 'paid' });
      await Appointment.update(
        { status: 'confirmed' },
        { where: { id: payment.appointment_id, status: 'pending_payment' } },
      );
      await sendPaymentConfirmation(payment.id);
    }
  }
  res.json({ received: true });
}));

router.post('/payments/cashfree/webhook', asyncRoute(async (req, res) => {
  if (!cashfreeConfigured) throw fail(503, 'Cashfree sandbox webhooks are not configured.');
  if (!verifyCashfreeWebhook(req.body, req.headers['x-webhook-timestamp'], req.headers['x-webhook-signature'])) {
    throw fail(400, 'Invalid Cashfree webhook signature.');
  }
  let event;
  try {
    event = JSON.parse(req.body.toString('utf8'));
  } catch {
    throw fail(400, 'Invalid Cashfree webhook payload.');
  }
  const orderId = event?.data?.order?.order_id;
  if (typeof orderId !== 'string' || !orderId) throw fail(400, 'Cashfree webhook is missing its order ID.');
  await syncCashfreePayment(orderId);
  res.json({ received: true });
}));

router.post('/appointments/:id/reviews', authenticate, asyncRoute(async (req, res) => {
  const id = parseId(req.params.id);
  const rating = Number(req.body.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw fail(400, 'Rating must be an integer from 1 to 5.');
  const appointment = await Appointment.findByPk(id);
  if (!appointment || String(appointment.customer_id) !== String(req.user.id)) throw fail(404, 'Completed appointment not found.');
  if (appointment.status !== 'completed') throw fail(409, 'Only completed appointments can be reviewed.');
  const review = await Review.create({
    appointment_id: id,
    customer_id: req.user.id,
    staff_id: appointment.staff_id,
    rating,
    comment: req.body.comment?.trim() || null,
  });
  res.status(201).json({ id: review.id, appointmentId: id, rating: review.rating, comment: review.comment });
}));

router.get('/reviews', asyncRoute(async (req, res) => {
  const staffId = req.query.staffId ? parseId(req.query.staffId) : null;
  const reviews = await Review.findAll({
    where: staffId ? { staff_id: staffId } : {},
    attributes: ['id', 'rating', 'comment', 'staff_response', 'created_at'],
    include: [{ model: Staff, as: 'staff', attributes: ['name'] }],
    order: [['created_at', 'DESC']],
  });
  res.json(reviews.map((review) => {
    const data = asPlain(review);
    return { ...data, staff_name: data.staff?.name, staff: undefined };
  }));
}));

router.patch('/reviews/:id/response', authenticate, allowRoles('admin', 'staff'), asyncRoute(async (req, res) => {
  const id = parseId(req.params.id);
  const response = req.body.response?.trim();
  if (!response) throw fail(400, 'A response is required.');
  const review = await Review.findByPk(id);
  if (!review) throw fail(404, 'Review not found.');
  if (req.user.role === 'staff') {
    const member = await Staff.findOne({ where: { user_id: req.user.id } });
    if (!member) throw fail(403, 'Your account is not linked to a staff profile.');
    if (String(review.staff_id) !== String(member.id)) throw fail(403, 'You can only respond to reviews for your profile.');
  }
  await review.update({ staff_response: response });
  res.json({ id, response });
}));

router.get('/admin/dashboard', authenticate, allowRoles('admin'), asyncRoute(async (_req, res) => {
  const today = salonToday();
  const [users, services, staff, reviews, appointments, todayAppointments, upcoming] = await Promise.all([
    User.count(),
    Service.count({ where: { active: true } }),
    Staff.count({ where: { active: true } }),
    Review.count(),
    Appointment.count(),
    Appointment.count({ where: { appointment_date: today, status: 'confirmed' } }),
    Appointment.findAll({
      where: { appointment_date: { [Op.gte]: today }, status: 'confirmed' },
      include: appointmentIncludes,
      order: [['appointment_date', 'ASC'], ['start_time', 'ASC']],
      limit: 10,
    }),
  ]);
  res.json({
    users,
    services,
    staff,
    reviews,
    appointments,
    todayAppointments,
    upcomingAppointments: upcoming.map(serializeAppointment),
  });
}));

router.get('/admin/users', authenticate, allowRoles('admin'), asyncRoute(async (_req, res) => {
  const users = await User.findAll({
    attributes: ['id', 'name', 'email', 'phone', 'role', 'created_at'],
    order: [['created_at', 'DESC']],
  });
  res.json(users);
}));

router.patch('/admin/users/:id', authenticate, allowRoles('admin'), asyncRoute(async (req, res) => {
  const user = await User.findByPk(parseId(req.params.id));
  if (!user) throw fail(404, 'User not found.');
  const { role, name } = req.body;
  if (role !== undefined && !['customer', 'staff', 'admin'].includes(role)) throw fail(400, 'Role must be customer, staff, or admin.');
  if (name !== undefined && (typeof name !== 'string' || !name.trim())) throw fail(400, 'User name cannot be empty.');
  await user.update({
    ...(role !== undefined && { role }),
    ...(name !== undefined && { name: name.trim() }),
  });
  res.json(toPublicUser(user));
}));

router.use((req, _res, next) => next(fail(404, `Route not found: ${req.method} ${req.path}`)));
router.use((error, _req, res, _next) => {
  if (error.name === 'SequelizeUniqueConstraintError' || error.name === 'SequelizeForeignKeyConstraintError') {
    return res.status(error.name === 'SequelizeUniqueConstraintError' ? 409 : 404).json({
      error: error.name === 'SequelizeUniqueConstraintError' ? 'A record with that value already exists.' : 'A referenced record was not found.',
    });
  }
  if (!error.status || error.status >= 500) console.error(error);
  res.status(error.status || 500).json({ error: error.status ? error.message : 'An unexpected server error occurred.' });
});

function startReminderJob(cron) {
  if (!mailTransport) {
    console.warn('Appointment reminders are disabled. Configure SMTP_HOST and SMTP_FROM, or set SMTP_USER to an email address.');
    return;
  }
  cron.schedule('*/15 * * * *', async () => {
    try {
      const now = new Date();
      const until = new Date(now.getTime() + 24 * 60 * 60 * 1000);
      const appointments = await Appointment.findAll({
        where: {
          status: 'confirmed',
          reminder_sent_at: null,
          appointment_date: { [Op.between]: [salonDate(now), salonDate(until)] },
        },
        include: appointmentIncludes,
      });
      for (const appointment of appointments) {
        const data = serializeAppointment(appointment);
        const start = new Date(`${data.appointment_date}T${data.start_time}`);
        if (start < now || start > until) continue;
        await sendEmail({
          to: data.customer_email,
          subject: 'Reminder: your salon appointment is coming up',
          text: `Hi ${data.customer_name}, a reminder that your ${data.service_name} appointment with ${data.staff_name} is on ${data.appointment_date} at ${data.start_time}.`,
        });
        await appointment.update({ reminder_sent_at: new Date() });
      }
    } catch (error) {
      console.error('Appointment reminder job failed:', error);
    }
  }, { timezone: process.env.SALON_TIMEZONE || 'UTC' });
}

module.exports = { router, startReminderJob, verifyCashfreeWebhook };
