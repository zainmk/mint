import { useState, useEffect, useMemo } from 'react'
import mintIcon from './assets/mint.svg'
import './App.css'

function parseAmount(str) {
  const n = parseFloat(String(str || '').replace(/[^0-9.-]/g, ''))
  return Number.isFinite(n) ? n : 0
}

function normalizeDateValue(value) {
  const raw = String(value || '').trim()
  if (!raw) return null

  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw

  const parsed = new Date(raw)
  if (Number.isNaN(parsed.getTime())) return null

  const year = parsed.getFullYear()
  const month = String(parsed.getMonth() + 1).padStart(2, '0')
  const day = String(parsed.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

// Adjacent letter keys (top row QWERTY) for tag shortcuts when modal is open
const TAG_SHORTCUT_KEYS = 'qwertyuiop'

const DB_NAME = 'mint-db'
const DB_VERSION = 1
const STORE_NAME = 'mint-store'
const DATA_KEY = 'mint-data'

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onerror = () => reject(req.error)
    req.onsuccess = () => resolve(req.result)
    req.onupgradeneeded = (e) => {
      e.target.result.createObjectStore(STORE_NAME)
    }
  })
}

async function loadFromIndexedDB() {
  try {
    const db = await openDB()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly')
      const req = tx.objectStore(STORE_NAME).get(DATA_KEY)
      req.onsuccess = () => {
        db.close()
        const data = req.result
        if (!data) {
          resolve({ tags: [], records: [], recordTags: {} })
          return
        }
        resolve({
          tags: Array.isArray(data.tags) ? data.tags : [],
          records: Array.isArray(data.records) ? data.records : [],
          recordTags:
            data.recordTags && typeof data.recordTags === 'object' && !Array.isArray(data.recordTags)
              ? data.recordTags
              : {},
        })
      }
      req.onerror = () => {
        db.close()
        reject(req.error)
      }
    })
  } catch {
    return { tags: [], records: [], recordTags: {} }
  }
}

async function saveToIndexedDB(data) {
  try {
    const db = await openDB()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      const req = tx.objectStore(STORE_NAME).put(data, DATA_KEY)
      req.onsuccess = () => {
        db.close()
        resolve()
      }
      req.onerror = () => {
        db.close()
        reject(req.error)
      }
    })
  } catch {
    // ignore save errors
  }
}

function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/)
  if (lines.length < 2) return []
  const parseRow = (line) => {
    const values = []
    let current = ''
    let inQuotes = false
    for (let i = 0; i < line.length; i++) {
      const c = line[i]
      if (c === '"') inQuotes = !inQuotes
      else if (c === ',' && !inQuotes) {
        values.push(current.trim())
        current = ''
      } else current += c
    }
    values.push(current.trim())
    return values
  }
  const headerRow = parseRow(lines[0]).map((h) => h.replace(/^"|"$/g, '').trim())
  const dateIdx = headerRow.findIndex((h) => /date/i.test(h))
  const titleIdx = headerRow.findIndex((h) => /title/i.test(h))
  const amountIdx = headerRow.findIndex((h) => /amount/i.test(h))
  if (dateIdx === -1 || titleIdx === -1 || amountIdx === -1) return []
  return lines.slice(1).map((line) => {
    const values = parseRow(line)
    return {
      date: values[dateIdx] ?? '',
      title: values[titleIdx] ?? '',
      amount: values[amountIdx] ?? '',
    } 
  })
}

