import { useCallback, useEffect, useMemo, useState } from 'react'
import './App.css'

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:4000/api'
function toLocalDateString(date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}
const today = toLocalDateString(new Date())
const tomorrow = toLocalDateString(new Date(Date.now() + 86400000))
const categoryOrder = ['Hair', 'Nails', 'Hair removal', 'Brows & lashes', 'Facials & skincare', 'Massage', 'Makeup', 'Medspa & aesthetics']
let cashfreeSdkPromise

function formatCurrency(value, currency) {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency }).format(Number(value) || 0)
}

function loadCashfreeSdk() {
  if (window.Cashfree) return Promise.resolve(window.Cashfree)
  if (!cashfreeSdkPromise) {
    cashfreeSdkPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script')
      script.src = 'https://sdk.cashfree.com/js/v3/cashfree.js'
      script.async = true
      script.onload = () => resolve(window.Cashfree)
      script.onerror = () => reject(new Error('Could not load Cashfree checkout. Check your connection and try again.'))
      document.head.appendChild(script)
    }).catch((error) => {
      cashfreeSdkPromise = null
      throw error
    })
  }
  return cashfreeSdkPromise
}

function getServiceCategory(service) {
  const text = `${service.name} ${service.description || ''}`.toLowerCase()
  if (/brow|lash/.test(text)) return 'Brows & lashes'
  if (/wax|hair removal|laser/.test(text)) return 'Hair removal'
  if (/medspa|aesthetic/.test(text)) return 'Medspa & aesthetics'
  if (/facial|skin|skincare/.test(text)) return 'Facials & skincare'
  if (/nail|manicure|pedicure/.test(text)) return 'Nails'
  if (/massage/.test(text)) return 'Massage'
  if (/makeup|make-up/.test(text)) return 'Makeup'
  if (/hair|cut|blow.?dry|balayage|color|colour|styling/.test(text)) return 'Hair'
  return 'Other'
}

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

