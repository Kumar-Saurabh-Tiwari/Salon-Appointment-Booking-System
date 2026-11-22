const { DataTypes, Sequelize } = require('sequelize');

const sequelize = new Sequelize(
  process.env.DB_NAME || 'salon_booking',
  process.env.DB_USER || 'root',
  process.env.DB_PASSWORD || '',
  {
    dialect: 'mysql',
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 3306),
    logging: false,
    pool: { max: 10, min: 0, acquire: 30000, idle: 10000 },
    dialectOptions: { dateStrings: true, typeCast: true },
  },
);

const modelOptions = (tableName, extra = {}) => ({
  tableName,
  timestamps: false,
  freezeTableName: true,
  ...extra,
});

const User = sequelize.define('User', {
  id: { type: DataTypes.BIGINT.UNSIGNED, autoIncrement: true, primaryKey: true },
  name: { type: DataTypes.STRING(120), allowNull: false },
  email: { type: DataTypes.STRING(254), allowNull: false, unique: true },
  password_hash: { type: DataTypes.STRING(255), allowNull: false },
  phone: { type: DataTypes.STRING(32), allowNull: true },
  preferences: { type: DataTypes.JSON, allowNull: true },
  role: { type: DataTypes.ENUM('customer', 'staff', 'admin'), allowNull: false, defaultValue: 'customer' },
  created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
}, modelOptions('users'));

const Service = sequelize.define('Service', {
  id: { type: DataTypes.BIGINT.UNSIGNED, autoIncrement: true, primaryKey: true },
  name: { type: DataTypes.STRING(120), allowNull: false },
  description: { type: DataTypes.TEXT, allowNull: true },
  duration_minutes: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false },
  price: { type: DataTypes.DECIMAL(10, 2), allowNull: false },
  active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
}, modelOptions('services'));

const Staff = sequelize.define('Staff', {
  id: { type: DataTypes.BIGINT.UNSIGNED, autoIncrement: true, primaryKey: true },
  user_id: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true, unique: true },
  name: { type: DataTypes.STRING(120), allowNull: false },
  bio: { type: DataTypes.TEXT, allowNull: true },
  specializations: { type: DataTypes.JSON, allowNull: true },
  active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
}, modelOptions('staff'));

const StaffService = sequelize.define('StaffService', {
  staff_id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true },
  service_id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true },
}, modelOptions('staff_services'));

const StaffAvailability = sequelize.define('StaffAvailability', {
  id: { type: DataTypes.BIGINT.UNSIGNED, autoIncrement: true, primaryKey: true },
  staff_id: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
  weekday: { type: DataTypes.TINYINT.UNSIGNED, allowNull: false },
  start_time: { type: DataTypes.TIME, allowNull: false },
  end_time: { type: DataTypes.TIME, allowNull: false },
  is_available: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
}, modelOptions('staff_availability', {
  indexes: [{ unique: true, fields: ['staff_id', 'weekday', 'start_time'], name: 'uq_staff_weekday_start' }],
}));

const Appointment = sequelize.define('Appointment', {
  id: { type: DataTypes.BIGINT.UNSIGNED, autoIncrement: true, primaryKey: true },
  customer_id: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
  staff_id: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
  service_id: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
  appointment_date: { type: DataTypes.DATEONLY, allowNull: false },
  start_time: { type: DataTypes.TIME, allowNull: false },
  end_time: { type: DataTypes.TIME, allowNull: false },
  status: { type: DataTypes.ENUM('confirmed', 'cancelled', 'completed'), allowNull: false, defaultValue: 'confirmed' },
  notes: { type: DataTypes.TEXT, allowNull: true },
  reminder_sent_at: { type: DataTypes.DATE, allowNull: true },
  created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
}, modelOptions('appointments', {
  indexes: [
    { fields: ['staff_id', 'appointment_date', 'status', 'start_time', 'end_time'], name: 'idx_appointment_schedule' },
    { fields: ['customer_id', 'appointment_date'], name: 'idx_appointment_customer' },
  ],
}));

