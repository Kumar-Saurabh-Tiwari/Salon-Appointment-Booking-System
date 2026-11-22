# Salon appointment booking

An Express + Sequelize + MySQL booking API with a React + Bootstrap 5 client for browsing services, booking appointments, and managing salon data.

## Run locally

Requirements: Node.js 20+, MySQL 8+, and npm.

1. Create a MySQL database (the schema is created by the API on startup):

   ```sql
   CREATE DATABASE salon_booking CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
   ```

2. Copy `backend/.env.example` to `backend/.env`, set the database connection, and replace `JWT_SECRET` with a random value of at least 32 characters. To enable email confirmations and reminders, configure `SMTP_HOST`, port/security, and credentials. Set `SMTP_FROM` to a verified sender address; if it is blank, an email-formatted `SMTP_USER` is used as the sender. For Cashfree sandbox checkout, set `CASHFREE_CLIENT_ID` and `CASHFREE_CLIENT_SECRET` from the Cashfree sandbox portal; the checkout uses INR by default. Keep these credentials only in the backend `.env`, then restart the API after changing configuration. Stripe remains an optional fallback when Cashfree is not configured.
3. Set up dependencies, create the initial admin, and optionally seed a demo catalog:

   ```powershell
   cd backend
   npm install
   npm run seed:admin
   npm run seed:demo
   npm start
   ```

   Admin credentials come from `ADMIN_EMAIL` and `ADMIN_PASSWORD` in `backend/.env`. Registration always creates a customer account; it cannot grant administrator access.
4. In another terminal:

   ```powershell
   cd frontend/salon-booking
   npm install
   npm run dev
   ```

   Open the Vite URL (normally `http://localhost:5173`). The frontend calls `http://localhost:4000` by default; set `VITE_API_URL` before starting Vite to use another API URL.

The API defines its Sequelize models and associations in `backend/database/schema.js` and synchronizes missing tables on startup without altering existing columns. Add services and staff in the admin view, assign services to staff, and set each staff member's weekly working hours before making customer bookings.

To populate an empty local database with example treatments, a sample stylist, and weekly availability, run `npm run seed:demo` from `backend`. The command only adds demo data when both the services and staff tables are empty; it will not overwrite an existing catalog.

## API

All routes are prefixed with `/api`. The interactive frontend is a demo client; the full API contract is available as [OpenAPI](./backend/openapi.yaml).

### Authentication and profiles

| Method | Path | Access | Purpose |
|---|---|---|---|
| POST | `/auth/register` | Public | Create customer (`name`, `email`, `password`, optional `phone`); returns JWT and user |
| POST | `/auth/login` | Public | Authenticate with `email` and `password`; returns JWT and user |
| GET | `/profile` | Signed in | Read current profile |
| PATCH | `/profile` | Signed in | Update `name`, `phone`, or `preferences` |

Send `Authorization: Bearer <token>` on protected routes. Passwords are hashed, access tokens expire after `JWT_EXPIRES_IN` (12h by default), and the signing secret is required at startup. Registration and login share a per-IP limit of 10 attempts per 15 minutes.

### Services, staff, and availability

| Method | Path | Access | Purpose |
|---|---|---|---|
| GET | `/services` | Public | List active services |
| POST | `/services` | Admin | Create a service (`name`, `durationMinutes`, `price`, optional `description`) |
| PATCH | `/services/:id` | Admin | Update service fields or set `active: false` |
| DELETE | `/services/:id` | Admin | Deactivate service |
| GET | `/staff` | Public | List active staff and assigned services |
| POST | `/staff` | Admin | Create staff (`name`, optional `bio`, `specializations`, `userId`) |
| PATCH | `/staff/:id` | Admin | Update staff details |
| DELETE | `/staff/:id` | Admin | Deactivate staff |
| PUT/DELETE | `/staff/:id/services/:serviceId` | Admin | Assign/remove a service |
| PUT | `/staff/:id/availability` | Admin | Upsert weekly hours (`weekday` 0–6, `startTime`, `endTime`, optional `isAvailable`) |
| GET | `/availability?serviceId=1&date=YYYY-MM-DD&staffId=1` | Public | Return available 15-minute-start slots fitting service duration |