function friendlyErrorMessage(error) {
  const message = typeof error === 'string' ? error : error?.message
  if (/email or password is incorrect|invalid credentials/i.test(message || '')) {
    return 'We couldn’t sign you in. Check your email and password, then try again.'
  }
  if (/failed to fetch|networkerror|load failed/i.test(message || '')) {
    return 'We couldn’t reach the salon just now. Check your connection and try again.'
  }
  if (/10-digit phone|valid phone|phone number/i.test(message || '')) {
    return 'Add a valid 10-digit phone number to your profile before opening Cashfree.'
  }
  if (/payment.*(details?|information).*required|required.*payment/i.test(message || '')) {
    return 'Please complete the payment details shown in the Cashfree checkout, then try again.'
  }
  return message || 'Something went wrong. Please try again.'
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
  const [adminSummary, setAdminSummary] = useState(null)
  const [reviews, setReviews] = useState([])
  const [paymentConfig, setPaymentConfig] = useState({ currency: 'INR' })
  const [serviceId, setServiceId] = useState('')
  const [staffId, setStaffId] = useState('')
  const [serviceSearch, setServiceSearch] = useState('')
  const [serviceCategory, setServiceCategory] = useState('All')
  const [date, setDate] = useState(tomorrow)
  const [selectedSlot, setSelectedSlot] = useState(null)
  const [loadedAvailabilityKey, setLoadedAvailabilityKey] = useState('')
  const [toast, setToast] = useState(null)
  const [loading, setLoading] = useState(false)
  const [authMode, setAuthMode] = useState('login')
  const [auth, setAuth] = useState({ name: '', email: '', password: '', phone: '' })
  const [profile, setProfile] = useState({ name: '', phone: '' })
  const [serviceForm, setServiceForm] = useState({ name: '', description: '', durationMinutes: 45, price: '' })
  const [staffForm, setStaffForm] = useState({ name: '', bio: '', specializations: '' })
  const [scheduleForm, setScheduleForm] = useState({ staffId: '', weekday: 1, startTime: '09:00', endTime: '17:00' })

  useEffect(() => {
    if (!toast) return undefined
    const timeout = window.setTimeout(() => setToast(null), toast.type === 'error' ? 6500 : 4000)
    return () => window.clearTimeout(timeout)
  }, [toast])

  const activeService = useMemo(() => services.find((service) => String(service.id) === String(serviceId)), [services, serviceId])
  const availabilityKey = `${serviceId}|${date}|${staffId}`
  const availabilityLoading = Boolean(serviceId && date && availabilityKey !== loadedAvailabilityKey)
  const availableCategories = ['All', ...categoryOrder]
  const filteredServices = useMemo(() => {
    const query = serviceSearch.trim().toLowerCase()
    return services.filter((service) => {
      const matchesQuery = !query || `${service.name} ${service.description || ''}`.toLowerCase().includes(query)
      const matchesCategory = serviceCategory === 'All' || getServiceCategory(service) === serviceCategory
      return matchesQuery && matchesCategory
    })
  }, [services, serviceSearch, serviceCategory])

  const fetchCatalog = useCallback(() => Promise.all([
    api('/services'), api('/staff'), api('/reviews'), api('/payments/config'),
  ]), [])

  const loadCatalog = useCallback(async () => {
    try {
      const [serviceList, staffList, reviewList, config] = await fetchCatalog()
      setServices(serviceList)
      setStaff(staffList)
      setReviews(reviewList)
      setPaymentConfig(config)
      setServiceId((current) => current || String(serviceList[0]?.id || ''))
    } catch (requestError) {
      showError(requestError)
    }
  }, [fetchCatalog])

  const loadAppointments = useCallback(async (currentToken = token) => {
    if (!currentToken) return
    try {
      setAppointments(await api('/appointments', { token: currentToken }))
    } catch (requestError) {
      showError(requestError)
    }
  }, [token])

  useEffect(() => {
    let active = true
    fetchCatalog().then(([serviceList, staffList, reviewList, config]) => {
      if (!active) return
      setServices(serviceList)
      setStaff(staffList)
      setReviews(reviewList)
      setPaymentConfig(config)
      setServiceId((current) => current || String(serviceList[0]?.id || ''))
    }).catch((requestError) => {
      if (active) showError(requestError)
    })
    return () => { active = false }
  }, [fetchCatalog])

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
    if (!serviceId) return
    let active = true
    async function findNextAvailableDate() {
      for (let offset = 1; offset <= 21; offset += 1) {
        const candidate = new Date()
        candidate.setHours(12, 0, 0, 0)
        candidate.setDate(candidate.getDate() + offset)
        const candidateDate = toLocalDateString(candidate)
        try {
          const availableSlots = await api(`/availability?serviceId=${serviceId}&date=${candidateDate}${staffId ? `&staffId=${staffId}` : ''}`)
          if (!active) return
          if (availableSlots.length) {
            setDate(candidateDate)
            setSelectedSlot(null)
            return
          }
        } catch (requestError) {
          if (active) showError(requestError)
          return
        }
      }
      if (active) setDate(tomorrow)
    }
    findNextAvailableDate()
    return () => { active = false }
  }, [serviceId, staffId])

  useEffect(() => {
    if (!serviceId || !date) return
    let active = true
    const requestedAvailabilityKey = `${serviceId}|${date}|${staffId}`
    api(`/availability?serviceId=${serviceId}&date=${date}${staffId ? `&staffId=${staffId}` : ''}`)
      .then((availableSlots) => {
        if (!active) return
        setSlots(availableSlots)
        setLoadedAvailabilityKey(requestedAvailabilityKey)
      })
      .catch((requestError) => {
        if (!active) return
        setLoadedAvailabilityKey(requestedAvailabilityKey)
        showError(requestError)
      })
    return () => { active = false }
  }, [serviceId, staffId, date])

  useEffect(() => {
    const url = new URL(window.location.href)
    if (url.searchParams.get('payment') !== 'cashfree_return' || !token) return undefined
    const appointmentId = url.searchParams.get('appointmentId')
    url.searchParams.delete('payment')
    url.searchParams.delete('appointmentId')
    window.history.replaceState({}, '', url.toString())
    if (!appointmentId) {
      showError('We could not identify the appointment for this payment.')
      return undefined
    }

    let active = true
    api(`/appointments/${appointmentId}/payment`, { token })
      .then(async (payment) => {
        if (!active) return
        if (payment.status === 'paid') {
          showMessage(payment.confirmationEmailSent
            ? 'Payment received. Your appointment confirmation email has been sent.'
            : 'Payment received. Email delivery is pending; refresh your appointments shortly.')
        }
        else if (payment.status === 'failed') showError('Payment was not completed. You can try again from your appointments.')
        else showMessage('Payment is still processing. Please refresh your appointments shortly.')
        await loadAppointments(token)
      })
      .catch((requestError) => {
        if (active) showError(requestError)
      })
    return () => { active = false }
  }, [token, loadAppointments])

  function showError(text) {
    setToast({ type: 'error', text: friendlyErrorMessage(text) })
  }

  function showMessage(text) {
    setToast({ type: 'success', text })
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
    if (paymentConfig.provider === 'cashfree') {
      const phoneDigits = String(profile.phone || '').replace(/\D/g, '')
      const normalizedPhone = phoneDigits.length === 12 && phoneDigits.startsWith('91') ? phoneDigits.slice(2) : phoneDigits
      if (!/^\d{10}$/.test(normalizedPhone)) {
        setTab('appointments')
        window.setTimeout(() => document.querySelector('.profile-form')?.scrollIntoView({ behavior: 'smooth' }), 0)
        return showError('Add a valid 10-digit phone number to your profile before payment.')
      }
    }
    setLoading(true)
    try {
      const cashfreeSdk = paymentConfig.provider === 'cashfree' ? await loadCashfreeSdk() : null
      const result = await api('/appointments', {
        token, method: 'POST',
        body: JSON.stringify({ serviceId: Number(serviceId), staffId: selectedSlot.staffId, date, startTime: selectedSlot.startTime }),
      })
      setSlots((current) => current.filter((slot) => slot.staffId !== selectedSlot.staffId || slot.startTime !== selectedSlot.startTime))
      setSelectedSlot(null)
      setTab('appointments')
      await loadAppointments()
      if (paymentConfig.provider) {
        showMessage('Your appointment is reserved. Complete secure payment to receive your confirmation email.')
        try {
          const payment = await startCheckout(result.id, cashfreeSdk)
          if (payment?.status === 'paid') {
            showMessage(payment.confirmationEmailSent
              ? 'Payment received. Your appointment confirmation email has been sent.'
              : 'Payment received. Email delivery is pending; refresh your appointments shortly.')
          }
          else if (payment?.status === 'failed') showError('Payment was not completed. Your appointment is reserved; you can retry from My appointments.')
          else if (!payment?.redirected) showMessage('Payment is processing. We’ll email your appointment confirmation once it is verified.')
        } catch (paymentError) {
          showError(`Your appointment is reserved, but payment did not finish. You can retry from My appointments. ${friendlyErrorMessage(paymentError)}`)
        }
      } else {
        showMessage(`Booking confirmed for ${date} at ${selectedSlot.startTime}.`)
      }
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

  async function rescheduleAppointment(id) {
    const newDate = window.prompt('Choose a new date (YYYY-MM-DD)', tomorrow)
    if (!newDate) return
    const startTime = window.prompt('Choose a new start time (HH:MM)', '10:00')
    if (!startTime) return
    try {
      await api(`/appointments/${id}/reschedule`, {
        token, method: 'PATCH', body: JSON.stringify({ date: newDate, startTime }),
      })
      showMessage(`Appointment rescheduled to ${newDate} at ${startTime}.`)
      await loadAppointments()
    } catch (requestError) {
      showError(requestError.message)
    }
  }

  async function completeAppointment(id) {
    try {
      await api(`/appointments/${id}/status`, { token, method: 'PATCH', body: JSON.stringify({ status: 'completed' }) })
      showMessage('Appointment marked as completed.')
      await Promise.all([loadAppointments(), loadAdminSummary()])
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
      await Promise.all([loadCatalog(), loadAdminSummary()])
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
      await Promise.all([loadCatalog(), loadAdminSummary()])
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

  async function loadAdminSummary() {
    try { setAdminSummary(await api('/admin/dashboard', { token })) } catch (requestError) { showError(requestError.message) }
  }

  async function updateRole(id, role) {
    try {
      await api(`/admin/users/${id}`, { token, method: 'PATCH', body: JSON.stringify({ role }) })
      await Promise.all([loadUsers(), loadAdminSummary()])
      showMessage('User role updated.')
    } catch (requestError) { showError(requestError.message) }
  }

  async function startCheckout(id, loadedCashfreeSdk) {
    const result = await api(`/appointments/${id}/checkout`, { token, method: 'POST' })
    if (result.provider !== 'cashfree') {
      window.location.assign(result.checkoutUrl)
      return { redirected: true }
    }

    const Cashfree = loadedCashfreeSdk || await loadCashfreeSdk()
    if (!Cashfree) throw new Error('Cashfree checkout could not be initialized. Please try again.')
    const checkoutResult = await Cashfree({ mode: result.mode }).checkout({
      paymentSessionId: result.paymentSessionId,
      redirectTarget: '_modal',
    })
    if (checkoutResult?.error) throw new Error(checkoutResult.error.message || 'Cashfree payment was not completed.')

    let payment
    for (let attempt = 0; attempt < 6; attempt += 1) {
      payment = await api(`/appointments/${id}/payment`, { token })
      if (payment.status !== 'pending') break
      if (attempt < 5) await new Promise((resolve) => window.setTimeout(resolve, 1500))
    }
    await loadAppointments()
    return payment
  }

  async function checkout(id) {
    setLoading(true)
    try {
      const payment = await startCheckout(id)
      if (payment?.status === 'paid') {
        showMessage(payment.confirmationEmailSent
          ? 'Payment received. Your appointment confirmation email has been sent.'
          : 'Payment received. Email delivery is pending; refresh your appointments shortly.')
      }
      else if (payment?.status === 'failed') showError('Payment was not completed. You can try again.')
      else if (!payment?.redirected) showMessage('Payment is processing. We’ll email your confirmation once it is verified.')
    } catch (requestError) { showError(requestError.message) }
    finally { setLoading(false) }
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
    setToast(null)
    if (nextTab === 'appointments') loadAppointments()
    if (nextTab === 'admin' && user?.role === 'admin') {
      loadUsers()
      loadAdminSummary()
    }
  }

  return (
    <div className="app-shell">
      <header className="topbar navbar navbar-expand-lg" id="top">
        <div className="container-fluid px-0">
        <a className="brand" href="#top" onClick={() => changeTab('book')} aria-label="Maison home">
          <span className="brand-mark">m</span>
          <span>maison<span className="brand-period">.</span></span>
        </a>
        <nav className="main-nav nav mx-lg-auto" aria-label="Main navigation">
          <button className={tab === 'book' ? 'nav-link active' : 'nav-link'} onClick={() => changeTab('book')}>Book an appointment</button>
          {user && <button className={tab === 'appointments' ? 'nav-link active' : 'nav-link'} onClick={() => changeTab('appointments')}>My appointments</button>}
          {user?.role === 'admin' && <button className={tab === 'admin' ? 'nav-link active' : 'nav-link'} onClick={() => changeTab('admin')}>Salon dashboard</button>}
        </nav>
        <div className="account-area d-flex align-items-center gap-3">
          {user ? <><span className="welcome-name">Hi, {user.name.split(' ')[0]}</span><button className="btn btn-outline-dark btn-sm" onClick={signOut}>Sign out</button></>
            : <button className="btn btn-dark btn-sm" onClick={() => document.getElementById('account')?.scrollIntoView({ behavior: 'smooth' })}>Sign in</button>}
        </div>
        </div>
      </header>

      <main>
        <section className="hero container-fluid">
          <div className="row align-items-center g-4">
          <div className="hero-copy col-lg-5">
            <p className="eyebrow">YOUR MOMENT, WELL SPENT</p>
            <h1>Make room<br />for <em>feeling good.</em></h1>
            <p className="hero-description">Discover thoughtful hair, skin and beauty rituals, then book a time that works for you.</p>
            <button className="btn btn-dark" onClick={() => document.getElementById('booking')?.scrollIntoView({ behavior: 'smooth' })}>Find your appointment <span aria-hidden="true">↗︎</span></button>
          </div>
          <div className="hero-art col-lg-6 offset-lg-1" role="img" aria-label="Warm, sunlit salon interior">
            <div className="hero-art-sun" />
            <div className="hero-art-vase"><span /><i /><b /></div>
            <div className="hero-art-caption">A softer kind of self-care</div>
          </div>
          </div>
          <div className="hero-footnote"><span>01 — 03</span><span>GOOD HAIR. GOOD SKIN. GOOD ENERGY.</span></div>
        </section>

        {toast && (
          <div className={`toast-notice ${toast.type}`} role={toast.type === 'error' ? 'alert' : 'status'} aria-live={toast.type === 'error' ? 'assertive' : 'polite'}>
            <span className="toast-icon" aria-hidden="true">{toast.type === 'error' ? '!' : '✓'}</span>
            <p>{toast.text}</p>
            <button type="button" onClick={() => setToast(null)} aria-label="Dismiss notification">×</button>
          </div>
        )}

        <section className="booking-section container-fluid py-5 px-4 px-lg-5" id="booking">
          <div className="section-heading row align-items-end mb-4">
            <div className="col"><p className="eyebrow">THE MAISON EXPERIENCE</p><h2>Make time for <em>you.</em></h2></div>
            <p className="col-lg-4">Find your ritual and a time that works. We’ll take care of the rest.</p>
          </div>
          <div className="booking-layout row g-4 g-xl-5">
            <div className="service-list col-lg-7">
              <div className="list-heading"><span>EXPLORE TREATMENTS</span><span>{String(filteredServices.length).padStart(2, '0')} AVAILABLE</span></div>
              {availableCategories.length > 1 && <div className="category-filters" aria-label="Treatment categories">
                {availableCategories.map((category) => (
                  <button
                    className={serviceCategory === category ? 'category-chip active' : 'category-chip'}
                    key={category}
                    type="button"
                    aria-pressed={serviceCategory === category}
                    onClick={() => setServiceCategory(category)}
                  >{category}</button>
                ))}
              </div>}
              <label className="service-search">
                <span aria-hidden="true">⌕</span>
                <input
                  type="search"
                  aria-label="Search treatments"
                  placeholder="Search hair, skin and beauty"
                  value={serviceSearch}
                  onChange={(event) => setServiceSearch(event.target.value)}
                />
                {serviceSearch && <button type="button" onClick={() => setServiceSearch('')} aria-label="Clear treatment search">×</button>}
              </label>
              {services.length === 0 && <p className="empty-copy">Our service menu is being prepared. Please check back soon.</p>}
              {filteredServices.map((service, index) => (
                <button key={service.id} className={`service-row d-flex align-items-center gap-3 ${String(service.id) === String(serviceId) ? 'selected' : ''}`} onClick={() => { setSelectedSlot(null); setSlots([]); setServiceId(String(service.id)) }}>
                  <span className="service-number flex-shrink-0">0{index + 1}</span>
                  <span className="service-main flex-grow-1 d-flex flex-column gap-2"><strong>{service.name}</strong><small>{service.description || `${service.duration_minutes} minutes of care`}</small></span>
                  <span className="service-meta flex-shrink-0">{service.duration_minutes} min<br /><b>{formatCurrency(service.price, paymentConfig.currency)}</b></span>
                  <span className="row-arrow flex-shrink-0" aria-hidden="true">↗︎</span>
                </button>
              ))}
              {services.length > 0 && filteredServices.length === 0 && <p className="empty-copy">No treatments match “{serviceSearch}”. Try another search.</p>}
              <div className="booking-aside-note"><span>✳︎</span> A beautiful appointment begins with choosing what feels right.</div>
            </div>

            <div className="booking-card card shadow-sm col-lg-5 p-4">
              <div className="booking-card-title"><span className="step-number">01</span><div><h3>Find your time</h3><p>Choose your day and stylist.</p></div></div>
              <form onSubmit={bookAppointment}>
                <label htmlFor="booking-date">Appointment date</label>
                <input className="form-control" id="booking-date" type="date" min={today} value={date} onChange={(event) => { setSelectedSlot(null); setSlots([]); setDate(event.target.value) }} />
                <label htmlFor="booking-staff">Your stylist</label>
                <select className="form-select" id="booking-staff" value={staffId} onChange={(event) => { setSelectedSlot(null); setSlots([]); setStaffId(event.target.value) }}>
                  <option value="">Anyone available</option>
                  {staff.filter((member) => !member.services?.length || member.services.some((service) => String(service.id) === String(serviceId))).map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}
                </select>
                <div className="slot-label"><label>Available times</label>{activeService && <span>{activeService.duration_minutes} min · {formatCurrency(activeService.price, paymentConfig.currency)}</span>}</div>
                <div className="slot-grid row row-cols-4 g-2">
                  {availabilityLoading ? <p className="empty-copy slots-empty">Finding available times…</p> : slots.length ? slots.map((slot) => {
                    const selected = selectedSlot?.staffId === slot.staffId && selectedSlot?.startTime === slot.startTime
                    return <div className="col" key={`${slot.staffId}-${slot.startTime}`}><button type="button" className={`time-slot btn btn-sm w-100 ${selected ? 'btn-dark' : 'btn-outline-secondary'}`} onClick={() => setSelectedSlot(slot)} title={`${slot.staffName} · ${slot.startTime}`}>{slot.startTime}</button></div>
                  }) : <p className="empty-copy slots-empty">{serviceId ? 'No times available for this day. Try another date or stylist.' : 'Select a service to find a time.'}</p>}
                </div>
                <button
                  className="btn btn-dark book-button"
                  type={user ? 'submit' : 'button'}
                  disabled={loading || (Boolean(user) && (!paymentConfig.provider || availabilityLoading || !selectedSlot))}
                  onClick={() => {
                    if (!user) document.getElementById('account')?.scrollIntoView({ behavior: 'smooth' })
                  }}
                >
                  {loading ? 'Booking…' : !user ? 'Sign in to book' : !paymentConfig.provider ? 'Payment setup required' : 'Confirm & pay'} <span aria-hidden="true">↗︎</span>
                </button>
                {!user && <p className="form-hint">Your appointment is just a sign-in away.</p>}
                {user && !paymentConfig.provider && <p className="form-hint">An online payment provider must be configured before booking.</p>}
              </form>
            </div>
          </div>
        </section>

        <section className="promise-band d-flex flex-column align-items-center justify-content-center">
          <div className="promise-star">✳︎</div><p>Little rituals. <em>Lasting</em> confidence.</p><span>MADE WITH CARE, ALWAYS</span>
        </section>

        <section className="reviews-section container-fluid py-5 px-4 px-lg-5">
          <div className="section-heading row align-items-end mb-4"><div className="col"><p className="eyebrow">KIND WORDS</p><h2>A little love, <em>shared.</em></h2></div><p className="col-lg-4">Our favourite part is hearing how you felt when you left.</p></div>
          <div className="review-grid row row-cols-1 row-cols-md-3 g-3">
            {reviews.slice(0, 3).map((review) => <article className="review-card card col" key={review.id}><div className="stars">{'★'.repeat(review.rating)}{'☆'.repeat(5 - review.rating)}</div><p>“{review.comment || 'A wonderful experience from start to finish.'}”</p><span>{review.staff_name} · MAISON CLIENT</span>{review.staff_response && <small className="review-response">Maison: {review.staff_response}</small>}</article>)}
            {!reviews.length && <p className="empty-copy">Your kind words will feel at home here.</p>}
          </div>
        </section>

        {!user && <section className="account-section container-fluid py-5 px-4 px-lg-5" id="account">
          <div className="row align-items-center g-4">
          <div className="col-lg-6"><p className="eyebrow">YOUR MAISON ACCOUNT</p><h2>Make it <em>personal.</em></h2><p>Sign in to manage your visits, or create an account to book your first ritual.</p></div>
          <form className="account-form card col-lg-5 offset-lg-1" onSubmit={submitAuth}>
            <div className="auth-toggle nav nav-tabs"><button type="button" className={authMode === 'login' ? 'nav-link active' : 'nav-link'} onClick={() => setAuthMode('login')}>Sign in</button><button type="button" className={authMode === 'register' ? 'nav-link active' : 'nav-link'} onClick={() => setAuthMode('register')}>Create account</button></div>
            {authMode === 'register' && <input className="form-control" required placeholder="Your name" value={auth.name} onChange={(event) => setAuth({ ...auth, name: event.target.value })} />}
            <input className="form-control" required type="email" placeholder="Email address" value={auth.email} onChange={(event) => setAuth({ ...auth, email: event.target.value })} />
            {authMode === 'register' && <input className="form-control" type="tel" placeholder="Phone (optional)" value={auth.phone} onChange={(event) => setAuth({ ...auth, phone: event.target.value })} />}
            <input className="form-control" required type="password" minLength="8" placeholder="Password (8+ characters)" value={auth.password} onChange={(event) => setAuth({ ...auth, password: event.target.value })} />
            <button className="btn btn-dark w-100" type="submit" disabled={loading}>{loading ? 'Please wait…' : authMode === 'login' ? 'Sign in' : 'Create my account'} <span aria-hidden="true">↗︎</span></button>
          </form>
          </div>
        </section>}

        {user && tab === 'appointments' && <section className="dashboard-section container-fluid py-5 px-4 px-lg-5">
          <div className="section-heading row align-items-center"><div className="col"><p className="eyebrow">YOUR VISITS</p><h2>Appointments, <em>your way.</em></h2></div><div className="col-auto"><button className="btn btn-outline-dark" onClick={() => changeTab('book')}>Book another visit ↗︎</button></div></div>
          {appointments.length ? <div className="appointment-list list-group list-group-flush">{appointments.map((appointment) => <article className="appointment-card list-group-item row align-items-center g-2" key={appointment.id}>
            <div className="appointment-date col-auto"><span>{new Date(`${appointment.appointment_date}T12:00:00`).toLocaleDateString('en-US', { month: 'short' }).toUpperCase()}</span><strong>{new Date(`${appointment.appointment_date}T12:00:00`).getDate()}</strong></div>
            <div className="appointment-info col"><h3>{appointment.service_name}</h3><p>{appointment.staff_name} · {appointment.start_time.slice(0, 5)} · {appointment.duration_minutes} min</p></div>
            <span className={`status-pill col-auto ${appointment.status}`}>{appointment.status}</span>
            {appointment.payment_status === 'paid' && <span className="status-pill col-auto paid">Paid</span>}
            <div className="appointment-actions col-auto d-flex flex-wrap gap-2">
              {['pending_payment', 'confirmed'].includes(appointment.status) && appointment.payment_status !== 'paid' && <button className="btn btn-sm btn-link" disabled={loading} onClick={() => checkout(appointment.id)}>{loading ? 'Opening checkout…' : 'Pay online'}</button>}
              {appointment.status === 'confirmed' && <button className="btn btn-sm btn-link" onClick={() => rescheduleAppointment(appointment.id)}>Reschedule</button>}
              {['pending_payment', 'confirmed'].includes(appointment.status) && <button className="btn btn-sm btn-link text-secondary" onClick={() => cancelAppointment(appointment.id)}>Cancel</button>}
              {appointment.status === 'completed' && <button className="btn btn-sm btn-link" onClick={() => review(appointment.id)}>Leave a review</button>}
              {appointment.status === 'completed' && <a className="btn btn-sm btn-link" href={`${API_URL}/appointments/${appointment.id}/invoice`} onClick={(event) => { event.preventDefault(); api(`/appointments/${appointment.id}/invoice`, { token }).then((invoice) => showMessage(`Invoice ${invoice.invoice_number} · ${formatCurrency(invoice.amount, paymentConfig.currency)}`)).catch((requestError) => showError(requestError.message)) }}>Invoice</a>}
            </div>
          </article>)}</div> : <div className="empty-panel"><span>✳︎</span><h3>Your next little ritual awaits.</h3><p>When you book a visit, you’ll find it here.</p><button className="btn btn-dark" onClick={() => changeTab('book')}>Explore services ↗︎</button></div>}
          <form className="profile-form card row row-cols-1 row-cols-lg-4 g-3 p-3 p-lg-4 mt-4" onSubmit={saveProfile}><div className="col"><p className="eyebrow">PROFILE DETAILS</p><h3>Your details</h3></div><div className="col"><input className="form-control" aria-label="Name" value={profile.name} onChange={(event) => setProfile({ ...profile, name: event.target.value })} /></div><div className="col"><input className="form-control" aria-label="Phone" value={profile.phone} placeholder="Phone" onChange={(event) => setProfile({ ...profile, phone: event.target.value })} /></div><div className="col"><button className="btn btn-outline-dark" type="submit">Save profile</button></div></form>
        </section>}

        {user?.role === 'admin' && tab === 'admin' && <section className="dashboard-section container-fluid py-5 px-4 px-lg-5">
          <div className="section-heading row align-items-center"><div className="col"><p className="eyebrow">THE SALON, AT A GLANCE</p><h2>Maison <em>dashboard.</em></h2></div><div className="col-auto d-flex align-items-center gap-2"><button className="btn btn-outline-dark btn-sm" onClick={loadAdminSummary}>Refresh overview</button><span className="admin-badge">ADMIN VIEW</span></div></div>
          <div className="stat-grid row row-cols-2 row-cols-lg-4 g-0">{[['APPOINTMENTS', adminSummary?.appointments ?? appointments.length, `${adminSummary?.todayAppointments ?? 0} scheduled today`], ['OUR SERVICES', adminSummary?.services ?? services.length, 'services available to book'], ['OUR PEOPLE', adminSummary?.staff ?? staff.length, 'active stylists'], ['REVIEWS', adminSummary?.reviews ?? reviews.length, 'client experiences shared']].map(([label, count, caption]) => <div className="col" key={label}><div className="stat-card"><span>{label}</span><strong>{count}</strong><small>{caption}</small></div></div>)}</div>
          <div className="admin-columns row g-3">
            <div className="col-lg-6"><div className="admin-panel card h-100"><div className="panel-title"><div><p className="eyebrow">SERVICE MENU</p><h3>Add a service</h3></div></div><form className="stack-form" onSubmit={createService}><input className="form-control" required placeholder="Service name" value={serviceForm.name} onChange={(event) => setServiceForm({ ...serviceForm, name: event.target.value })} /><input className="form-control" placeholder="Description" value={serviceForm.description} onChange={(event) => setServiceForm({ ...serviceForm, description: event.target.value })} /><div className="form-row row g-2"><label className="col">Minutes<input className="form-control" required type="number" min="5" value={serviceForm.durationMinutes} onChange={(event) => setServiceForm({ ...serviceForm, durationMinutes: event.target.value })} /></label><label className="col">Price<input className="form-control" required type="number" min="0" step="0.01" value={serviceForm.price} onChange={(event) => setServiceForm({ ...serviceForm, price: event.target.value })} /></label></div><button className="btn btn-dark align-self-start">Add service +</button></form>
              <div className="admin-service-list">{services.map((service) => <div key={service.id}><span>{service.name}</span><b>{formatCurrency(service.price, paymentConfig.currency)}</b></div>)}</div>
            </div>
            </div>
            <div className="col-lg-6"><div className="admin-panel card h-100"><div className="panel-title"><div><p className="eyebrow">OUR PEOPLE</p><h3>Stylist profiles</h3></div></div><form className="stack-form" onSubmit={createStaff}><input className="form-control" required placeholder="Stylist name" value={staffForm.name} onChange={(event) => setStaffForm({ ...staffForm, name: event.target.value })} /><input className="form-control" placeholder="Short bio" value={staffForm.bio} onChange={(event) => setStaffForm({ ...staffForm, bio: event.target.value })} /><input className="form-control" placeholder="Specializations, comma separated" value={staffForm.specializations} onChange={(event) => setStaffForm({ ...staffForm, specializations: event.target.value })} /><button className="btn btn-dark align-self-start">Add stylist +</button></form>
              <div className="admin-service-list">{staff.map((member) => <div key={member.id}><span>{member.name}</span><select className="form-select" aria-label={`Assign service to ${member.name}`} defaultValue="" onChange={(event) => event.target.value && assignService(member.id, event.target.value)}><option value="" disabled>Assign service +</option>{services.map((service) => <option key={service.id} value={service.id}>{service.name}</option>)}</select></div>)}</div>
              {staff.length > 0 && <form className="schedule-form" onSubmit={saveAvailability}><h4>Set weekly working hours</h4><select className="form-select" required value={scheduleForm.staffId} onChange={(event) => setScheduleForm({ ...scheduleForm, staffId: event.target.value })}><option value="">Choose stylist</option>{staff.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}</select><div className="form-row row g-2"><select className="form-select col" value={scheduleForm.weekday} onChange={(event) => setScheduleForm({ ...scheduleForm, weekday: event.target.value })}>{['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((day, index) => <option key={day} value={index}>{day}</option>)}</select><input className="form-control col" type="time" value={scheduleForm.startTime} onChange={(event) => setScheduleForm({ ...scheduleForm, startTime: event.target.value })} /><input className="form-control col" type="time" value={scheduleForm.endTime} onChange={(event) => setScheduleForm({ ...scheduleForm, endTime: event.target.value })} /></div><button className="btn btn-outline-dark">Save working hours</button></form>}
            </div>
            </div>
          </div>
          <div className="admin-panel card full-panel"><div className="panel-title d-flex justify-content-between align-items-center"><div><p className="eyebrow">TODAY, TOMORROW, AND WHAT'S NEXT</p><h3>Appointment management</h3></div><button className="btn btn-outline-dark btn-sm" onClick={() => { loadAppointments(); loadAdminSummary() }}>Refresh</button></div>
            {appointments.map((appointment) => <div className="admin-appointment row align-items-center g-2" key={appointment.id}><div className="col-md-4"><strong>{appointment.customer_name}</strong><span>{appointment.service_name} · {appointment.staff_name}</span></div><span className="col-md-3">{appointment.appointment_date} · {appointment.start_time.slice(0, 5)}</span><span className={`status-pill col-auto ${appointment.status}`}>{appointment.status}</span>{appointment.status === 'confirmed' && <button className="btn btn-sm btn-link col-auto" onClick={() => completeAppointment(appointment.id)}>Mark completed</button>}</div>)}
            {!appointments.length && <p className="empty-copy">No appointments yet.</p>}
          </div>
          <div className="admin-panel card full-panel"><div className="panel-title d-flex justify-content-between align-items-center"><div><p className="eyebrow">CLIENT RELATIONSHIPS</p><h3>Customer accounts</h3></div><button className="btn btn-outline-dark btn-sm" onClick={loadUsers}>Refresh users</button></div>
            {users.map((customer) => <div className="admin-appointment row align-items-center g-2" key={customer.id}><div className="col-md-4"><strong>{customer.name}</strong><span>{customer.email}</span></div><span className="col-md-4">{customer.phone || 'No phone added'}</span><div className="col-auto"><select className="form-select" value={customer.role} onChange={(event) => updateRole(customer.id, event.target.value)} aria-label={`Role for ${customer.name}`}><option value="customer">Customer</option><option value="staff">Staff</option><option value="admin">Admin</option></select></div></div>)}
            {!users.length && <p className="empty-copy">Load customer accounts to manage access.</p>}
          </div>
        </section>}
      </main>

      <footer className="footer container-fluid d-flex align-items-center justify-content-between flex-wrap gap-3"><a className="brand" href="#top"><span className="brand-mark">m</span><span>maison<span className="brand-period">.</span></span></a><span>YOUR TIME, BEAUTIFULLY SPENT.</span><span>© {new Date().getFullYear()} MAISON SALON</span></footer>
    </div>
  )
}

export default App
