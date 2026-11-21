import { useCallback, useEffect, useMemo, useState } from 'react'
import './App.css'

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:4000/api'
const today = new Date().toLocaleDateString('en-CA')
const tomorrow = new Date(Date.now() + 86400000).toLocaleDateString('en-CA')

async function api(path, { token, ...options } = {}) {
  const response = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  })
  if (response.status === 204) return null
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload.error || 'The request could not be completed.')
  return payload
}

function App() {
  const [token, setToken] = useState(() => localStorage.getItem('salon-token') || '')
  const [user, setUser] = useState(() => {
    try { return JSON.parse(localStorage.getItem('salon-user') || 'null') } catch { return null }
  })
  const [tab, setTab] = useState('book')
  const [services, setServices] = useState([])
  const [staff, setStaff] = useState([])
  const [slots, setSlots] = useState([])
  const [appointments, setAppointments] = useState([])
  const [users, setUsers] = useState([])
  const [reviews, setReviews] = useState([])
  const [serviceId, setServiceId] = useState('')
  const [staffId, setStaffId] = useState('')
  const [date, setDate] = useState(tomorrow)
  const [selectedSlot, setSelectedSlot] = useState(null)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [authMode, setAuthMode] = useState('login')
  const [auth, setAuth] = useState({ name: '', email: '', password: '', phone: '' })
  const [profile, setProfile] = useState({ name: '', phone: '' })
  const [serviceForm, setServiceForm] = useState({ name: '', description: '', durationMinutes: 45, price: '' })
  const [staffForm, setStaffForm] = useState({ name: '', bio: '', specializations: '' })
  const [scheduleForm, setScheduleForm] = useState({ staffId: '', weekday: 1, startTime: '09:00', endTime: '17:00' })

  const activeService = useMemo(() => services.find((service) => String(service.id) === String(serviceId)), [services, serviceId])

  const loadCatalog = useCallback(async () => {
    try {
      const [serviceList, staffList, reviewList] = await Promise.all([
        api('/services'), api('/staff'), api('/reviews'),
      ])
      setServices(serviceList)
      setStaff(staffList)
      setReviews(reviewList)
      setServiceId((current) => current || String(serviceList[0]?.id || ''))
    } catch (requestError) {
      setError(requestError.message)
    }
  }, [])

  const loadAppointments = useCallback(async (currentToken = token) => {
    if (!currentToken) return
    try {
      setAppointments(await api('/appointments', { token: currentToken }))
    } catch (requestError) {
      setError(requestError.message)
    }
  }, [token])

  useEffect(() => { loadCatalog() }, [loadCatalog])

  useEffect(() => {
    if (!token) return
    api('/profile', { token }).then((data) => {
      setUser(data)
      setProfile({ name: data.name || '', phone: data.phone || '' })
      localStorage.setItem('salon-user', JSON.stringify(data))
      loadAppointments(token)
    }).catch(() => {
      setToken('')
      setUser(null)
      localStorage.removeItem('salon-token')
      localStorage.removeItem('salon-user')
    })
  }, [token, loadAppointments])

  useEffect(() => {
    if (!serviceId || !date) return
    setSelectedSlot(null)
    api(`/availability?serviceId=${serviceId}&date=${date}${staffId ? `&staffId=${staffId}` : ''}`)
      .then(setSlots)
      .catch((requestError) => setError(requestError.message))
  }, [serviceId, staffId, date])

  function showError(text) {
    setError(text)
    setMessage('')
  }

  function showMessage(text) {
    setMessage(text)
    setError('')
  }

  async function submitAuth(event) {
    event.preventDefault()
    setLoading(true)
    try {
      const path = authMode === 'login' ? '/auth/login' : '/auth/register'
      const result = await api(path, { method: 'POST', body: JSON.stringify(auth) })
      localStorage.setItem('salon-token', result.token)
      localStorage.setItem('salon-user', JSON.stringify(result.user))
      setUser(result.user)
      setToken(result.token)
      setProfile({ name: result.user.name || '', phone: result.user.phone || '' })
      setAuth({ name: '', email: '', password: '', phone: '' })
      showMessage(`Welcome${result.user.name ? `, ${result.user.name}` : ''}.`)
    } catch (requestError) {
      showError(requestError.message)
    } finally {
      setLoading(false)
    }
  }

  function signOut() {
    localStorage.removeItem('salon-token')
    localStorage.removeItem('salon-user')
    setToken('')
    setUser(null)
    setAppointments([])
    setTab('book')
    showMessage('You have been signed out.')
  }

  async function bookAppointment(event) {
    event.preventDefault()
    if (!selectedSlot) return showError('Choose an available appointment time.')
    setLoading(true)
    try {
      const result = await api('/appointments', {
        token, method: 'POST',
        body: JSON.stringify({ serviceId: Number(serviceId), staffId: selectedSlot.staffId, date, startTime: selectedSlot.startTime }),
      })
      showMessage(`Booking confirmed for ${date} at ${selectedSlot.startTime}.`)
      setSelectedSlot(null)
      await loadAppointments()
      setTab('appointments')
      return result
    } catch (requestError) {
      showError(requestError.message)
    } finally {
      setLoading(false)
    }
  }

  async function cancelAppointment(id) {
    try {
      await api(`/appointments/${id}/cancel`, { token, method: 'PATCH' })
      showMessage('Appointment cancelled.')
      await loadAppointments()
    } catch (requestError) {
      showError(requestError.message)
    }
  }

  async function completeAppointment(id) {
    try {
      await api(`/appointments/${id}/status`, { token, method: 'PATCH', body: JSON.stringify({ status: 'completed' }) })
      showMessage('Appointment marked as completed.')
      await loadAppointments()
    } catch (requestError) {
      showError(requestError.message)
    }
  }

  async function saveProfile(event) {
    event.preventDefault()
    try {
      const updated = await api('/profile', { token, method: 'PATCH', body: JSON.stringify(profile) })
      setUser(updated)
      localStorage.setItem('salon-user', JSON.stringify(updated))
      showMessage('Profile updated.')
    } catch (requestError) {
      showError(requestError.message)
    }
  }

  async function createService(event) {
    event.preventDefault()
    try {
      await api('/services', { token, method: 'POST', body: JSON.stringify({ ...serviceForm, durationMinutes: Number(serviceForm.durationMinutes), price: Number(serviceForm.price) }) })
      setServiceForm({ name: '', description: '', durationMinutes: 45, price: '' })
      await loadCatalog()
      showMessage('Service added.')
    } catch (requestError) {
      showError(requestError.message)
    }
  }

  async function createStaff(event) {
    event.preventDefault()
    try {
      await api('/staff', {
        token, method: 'POST',
        body: JSON.stringify({ ...staffForm, specializations: staffForm.specializations.split(',').map((item) => item.trim()).filter(Boolean) }),
      })
      setStaffForm({ name: '', bio: '', specializations: '' })
      await loadCatalog()
      showMessage('Staff profile added.')
    } catch (requestError) {
      showError(requestError.message)
    }
  }

  async function assignService(staffMemberId, assignedServiceId) {
    try {
      await api(`/staff/${staffMemberId}/services/${assignedServiceId}`, { token, method: 'PUT' })
      await loadCatalog()
      showMessage('Service assigned to staff.')
    } catch (requestError) {
      showError(requestError.message)
    }
  }

  async function saveAvailability(event) {
    event.preventDefault()
    try {
      await api(`/staff/${scheduleForm.staffId}/availability`, {
        token, method: 'PUT',
        body: JSON.stringify({ weekday: Number(scheduleForm.weekday), startTime: scheduleForm.startTime, endTime: scheduleForm.endTime }),
      })
      showMessage('Weekly hours saved.')
    } catch (requestError) {
      showError(requestError.message)
    }
  }

  async function loadUsers() {
    try { setUsers(await api('/admin/users', { token })) } catch (requestError) { showError(requestError.message) }
  }

  async function updateRole(id, role) {
    try {
      await api(`/admin/users/${id}`, { token, method: 'PATCH', body: JSON.stringify({ role }) })
      await loadUsers()
      showMessage('User role updated.')
    } catch (requestError) { showError(requestError.message) }
  }

  async function checkout(id) {
    try {
      const result = await api(`/appointments/${id}/checkout`, { token, method: 'POST' })
      window.location.assign(result.checkoutUrl)
    } catch (requestError) { showError(requestError.message) }
  }

  async function review(id) {
    const rating = Number(window.prompt('Rate your appointment from 1 to 5'))
    if (!rating) return
    const comment = window.prompt('Share a comment (optional)') || ''
    try {
      await api(`/appointments/${id}/reviews`, { token, method: 'POST', body: JSON.stringify({ rating, comment }) })
      await loadCatalog()
      showMessage('Thanks for your feedback.')
    } catch (requestError) { showError(requestError.message) }
  }

  function changeTab(nextTab) {
    setTab(nextTab)
    setMessage('')
    setError('')
    if (nextTab === 'appointments') loadAppointments()
    if (nextTab === 'admin' && user?.role === 'admin') loadUsers()
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="#" onClick={() => changeTab('book')} aria-label="Maison home">
          <span className="brand-mark">m</span>
          <span>maison<span className="brand-period">.</span></span>
        </a>
        <nav className="main-nav" aria-label="Main navigation">
          <button className={tab === 'book' ? 'nav-link active' : 'nav-link'} onClick={() => changeTab('book')}>Book an appointment</button>
          {user && <button className={tab === 'appointments' ? 'nav-link active' : 'nav-link'} onClick={() => changeTab('appointments')}>My appointments</button>}
          {user?.role === 'admin' && <button className={tab === 'admin' ? 'nav-link active' : 'nav-link'} onClick={() => changeTab('admin')}>Salon dashboard</button>}
        </nav>
        <div className="account-area">
          {user ? <><span className="welcome-name">Hi, {user.name.split(' ')[0]}</span><button className="button button-outline small" onClick={signOut}>Sign out</button></>
            : <button className="button button-dark small" onClick={() => document.getElementById('account')?.scrollIntoView({ behavior: 'smooth' })}>Sign in</button>}
        </div>
      </header>

      <main>
        <section className="hero">
          <div className="hero-copy">
            <p className="eyebrow">YOUR MOMENT, WELL SPENT</p>
            <h1>A little time<br />for <em>yourself.</em></h1>
            <p className="hero-description">Thoughtful hair, skin and beauty rituals, made just for you.</p>
            <button className="button button-dark" onClick={() => document.getElementById('booking')?.scrollIntoView({ behavior: 'smooth' })}>Explore our services <span aria-hidden="true">↗</span></button>
          </div>
          <div className="hero-art" role="img" aria-label="Warm, sunlit salon interior">
            <div className="hero-art-sun" />
            <div className="hero-art-vase"><span /><i /><b /></div>
            <div className="hero-art-caption">A softer kind of self-care</div>
          </div>
          <div className="hero-footnote"><span>01 — 03</span><span>GOOD HAIR. GOOD SKIN. GOOD ENERGY.</span></div>
        </section>

        {error && <div className="notice error" role="alert">{error}<button onClick={() => setError('')} aria-label="Dismiss error">×</button></div>}
        {message && <div className="notice success" role="status">{message}<button onClick={() => setMessage('')} aria-label="Dismiss message">×</button></div>}

        <section className="booking-section section-wrap" id="booking">
          <div className="section-heading">
            <div><p className="eyebrow">THE MAISON EXPERIENCE</p><h2>Make time for <em>you.</em></h2></div>
            <p>Find your ritual and a time that works. We’ll take care of the rest.</p>
          </div>
          <div className="booking-layout">
            <div className="service-list">
              <div className="list-heading"><span>OUR SERVICES</span><span>{String(services.length).padStart(2, '0')} RITUALS</span></div>
              {services.length === 0 && <p className="empty-copy">Our service menu is being prepared. Please check back soon.</p>}
              {services.map((service, index) => (
                <button key={service.id} className={`service-row ${String(service.id) === String(serviceId) ? 'selected' : ''}`} onClick={() => setServiceId(String(service.id))}>
                  <span className="service-number">0{index + 1}</span>
                  <span className="service-main"><strong>{service.name}</strong><small>{service.description || `${service.duration_minutes} minutes of care`}</small></span>
                  <span className="service-meta">{service.duration_minutes} min<br /><b>${Number(service.price).toFixed(2)}</b></span>
                  <span className="row-arrow" aria-hidden="true">↗</span>
                </button>
              ))}
              <div className="booking-aside-note"><span>✳</span> A beautiful appointment begins with choosing what feels right.</div>
            </div>

            <div className="booking-card">
              <div className="booking-card-title"><span className="step-number">01</span><div><h3>Find your time</h3><p>Choose your day and stylist.</p></div></div>
              <form onSubmit={bookAppointment}>
                <label htmlFor="booking-date">Appointment date</label>
                <input id="booking-date" type="date" min={today} value={date} onChange={(event) => setDate(event.target.value)} />
                <label htmlFor="booking-staff">Your stylist</label>
                <select id="booking-staff" value={staffId} onChange={(event) => setStaffId(event.target.value)}>
                  <option value="">Anyone available</option>
                  {staff.filter((member) => !member.services?.length || member.services.some((service) => String(service.id) === String(serviceId))).map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}
                </select>
                <div className="slot-label"><label>Available times</label>{activeService && <span>{activeService.duration_minutes} min · ${Number(activeService.price).toFixed(2)}</span>}</div>
                <div className="slot-grid">
                  {slots.length ? slots.map((slot) => {
                    const selected = selectedSlot?.staffId === slot.staffId && selectedSlot?.startTime === slot.startTime
                    return <button type="button" className={`time-slot ${selected ? 'chosen' : ''}`} key={`${slot.staffId}-${slot.startTime}`} onClick={() => setSelectedSlot(slot)} title={`${slot.staffName} · ${slot.startTime}`}>{slot.startTime}</button>
                  }) : <p className="empty-copy slots-empty">{serviceId ? 'No times available for this day. Try another date.' : 'Select a service to find a time.'}</p>}
                </div>
                <button className="button button-dark book-button" type="submit" disabled={!selectedSlot || loading || !user}>
                  {loading ? 'Booking…' : !user ? 'Sign in to book' : 'Confirm appointment'} <span aria-hidden="true">↗</span>
                </button>
                {!user && <p className="form-hint">Your appointment is just a sign-in away.</p>}
              </form>
            </div>
          </div>
        </section>

        <section className="promise-band">
          <div className="promise-star">✳</div><p>Little rituals. <em>Lasting</em> confidence.</p><span>MADE WITH CARE, ALWAYS</span>
        </section>

        <section className="reviews-section section-wrap">
          <div className="section-heading"><div><p className="eyebrow">KIND WORDS</p><h2>A little love, <em>shared.</em></h2></div><p>Our favourite part is hearing how you felt when you left.</p></div>
          <div className="review-grid">
            {reviews.slice(0, 3).map((review) => <article className="review-card" key={review.id}><div className="stars">{'★'.repeat(review.rating)}{'☆'.repeat(5 - review.rating)}</div><p>“{review.comment || 'A wonderful experience from start to finish.'}”</p><span>{review.staff_name} · MAISON CLIENT</span>{review.staff_response && <small className="review-response">Maison: {review.staff_response}</small>}</article>)}
            {!reviews.length && <p className="empty-copy">Your kind words will feel at home here.</p>}
          </div>
        </section>

        {!user && <section className="account-section section-wrap" id="account">
          <div><p className="eyebrow">YOUR MAISON ACCOUNT</p><h2>Make it <em>personal.</em></h2><p>Sign in to manage your visits, or create an account to book your first ritual.</p></div>
          <form className="account-form" onSubmit={submitAuth}>
            <div className="auth-toggle"><button type="button" className={authMode === 'login' ? 'active' : ''} onClick={() => setAuthMode('login')}>Sign in</button><button type="button" className={authMode === 'register' ? 'active' : ''} onClick={() => setAuthMode('register')}>Create account</button></div>
            {authMode === 'register' && <input required placeholder="Your name" value={auth.name} onChange={(event) => setAuth({ ...auth, name: event.target.value })} />}
            <input required type="email" placeholder="Email address" value={auth.email} onChange={(event) => setAuth({ ...auth, email: event.target.value })} />
            {authMode === 'register' && <input type="tel" placeholder="Phone (optional)" value={auth.phone} onChange={(event) => setAuth({ ...auth, phone: event.target.value })} />}
            <input required type="password" minLength="8" placeholder="Password (8+ characters)" value={auth.password} onChange={(event) => setAuth({ ...auth, password: event.target.value })} />
            <button className="button button-dark full-width" type="submit" disabled={loading}>{loading ? 'Please wait…' : authMode === 'login' ? 'Sign in' : 'Create my account'} <span aria-hidden="true">↗</span></button>
          </form>
        </section>}

        {user && tab === 'appointments' && <section className="dashboard-section section-wrap">
          <div className="section-heading"><div><p className="eyebrow">YOUR VISITS</p><h2>Appointments, <em>your way.</em></h2></div><button className="button button-outline" onClick={() => changeTab('book')}>Book another visit ↗</button></div>
          {appointments.length ? <div className="appointment-list">{appointments.map((appointment) => <article className="appointment-card" key={appointment.id}>
            <div className="appointment-date"><span>{new Date(`${appointment.appointment_date}T12:00:00`).toLocaleDateString('en-US', { month: 'short' }).toUpperCase()}</span><strong>{new Date(`${appointment.appointment_date}T12:00:00`).getDate()}</strong></div>
            <div className="appointment-info"><h3>{appointment.service_name}</h3><p>{appointment.staff_name} · {appointment.start_time.slice(0, 5)} · {appointment.duration_minutes} min</p></div>
            <span className={`status-pill ${appointment.status}`}>{appointment.status}</span>
            <div className="appointment-actions">
              {appointment.status === 'confirmed' && <button onClick={() => checkout(appointment.id)}>Pay online</button>}
              {appointment.status === 'confirmed' && <button className="muted-action" onClick={() => cancelAppointment(appointment.id)}>Cancel</button>}
              {appointment.status === 'completed' && <button onClick={() => review(appointment.id)}>Leave a review</button>}
              {appointment.status === 'completed' && <a href={`${API_URL}/appointments/${appointment.id}/invoice`} onClick={(event) => { event.preventDefault(); api(`/appointments/${appointment.id}/invoice`, { token }).then((invoice) => showMessage(`Invoice ${invoice.invoice_number} · $${Number(invoice.amount).toFixed(2)}`)).catch((requestError) => showError(requestError.message)) }}>Invoice</a>}
            </div>
          </article>)}</div> : <div className="empty-panel"><span>✳</span><h3>Your next little ritual awaits.</h3><p>When you book a visit, you’ll find it here.</p><button className="button button-dark" onClick={() => changeTab('book')}>Explore services ↗</button></div>}
          <form className="profile-form" onSubmit={saveProfile}><div><p className="eyebrow">PROFILE DETAILS</p><h3>Your details</h3></div><input aria-label="Name" value={profile.name} onChange={(event) => setProfile({ ...profile, name: event.target.value })} /><input aria-label="Phone" value={profile.phone} placeholder="Phone" onChange={(event) => setProfile({ ...profile, phone: event.target.value })} /><button className="button button-outline" type="submit">Save profile</button></form>
        </section>}

        {user?.role === 'admin' && tab === 'admin' && <section className="dashboard-section section-wrap">
          <div className="section-heading"><div><p className="eyebrow">THE SALON, AT A GLANCE</p><h2>Maison <em>dashboard.</em></h2></div><span className="admin-badge">ADMIN VIEW</span></div>
          <div className="stat-grid"><div><span>UPCOMING & PAST</span><strong>{appointments.length}</strong><small>appointments in the system</small></div><div><span>OUR SERVICES</span><strong>{services.length}</strong><small>services available to book</small></div><div><span>OUR PEOPLE</span><strong>{staff.length}</strong><small>active stylists</small></div><div><span>REVIEWS</span><strong>{reviews.length}</strong><small>client experiences shared</small></div></div>
          <div className="admin-columns">
            <div className="admin-panel"><div className="panel-title"><div><p className="eyebrow">SERVICE MENU</p><h3>Add a service</h3></div></div><form className="stack-form" onSubmit={createService}><input required placeholder="Service name" value={serviceForm.name} onChange={(event) => setServiceForm({ ...serviceForm, name: event.target.value })} /><input placeholder="Description" value={serviceForm.description} onChange={(event) => setServiceForm({ ...serviceForm, description: event.target.value })} /><div className="form-row"><label>Minutes<input required type="number" min="5" value={serviceForm.durationMinutes} onChange={(event) => setServiceForm({ ...serviceForm, durationMinutes: event.target.value })} /></label><label>Price<input required type="number" min="0" step="0.01" value={serviceForm.price} onChange={(event) => setServiceForm({ ...serviceForm, price: event.target.value })} /></label></div><button className="button button-dark">Add service +</button></form>
              <div className="admin-service-list">{services.map((service) => <div key={service.id}><span>{service.name}</span><b>${Number(service.price).toFixed(2)}</b></div>)}</div>
            </div>
            <div className="admin-panel"><div className="panel-title"><div><p className="eyebrow">OUR PEOPLE</p><h3>Stylist profiles</h3></div></div><form className="stack-form" onSubmit={createStaff}><input required placeholder="Stylist name" value={staffForm.name} onChange={(event) => setStaffForm({ ...staffForm, name: event.target.value })} /><input placeholder="Short bio" value={staffForm.bio} onChange={(event) => setStaffForm({ ...staffForm, bio: event.target.value })} /><input placeholder="Specializations, comma separated" value={staffForm.specializations} onChange={(event) => setStaffForm({ ...staffForm, specializations: event.target.value })} /><button className="button button-dark">Add stylist +</button></form>
              <div className="admin-service-list">{staff.map((member) => <div key={member.id}><span>{member.name}</span><select aria-label={`Assign service to ${member.name}`} defaultValue="" onChange={(event) => event.target.value && assignService(member.id, event.target.value)}><option value="" disabled>Assign service +</option>{services.map((service) => <option key={service.id} value={service.id}>{service.name}</option>)}</select></div>)}</div>
              {staff.length > 0 && <form className="schedule-form" onSubmit={saveAvailability}><h4>Set weekly working hours</h4><select required value={scheduleForm.staffId} onChange={(event) => setScheduleForm({ ...scheduleForm, staffId: event.target.value })}><option value="">Choose stylist</option>{staff.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}</select><div className="form-row"><select value={scheduleForm.weekday} onChange={(event) => setScheduleForm({ ...scheduleForm, weekday: event.target.value })}>{['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((day, index) => <option key={day} value={index}>{day}</option>)}</select><input type="time" value={scheduleForm.startTime} onChange={(event) => setScheduleForm({ ...scheduleForm, startTime: event.target.value })} /><input type="time" value={scheduleForm.endTime} onChange={(event) => setScheduleForm({ ...scheduleForm, endTime: event.target.value })} /></div><button className="button button-outline">Save working hours</button></form>}
            </div>
          </div>
          <div className="admin-panel full-panel"><div className="panel-title"><div><p className="eyebrow">TODAY, TOMORROW, AND WHAT'S NEXT</p><h3>Appointment management</h3></div><button className="button button-outline small" onClick={() => loadAppointments()}>Refresh</button></div>
            {appointments.map((appointment) => <div className="admin-appointment" key={appointment.id}><div><strong>{appointment.customer_name}</strong><span>{appointment.service_name} · {appointment.staff_name}</span></div><span>{appointment.appointment_date} · {appointment.start_time.slice(0, 5)}</span><span className={`status-pill ${appointment.status}`}>{appointment.status}</span>{appointment.status === 'confirmed' && <button className="text-button" onClick={() => completeAppointment(appointment.id)}>Mark completed</button>}</div>)}
            {!appointments.length && <p className="empty-copy">No appointments yet.</p>}
          </div>
          <div className="admin-panel full-panel"><div className="panel-title"><div><p className="eyebrow">CLIENT RELATIONSHIPS</p><h3>Customer accounts</h3></div><button className="button button-outline small" onClick={loadUsers}>Refresh users</button></div>
            {users.map((customer) => <div className="admin-appointment" key={customer.id}><div><strong>{customer.name}</strong><span>{customer.email}</span></div><span>{customer.phone || 'No phone added'}</span><select value={customer.role} onChange={(event) => updateRole(customer.id, event.target.value)} aria-label={`Role for ${customer.name}`}><option value="customer">Customer</option><option value="staff">Staff</option><option value="admin">Admin</option></select></div>)}
            {!users.length && <p className="empty-copy">Load customer accounts to manage access.</p>}
          </div>
        </section>}
      </main>

      <footer className="footer"><a className="brand" href="#"><span className="brand-mark">m</span><span>maison<span className="brand-period">.</span></span></a><span>YOUR TIME, BEAUTIFULLY SPENT.</span><span>© {new Date().getFullYear()} MAISON SALON</span></footer>
    </div>
  )
}

export default App