const Payment = sequelize.define('Payment', {
  id: { type: DataTypes.BIGINT.UNSIGNED, autoIncrement: true, primaryKey: true },
  appointment_id: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false, unique: true },
  provider: { type: DataTypes.STRING(32), allowNull: false },
  provider_session_id: { type: DataTypes.STRING(255), allowNull: true },
  amount: { type: DataTypes.DECIMAL(10, 2), allowNull: false },
  status: { type: DataTypes.ENUM('pending', 'paid', 'failed'), allowNull: false, defaultValue: 'pending' },
  created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
}, modelOptions('payments'));

const Invoice = sequelize.define('Invoice', {
  id: { type: DataTypes.BIGINT.UNSIGNED, autoIncrement: true, primaryKey: true },
  appointment_id: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false, unique: true },
  invoice_number: { type: DataTypes.STRING(40), allowNull: false, unique: true },
  amount: { type: DataTypes.DECIMAL(10, 2), allowNull: false },
  issued_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
}, modelOptions('invoices'));

const Review = sequelize.define('Review', {
  id: { type: DataTypes.BIGINT.UNSIGNED, autoIncrement: true, primaryKey: true },
  appointment_id: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false, unique: true },
  customer_id: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
  staff_id: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
  rating: { type: DataTypes.TINYINT.UNSIGNED, allowNull: false },
  comment: { type: DataTypes.TEXT, allowNull: true },
  staff_response: { type: DataTypes.TEXT, allowNull: true },
  created_at: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
}, modelOptions('reviews'));

User.hasOne(Staff, { as: 'staffProfile', foreignKey: 'user_id' });
Staff.belongsTo(User, { as: 'user', foreignKey: 'user_id' });
Staff.belongsToMany(Service, { as: 'services', through: StaffService, foreignKey: 'staff_id', otherKey: 'service_id', timestamps: false });
Service.belongsToMany(Staff, { as: 'staff', through: StaffService, foreignKey: 'service_id', otherKey: 'staff_id', timestamps: false });
Staff.hasMany(StaffAvailability, { as: 'availability', foreignKey: 'staff_id' });
StaffAvailability.belongsTo(Staff, { as: 'staff', foreignKey: 'staff_id' });
User.hasMany(Appointment, { as: 'appointments', foreignKey: 'customer_id' });
Staff.hasMany(Appointment, { as: 'appointments', foreignKey: 'staff_id' });
Service.hasMany(Appointment, { as: 'appointments', foreignKey: 'service_id' });
Appointment.belongsTo(User, { as: 'customer', foreignKey: 'customer_id' });
Appointment.belongsTo(Staff, { as: 'staff', foreignKey: 'staff_id' });
Appointment.belongsTo(Service, { as: 'service', foreignKey: 'service_id' });
Appointment.hasOne(Payment, { as: 'payment', foreignKey: 'appointment_id' });
Appointment.hasOne(Invoice, { as: 'invoice', foreignKey: 'appointment_id' });
Appointment.hasOne(Review, { as: 'review', foreignKey: 'appointment_id' });
Payment.belongsTo(Appointment, { as: 'appointment', foreignKey: 'appointment_id' });
Invoice.belongsTo(Appointment, { as: 'appointment', foreignKey: 'appointment_id' });
Review.belongsTo(Appointment, { as: 'appointment', foreignKey: 'appointment_id' });
Review.belongsTo(User, { as: 'customer', foreignKey: 'customer_id' });
Review.belongsTo(Staff, { as: 'staff', foreignKey: 'staff_id' });
Staff.hasMany(Review, { as: 'reviews', foreignKey: 'staff_id' });

async function initializeSchema() {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('JWT_SECRET must be set to a random secret of at least 32 characters.');
  }
  await sequelize.authenticate();
  await sequelize.sync();
}

module.exports = {
  sequelize,
  initializeSchema,
  User,
  Service,
  Staff,
  StaffService,
  StaffAvailability,
  Appointment,
  Payment,
  Invoice,
  Review,
};