### Appointments, payment, and reviews

| Method | Path | Access | Purpose |
|---|---|---|---|
| POST | `/appointments` | Signed in | Book (`serviceId`, `staffId`, `date`, `startTime`, optional `notes`) |
| GET | `/appointments` | Signed in | List own bookings; admins/staff can list all; optional `status` filter |
| GET | `/appointments/:id` | Owner or admin/staff | Read appointment details |
| PATCH | `/appointments/:id/reschedule` | Owner or admin/staff | Reschedule using `date` and `startTime` |
| PATCH | `/appointments/:id/cancel` | Owner or admin/staff | Cancel; customer policy defaults to 24h notice |
| PATCH | `/appointments/:id/status` | Admin | Set `confirmed`, `cancelled`, or `completed` |
| GET | `/payments/config` | Public | Return the active payment provider and currency |
| POST | `/appointments/:id/checkout` | Owner or admin/staff | Create a Cashfree sandbox payment session (or Stripe Checkout fallback) |
| GET | `/appointments/:id/payment` | Owner or admin/staff | Refresh and read the verified payment status |
| POST | `/payments/cashfree/webhook` | Cashfree signature | Verify Cashfree webhook and synchronize the order status |
| POST | `/payments/webhook` | Stripe signature | Mark a Stripe payment paid after verified Checkout completion |
| GET | `/appointments/:id/invoice` | Owner or admin/staff | Generate/read invoice for a completed appointment |
| POST | `/appointments/:id/reviews` | Appointment owner | Review a completed appointment (`rating` 1–5, optional `comment`) |
| GET | `/reviews?staffId=1` | Public | List reviews, optionally filtered by staff |
| PATCH | `/reviews/:id/response` | Admin or linked staff | Add a staff response (`response`) |

Bookings are checked against staff skills, working hours, and overlapping reservations in a transaction. A slot is held as `pending_payment` while checkout is open. Confirmed status and the confirmation email are created only after the backend verifies successful Cashfree or Stripe payment. Customers can retry payment from My appointments if checkout is closed or interrupted. Booking is unavailable until an online payment provider is configured. A 15-minute cron job checks for appointments in the next 24 hours and sends one reminder. SMTP failures are logged and do not roll back a booking.

### Admin

| Method | Path | Access | Purpose |
|---|---|---|---|
| GET | `/admin/users` | Admin | List users |
| PATCH | `/admin/users/:id` | Admin | Update a user's `name` or `role` |
| GET | `/admin/dashboard` | Admin | Return entity totals, today's bookings, and the next 10 upcoming appointments |

Responses are JSON. Error responses use `{ "error": "..." }`; common status codes are 400 (invalid input), 401 (missing/invalid token), 403 (not allowed), 404 (not found), 409 (booking conflict/policy), 429 (auth rate limit), and 503 (optional integration not configured).

## Notes

- The salon schedule and appointment timestamps use `SALON_TIMEZONE`; configure the MySQL server timezone consistently. The default is UTC.
- Cashfree sandbox uses `https://sandbox.cashfree.com/pg` and the Cashfree JavaScript checkout SDK. Cashfree credentials stay on the backend. The browser return checks order status server-to-server; for webhook delivery, configure `CASHFREE_NOTIFY_URL` to the public `/api/payments/cashfree/webhook` endpoint. Stripe Checkout remains available as a fallback and requires `STRIPE_WEBHOOK_SECRET`.
- Cashfree checkout requires a valid 10-digit phone number on the customer profile. Service price values are interpreted as INR for Cashfree; no currency conversion is applied to existing prices.
- SMS delivery is not enabled; configure an SMS provider separately if required.
- Do not use demo credentials or secrets in production. Deploy behind HTTPS and configure database backups and operational monitoring.
