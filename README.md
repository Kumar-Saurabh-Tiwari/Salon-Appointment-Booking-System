# Salon appointment booking

An Express + MySQL booking API with a small React + Bootstrap 5 client for browsing services, booking appointments, and managing salon data.

## Run locally

Requirements: Node.js 20+, MySQL 8+, and npm.

1. Create a MySQL database (the schema is created by the API on startup):

   ```sql
   CREATE DATABASE salon_booking CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
   ```

2. Copy `backend/.env.example` to `backend/.env`, set the database connection, and replace `JWT_SECRET` with a random value of at least 32 characters. To enable email confirmations and reminders, configure SMTP. To enable online checkout, set Stripe credentials and webhook secret. These integrations are optional for local booking.
3. Set up dependencies and create the initial admin:

   ```powershell
   cd backend
   npm install
   npm run seed:admin
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

The API creates the required tables on startup. Add services and staff in the admin view, assign services to staff, and set each staff member's weekly working hours before making customer bookings.

To populate an empty local database with example treatments, a sample stylist, and weekly availability, run `npm run seed:demo` from `backend`. The command only adds demo data when both the services and staff tables are empty; it will not overwrite an existing catalog.

## API

All routes are prefixed with `/api`. The interactive frontend is a demo client; the API contract is also available as [OpenAPI](./backend/openapi.yaml).

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
| POST | `/appointments/:id/checkout` | Owner or admin/staff | Create a Stripe Checkout session; returns `checkoutUrl` |
| POST | `/payments/webhook` | Stripe signature | Mark a payment paid after verified Checkout completion |
| GET | `/appointments/:id/invoice` | Owner or admin/staff | Generate/read invoice for a completed appointment |
| POST | `/appointments/:id/reviews` | Appointment owner | Review a completed appointment (`rating` 1–5, optional `comment`) |
| GET | `/reviews?staffId=1` | Public | List reviews, optionally filtered by staff |
| PATCH | `/reviews/:id/response` | Admin or linked staff | Add a staff response (`response`) |

Bookings are checked against staff skills, working hours, and overlapping reservations in a transaction. The confirmation email is sent after booking when SMTP is configured. A 15-minute cron job checks for appointments in the next 24 hours and sends one reminder. SMTP failures are logged and do not roll back a booking.

### Admin

| Method | Path | Access | Purpose |
|---|---|---|---|
| GET | `/admin/users` | Admin | List users |
| PATCH | `/admin/users/:id` | Admin | Update a user's `name` or `role` |

Responses are JSON. Error responses use `{ "error": "..." }`; common status codes are 400 (invalid input), 401 (missing/invalid token), 403 (not allowed), 404 (not found), 409 (booking conflict/policy), 429 (auth rate limit), and 503 (optional integration not configured).

## Notes

- The salon schedule and appointment timestamps use `SALON_TIMEZONE`; configure the MySQL server timezone consistently. The default is UTC.
- Stripe Checkout requires a valid Stripe webhook endpoint at `/api/payments/webhook`; set `STRIPE_WEBHOOK_SECRET` from Stripe CLI/dashboard.
- SMS delivery is not enabled; configure an SMS provider separately if required.
- Do not use demo credentials or secrets in production. Deploy behind HTTPS and configure database backups and operational monitoring.