function App() {
  const [records, setRecords] = useState([])
  const [error, setError] = useState(null)
  const [tags, setTags] = useState([])
  const [newTagName, setNewTagName] = useState('')
  const [recordTags, setRecordTags] = useState({})
  const [showTagModal, setShowTagModal] = useState(false)
  const [modalRecordIndex, setModalRecordIndex] = useState(0)
  const [selectedTags, setSelectedTags] = useState([])
  const [dateFrom, setDateFrom] = useState(new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]) // 90 DAYS BEFORE TODAY
  const [dateTo, setDateTo] = useState(new Date().toISOString().split('T')[0])
  const [chartMode, setChartMode] = useState('bar')
  const [calendarViewMonth, setCalendarViewMonth] = useState(null)
  const [isLoaded, setIsLoaded] = useState(false)

  useEffect(() => {
    loadFromIndexedDB().then((data) => {
      setTags(data.tags)
      setRecords(data.records)
      setRecordTags(data.recordTags)
      setIsLoaded(true)
    })
  }, [])

  useEffect(() => {
    if (!isLoaded) return
    saveToIndexedDB({ tags, records, recordTags })
  }, [isLoaded, tags, records, recordTags])

  const handleFileChange = (e) => {
    const file = e.target.files?.[0]
    setError(null)
    if (!file) return
    if (!file.name.toLowerCase().endsWith('.csv')) {
      setError('Please select a CSV file.')
      return
    }
    const reader = new FileReader()
    reader.onload = (event) => {
      try {
        const text = event.target?.result
        if (typeof text !== 'string') {
          setError('Could not read file.')
          return
        }
        const parsed = parseCSV(text)
        if (parsed.length === 0) {
          setError('No valid records found. CSV must have Date, Title, and Amount columns.')
          return
        }
        setRecords(parsed)
        setRecordTags({})
        if (tags.length > 0) {
          setModalRecordIndex(0)
          setShowTagModal(true)
        }
      } catch {
        setError('Failed to parse CSV.')
      }
    }
    reader.readAsText(file)
    e.target.value = ''
  }

  const addTag = () => {
    const name = newTagName.trim()
    if (!name || tags.includes(name)) return
    setTags((t) => [...t, name])
    setNewTagName('')
  }

  const removeTag = (tag) => {
    setTags((t) => t.filter((x) => x !== tag))
    setRecordTags((prev) => {
      const next = { ...prev }
      for (const i of Object.keys(next)) {
        if (next[i] === tag) delete next[i]
      }
      return next
    })
  }

  const setRecordTag = (rowIndex, tag) => {
    setRecordTags((prev) => {
      const next = { ...prev }
      if (!tag) {
        delete next[rowIndex]
        return next
      }
      next[rowIndex] = tag
      return next
    })
  }

  const toggleRecordTag = (rowIndex, tag) => {
    setRecordTags((prev) => {
      const next = { ...prev }
      if (prev[rowIndex] === tag) {
        delete next[rowIndex]
      } else {
        next[rowIndex] = tag
      }
      return next
    })
  }

  const getRecordTag = (rowIndex) => recordTags[rowIndex] ?? null
  const hasRecordTag = (rowIndex, tag) => recordTags[rowIndex] === tag

  useEffect(() => {
    if (!showTagModal) return
    const onKey = (e) => {
      const active = document.activeElement
      if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) {
        return
      }
      if (e.key === 'Escape') {
        setShowTagModal(false)
        return
      }
      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        setModalRecordIndex((i) => Math.max(0, i - 1))
        return
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault()
        setModalRecordIndex((i) => Math.min(records.length - 1, i + 1))
        return
      }
      const key = e.key.toLowerCase()
      if (TAG_SHORTCUT_KEYS.includes(key)) {
        const tagIndex = TAG_SHORTCUT_KEYS.indexOf(key)
        if (tagIndex < tags.length) {
          e.preventDefault()
          const tag = tags[tagIndex]
          toggleRecordTag(modalRecordIndex, tag)
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [showTagModal, modalRecordIndex, tags, records.length])


  const filteredRecords = useMemo(() => {
    const fromValue = normalizeDateValue(dateFrom)
    const toValue = normalizeDateValue(dateTo)

    return records
      .map((row, i) => ({ row, originalIndex: i }))
      .filter(({ row, originalIndex }) => {
        const tag = recordTags[originalIndex] ?? null
        if (selectedTags.length > 0) {
          const isUntaggedSelected = selectedTags.includes('Untagged')
          const isTagSelected = tag && selectedTags.includes(tag)
          if (!(isUntaggedSelected && tag == null || isTagSelected)) return false
        }

        if (!fromValue && !toValue) return true

        const rowDate = normalizeDateValue(row.date)
        if (!rowDate) return false
        if (fromValue && rowDate < fromValue) return false
        if (toValue && rowDate > toValue) return false
        return true
      })
  }, [records, selectedTags, dateFrom, dateTo, recordTags])

  const chartData = useMemo(() => {
    const byTag = {}
    tags.forEach((t) => { byTag[t] = 0 })
    byTag['Untagged'] = 0

    filteredRecords.forEach(({ row, originalIndex }) => {
      const tag = recordTags[originalIndex] ?? 'Untagged'
      const amt = parseAmount(row.amount)
      byTag[tag] = (byTag[tag] ?? 0) + amt
    })

    const entries = [...tags.map((t) => [t, byTag[t] ?? 0]), ['Untagged', byTag['Untagged'] ?? 0]]
    return entries.map(([tag, sum]) => ({ tag, sum }))
  }, [filteredRecords, recordTags, tags])

  const maxChartValue = useMemo(
    () => Math.max(1, ...chartData.map((d) => d.sum)),
    [chartData]
  )

  const chartTotal = useMemo(
    () => chartData.reduce((acc, d) => acc + d.sum, 0),
    [chartData]
  )

  const pieSlices = useMemo(() => {
    if (chartTotal <= 0) return []
    let currentAngle = 0
    const radius = 80
    const center = 100

    return chartData.map((item, index) => {
      const sliceAngle = (item.sum / chartTotal) * Math.PI * 2
      const startAngle = currentAngle
      const endAngle = currentAngle + sliceAngle
      const x1 = center + radius * Math.cos(startAngle)
      const y1 = center + radius * Math.sin(startAngle)
      const x2 = center + radius * Math.cos(endAngle)
      const y2 = center + radius * Math.sin(endAngle)
      const largeArcFlag = sliceAngle > Math.PI ? 1 : 0
      const path = `M ${center} ${center} L ${x1} ${y1} A ${radius} ${radius} 0 ${largeArcFlag} 1 ${x2} ${y2} Z`
      currentAngle = endAngle
      return {
        ...item,
        path,
        percentage: chartTotal ? (item.sum / chartTotal) * 100 : 0,
        color: `hsl(${(index * 69) % 360}, 70%, 54%)`,
      }
    })
  }, [chartData, chartTotal])

  const calendarData = useMemo(() => {
    const byDate = {}
    filteredRecords.forEach(({ row, originalIndex }) => {
      const date = normalizeDateValue(row.date)
      if (!date) return
      const tag = recordTags[originalIndex] ?? 'Untagged'
      const amt = parseAmount(row.amount)
      if (!byDate[date]) byDate[date] = {}
      byDate[date][tag] = (byDate[date][tag] || 0) + amt
    })
    return byDate
  }, [filteredRecords, recordTags])

  const calendarMonthData = useMemo(() => {
    if (!calendarViewMonth) return null

    const [year, month] = calendarViewMonth.split('-').map(Number)
    if (!year || !month) return null

    const daysInMonth = new Date(year, month, 0).getDate()
    const firstDayOfMonth = new Date(year, month - 1, 1).getDay() // 0 = Sunday

    const calendarDays = []

    // Add empty cells for days before the 1st
    for (let i = 0; i < firstDayOfMonth; i++) {
      calendarDays.push(null)
    }

    // Add days of the month
    for (let day = 1; day <= daysInMonth; day++) {
      const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
      const sumByTag = calendarData[dateStr] || {}
      calendarDays.push({ day, dateStr, sumByTag })
    }

    return { year, month, calendarDays }
  }, [calendarData, calendarViewMonth])

  const getTagShortcutKey = (tagIndex) =>
    tagIndex < TAG_SHORTCUT_KEYS.length ? TAG_SHORTCUT_KEYS[tagIndex].toUpperCase() : null

  const sortedTags = [...tags].sort()
  const allTagOptions = [...sortedTags, 'Untagged']

  const tagColors = useMemo(
    () =>
      Object.fromEntries(
        [...allTagOptions].map((tag, index) => [tag, `hsl(${(index * 69) % 360}, 70%, 54%)`])
      ),
    [allTagOptions]
  )

  const calendarLegendTags = allTagOptions

  const toggleTag = (tag) => {
    setSelectedTags((prev) =>
      prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]
    )
  }

  const handleSelectAll = (checked) => {
    setSelectedTags(checked ? allTagOptions : [])
  }

  useEffect(() => {
    if (calendarViewMonth !== null) return

    const firstDate = records
      .map((row) => normalizeDateValue(row.date))
      .filter(Boolean)
      .sort()[0]

    if (firstDate) {
      setCalendarViewMonth(firstDate.slice(0, 7))
    }
  }, [records, calendarViewMonth])

  const changeCalendarMonth = (delta) => {
    setCalendarViewMonth((current) => {
      const [year, month] = current ? current.split('-').map(Number) : [new Date().getFullYear(), new Date().getMonth() + 1]
      const next = new Date(year, month - 1, 1)
      next.setMonth(next.getMonth() + delta)
      return `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}`
    })
  }

  return (
    <div className="app">
      {showTagModal && (
        <div
          className="modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="tag-modal-title"
          onClick={(e) => e.target === e.currentTarget && setShowTagModal(false)}
        >
          <div className="modal-panel" onClick={(e) => e.stopPropagation()}>
            <h2 id="tag-modal-title" className="modal-title">
              Tags
            </h2>
            <div className="modal-tags-manage">
              <div className="modal-tags-input-row">
                <input
                  type="text"
                  value={newTagName}
                  onChange={(e) => setNewTagName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && addTag()}
                  placeholder="New tag name"
                  className="tag-input modal-tag-input"
                  aria-label="New tag name"
                />
                <button type="button" onClick={addTag} className="tag-add-btn">
                  Add
                </button>
              </div>
              {tags.length > 0 && (
                <ul className="modal-tags-list">
                  {tags.map((tag) => (
                    <li key={tag} className="tag-chip">
                      <span className="tag-chip-label">{tag}</span>
                      <button
                        type="button"
                        onClick={() => removeTag(tag)}
                        className="tag-chip-remove"
                        aria-label={`Remove ${tag}`}
                      >
                        ×
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <p className="modal-desc">
              {records.length > 0
                ? 'Go through each record and optionally apply tags. You can change tags later.'
                : 'Load a CSV file to tag records.'}
            </p>
            <div className="modal-record-view">
              <div className="modal-nav-row">
                <button
                  type="button"
                  onClick={() => setModalRecordIndex((i) => Math.max(0, i - 1))}
                  disabled={modalRecordIndex === 0 || records.length === 0}
                  className="modal-nav-btn"
                  aria-label="Previous record"
                >
                  ←
                </button>
                <span className="modal-record-counter">
                  Record {records.length > 0 ? modalRecordIndex + 1 : 0} of {records.length}
                </span>
                <button
                  type="button"
                  onClick={() =>
                    setModalRecordIndex((i) =>
                      Math.min(Math.max(0, records.length - 1), i + 1)
                    )
                  }
                  disabled={
                    modalRecordIndex >= records.length - 1 || records.length === 0
                  }
                  className="modal-nav-btn"
                  aria-label="Next record"
                >
                  →
                </button>
              </div>
              {records[modalRecordIndex] && (
                <>
                  <div className="modal-record-summary-block">
                    <span className="modal-record-label">Date</span>
                    <span className="modal-record-value">
                      {records[modalRecordIndex].date}
                    </span>
                    <span className="modal-record-label">Title</span>
                    <span className="modal-record-value">
                      {records[modalRecordIndex].title}
                    </span>
                    <span className="modal-record-label">Amount</span>
                    <span className="modal-record-value">
                      {records[modalRecordIndex].amount}
                    </span>
                  </div>
                  <div className="modal-record-tags">
                    <span className="modal-tags-label">Tag (press key to assign, same key to clear)</span>
                    <div className="modal-tag-checks" role="radiogroup" aria-label="Tag">
                      {tags.map((tag, tagIndex) => {
                        const shortcut = getTagShortcutKey(tagIndex)
                        return (
                          <label key={tag} className="modal-tag-check">
                            <input
                              type="radio"
                              name={`record-tag-${modalRecordIndex}`}
                              checked={hasRecordTag(modalRecordIndex, tag)}
                              onChange={() =>
                                toggleRecordTag(modalRecordIndex, tag)
                              }
                              className="tag-radio"
                            />
                            <span>{tag}</span>
                            {shortcut && (
                              <kbd className="modal-tag-kbd" aria-label={`Shortcut: ${shortcut}`}>
                                {shortcut}
                              </kbd>
                            )}
                          </label>
                        )
                      })}
                      <label key="_none" className="modal-tag-check">
                        <input
                          type="radio"
                          name={`record-tag-${modalRecordIndex}`}
                          checked={!getRecordTag(modalRecordIndex)}
                          onChange={() => setRecordTag(modalRecordIndex, null)}
                          className="tag-radio"
                        />
                        <span>None</span>
                      </label>
                    </div>
                  </div>
                </>
              )}
            </div>
            <div className="modal-actions">
              <button
                type="button"
                onClick={() => setShowTagModal(false)}
                className="modal-done-btn"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}
      <header className="app-header">
        <h1> 🙓 mint </h1>
      </header>
      <div className="upload-section">
        <label className="file-label">
          <input
            type="file"
            accept=".csv"
            onChange={handleFileChange}
            className="file-input"
          />
          Add CSV File
        </label>
        <p className="hint">CSV must include columns: Date, Title, Amount</p>
      </div>

      {error && <p className="error">{error}</p>}
      {records.length > 0 && (
        <div className="table-actions">
          <div className="table-filter">
            <span className="filter-label">Filter by tag</span>
            <div className="filter-checkboxes">
              <label className="filter-checkbox">
                <input
                  type="checkbox"
                  checked={selectedTags.length === allTagOptions.length}
                  onChange={(e) => handleSelectAll(e.target.checked)}
                />
                All
              </label>
              {sortedTags.map((tag) => (
                <label key={tag} className="filter-checkbox">
                  <input
                    type="checkbox"
                    checked={selectedTags.includes(tag)}
                    onChange={() => toggleTag(tag)}
                  />
                  {tag}
                </label>
              ))}
              <label className="filter-checkbox">
                <input
                  type="checkbox"
                  checked={selectedTags.includes('Untagged')}
                  onChange={() => toggleTag('Untagged')}
                />
                Untagged
              </label>
            </div>
          </div>
          <div className="date-filters-row">
            <div className="table-filter">
              <label htmlFor="date-from-filter" className="filter-label">
                Date from
              </label>
              <input
                id="date-from-filter"
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                className="filter-date-input"
              />
            </div>
            <div className="table-filter">
              <label htmlFor="date-to-filter" className="filter-label">
                Date to
              </label>
              <input
                id="date-to-filter"
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                className="filter-date-input"
              />
            </div>
          </div>
        </div>
      )}
      {records.length > 0 && (
        <>
          <div className="table-wrap">
            <table className="records-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Title</th>
                  <th>Amount</th>
                  <th>Tag</th>
                </tr>
              </thead>
              <tbody>
                {filteredRecords.map(({ row, originalIndex }) => (
                  <tr
                    key={originalIndex}
                    onClick={() => {
                      setModalRecordIndex(originalIndex)
                      setShowTagModal(true)
                    }}
                    className="table-row-clickable"
                  >
                    <td>{row.date}</td>
                    <td>{row.title}</td>
                    <td>{row.amount}</td>
                    <td className="tag-cell tag-cell-readonly">
                      {getRecordTag(originalIndex) ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className={`chart-section ${chartMode === 'calendar' ? 'chart-section--calendar' : ''}`}>
            <div className="chart-tabs" role="tablist" aria-label="Chart view">
              <button
                type="button"
                role="tab"
                aria-selected={chartMode === 'bar'}
                className={`chart-tab ${chartMode === 'bar' ? 'active' : ''}`}
                onClick={() => setChartMode('bar')}
              >
                Bar Chart
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={chartMode === 'pie'}
                className={`chart-tab ${chartMode === 'pie' ? 'active' : ''}`}
                onClick={() => setChartMode('pie')}
              >
                Pie Chart
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={chartMode === 'calendar'}
                className={`chart-tab ${chartMode === 'calendar' ? 'active' : ''}`}
                onClick={() => setChartMode('calendar')}
              >
                Calendar
              </button>
            </div>

            {chartMode === 'bar' ? (
              <div className="chart-bars">
                {chartData.map(({ tag, sum }) => (
                  <div key={tag} className="chart-bar-wrap">
                    <div className="chart-bar-container">
                      <div
                        className="chart-bar"
                        style={{
                          height: `${(sum / maxChartValue) * 100}%`,
                        }}
                        title={`${tag}: ${sum.toFixed(2)}`}
                      />
                    </div>
                    <span className="chart-bar-label">{tag}</span>
                    <span className="chart-bar-value">{sum.toFixed(2)}</span>
                  </div>
                ))}
              </div>
            ) : chartMode === 'pie' ? (
              <div className="pie-chart-section">
                {chartTotal <= 0 ? (
                  <p>No data to display in pie chart.</p>
                ) : (
                  <div className="pie-chart-wrap">
                    <svg viewBox="0 0 200 200" width="200" height="200" className="pie-chart">
                      {pieSlices.map(({ tag, path, color }) => (
                        <path key={tag} d={path} fill={color} stroke="#fff" strokeWidth="1" />
                      ))}
                      <circle cx="100" cy="100" r="40" fill="#fff" />
                    </svg>
                    <div className="pie-legend">
                      {pieSlices.map(({ tag, percentage, color }) => (
                        <div key={tag} className="pie-legend-item">
                          <span className="pie-legend-color" style={{ backgroundColor: color }} />
                          <span>
                            {tag}: {percentage.toFixed(1)}%
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="calendar-section">
                {!calendarMonthData ? (
                  <p>No data to display in calendar view.</p>
                ) : (
                  <div className="calendar-container">
                    <div className="calendar-nav-row">
                      <button
                        type="button"
                        onClick={() => changeCalendarMonth(-1)}
                        className="calendar-nav-btn"
                        aria-label="Previous month"
                      >
                        ←
                      </button>
                      <h4 className="calendar-month">
                        {new Date(calendarMonthData.year, calendarMonthData.month - 1).toLocaleDateString('en-US', { year: 'numeric', month: 'long' })}
                      </h4>
                      <button
                        type="button"
                        onClick={() => changeCalendarMonth(1)}
                        className="calendar-nav-btn"
                        aria-label="Next month"
                      >
                        →
                      </button>
                    </div>
                    <div className="calendar-content">
                      <div className="calendar-grid">
                        {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(day => (
                          <div key={day} className="calendar-header">{day}</div>
                        ))}
                        {calendarMonthData.calendarDays.map((dayData, index) => (
                          <div key={index} className={`calendar-day ${!dayData ? 'empty' : ''}`}>
                            {dayData ? (
                              <>
                                <div className="calendar-day-number">{dayData.day}</div>
                                {Object.entries(dayData.sumByTag).map(([tag, sum]) =>
                                  sum ? (
                                    <div
                                      key={tag}
                                      className="calendar-day-tag"
                                      style={{ color: tagColors[tag] || 'inherit' }}
                                    >
                                      {sum.toFixed(2)}
                                    </div>
                                  ) : null
                                )}
                              </>
                            ) : null}
                          </div>
                        ))}
                      </div>
                      <div className="calendar-legend">
                        {calendarLegendTags.map((tag) => (
                          <div key={tag} className="calendar-legend-item">
                            <span
                              className="calendar-legend-color"
                              style={{ backgroundColor: tagColors[tag] }}
                            />
                            <span>{tag}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}

export default App
