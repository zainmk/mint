import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import './App.css'

// ── Utilities ──────────────────────────────────────────────────────────────

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
  return `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, '0')}-${String(parsed.getDate()).padStart(2, '0')}`
}

// Stable identity key for a record — used as recordTags map key
function makeRecordId(record) {
  return `${String(record.date || '').trim()}||${String(record.title || '').trim()}||${String(record.amount || '').trim()}`
}

const TAG_SHORTCUT_KEYS = 'qwertyuiop'
const TAG_COLORS = ['#2d8a6e', '#e07b54', '#5b8dd9', '#d4a843', '#9b59b6', '#e74c6e', '#1abc9c', '#e67e22']

// ── IndexedDB ──────────────────────────────────────────────────────────────

const DB_NAME = 'mint-db'
const DB_VERSION = 1
const STORE_NAME = 'mint-store'
const DATA_KEY = 'mint-data'
const DIR_HANDLE_KEY = 'mint-dir-handle'

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onerror = () => reject(req.error)
    req.onsuccess = () => resolve(req.result)
    req.onupgradeneeded = (e) => e.target.result.createObjectStore(STORE_NAME)
  })
}

async function idbGet(key) {
  try {
    const db = await openDB()
    return new Promise((resolve) => {
      const req = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(key)
      req.onsuccess = () => { db.close(); resolve(req.result ?? null) }
      req.onerror = () => { db.close(); resolve(null) }
    })
  } catch { return null }
}

async function idbPut(key, value) {
  try {
    const db = await openDB()
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      tx.objectStore(STORE_NAME).put(value, key)
      tx.oncomplete = () => { db.close(); resolve() }
      tx.onerror = () => { db.close(); resolve() }
    })
  } catch {}
}

// ── Folder helpers ─────────────────────────────────────────────────────────

async function scanFolderForCsvs(dirHandle) {
  const entries = []
  for await (const [name, entry] of dirHandle.entries()) {
    if (entry.kind === 'file' && name.toLowerCase().endsWith('.csv')) {
      entries.push({ name, handle: entry })
    }
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name))
}

async function readCsvFiles(csvEntries) {
  const all = []
  const seen = new Set()
  for (const { name, handle } of csvEntries) {
    try {
      const file = await handle.getFile()
      const text = await file.text()
      for (const rec of parseCSV(text)) {
        const id = makeRecordId(rec)
        if (!seen.has(id) && parseAmount(rec.amount) >= 0) {
          seen.add(id)
          all.push({ ...rec, _id: id, _source: name })
        }
      }
    } catch { /* skip unreadable file */ }
  }
  return all
}

async function loadMintDataFromFolder(dirHandle) {
  try {
    const fh = await dirHandle.getFileHandle('mint-data.json')
    return JSON.parse(await (await fh.getFile()).text())
  } catch { return null }
}

async function saveMintDataToFolder(dirHandle, data) {
  try {
    const fh = await dirHandle.getFileHandle('mint-data.json', { create: true })
    const w = await fh.createWritable()
    await w.write(JSON.stringify({ version: 2, lastModified: new Date().toISOString(), ...data }))
    await w.close()
  } catch {}
}

// ── CSV parsing / export ───────────────────────────────────────────────────

function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/)
  if (lines.length < 2) return []
  const parseRow = (line) => {
    const vals = []
    let cur = '', inQ = false
    for (const c of line) {
      if (c === '"') inQ = !inQ
      else if (c === ',' && !inQ) { vals.push(cur.trim()); cur = '' }
      else cur += c
    }
    vals.push(cur.trim())
    return vals
  }
  const hdr = parseRow(lines[0]).map((h) => h.replace(/^"|"$/g, '').trim())
  const di = hdr.findIndex((h) => /date/i.test(h))
  const ti = hdr.findIndex((h) => /title/i.test(h))
  const ai = hdr.findIndex((h) => /amount/i.test(h))
  if (di === -1 || ti === -1 || ai === -1) return []
  return lines.slice(1).map((line) => {
    const v = parseRow(line)
    return { date: v[di] ?? '', title: v[ti] ?? '', amount: v[ai] ?? '' }
  })
}

// ── App ────────────────────────────────────────────────────────────────────

function App() {
  // Records are ephemeral — always re-read from CSVs in the chosen folder.
  // Only tags and recordTags (keyed by makeRecordId) are persisted.
  const [records, setRecords] = useState([])
  const [tags, setTags] = useState([])
  const [recordTags, setRecordTags] = useState({})   // { [recordId]: tagName }

  // Folder state
  const [dirHandle, setDirHandle] = useState(null)
  const [reconnectHandle, setReconnectHandle] = useState(null) // handle awaiting user permission gesture

  // UI state
  const [isLoaded, setIsLoaded] = useState(false)
  const [isScanning, setIsScanning] = useState(false)
  const [csvCount, setCsvCount] = useState(0)
  const [csvFiles, setCsvFiles] = useState([])
  const [showFolderPopover, setShowFolderPopover] = useState(false)
  const [error, setError] = useState(null)
  const [dateParseWarning, setDateParseWarning] = useState(null)

  // Tagging modal — modalRecords is a frozen snapshot of filteredRecords taken when the modal opens
  const [showTagModal, setShowTagModal] = useState(false)
  const [modalRecordIndex, setModalRecordIndex] = useState(0)
  const [modalRecords, setModalRecords] = useState([])
  const [newTagName, setNewTagName] = useState('')
  // Filters & charts
  const [selectedTags, setSelectedTags] = useState([])
  const [dateFrom, setDateFrom] = useState(
    new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
  )
  const [dateTo, setDateTo] = useState(new Date().toISOString().split('T')[0])
  const [chartMode, setChartMode] = useState('bar')
  const [calendarViewMonth, setCalendarViewMonth] = useState(null)

  const saveTimerRef = useRef(null)
  const dirHandleRef = useRef(null)

  useEffect(() => { dirHandleRef.current = dirHandle }, [dirHandle])

  useEffect(() => {
    if (!showFolderPopover) return
    const close = (e) => { if (!e.target.closest('.folder-badge-wrap')) setShowFolderPopover(false) }
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [showFolderPopover])

  // ── Initial load ──────────────────────────────────────────────────────────

  useEffect(() => {
    async function init() {
      // Load cached meta (tags + recordTags) from IDB for fast startup
      const cached = await idbGet(DATA_KEY)
      const cachedTags = Array.isArray(cached?.tags) ? cached.tags : []
      const cachedRecordTags = (cached?.recordTags && !Array.isArray(cached.recordTags)) ? cached.recordTags : {}
      setTags(cachedTags)
      setRecordTags(cachedRecordTags)

      // Restore directory handle
      const handle = await idbGet(DIR_HANDLE_KEY)
      if (handle) {
        // queryPermission doesn't require a user gesture; requestPermission might
        const perm = await handle.queryPermission({ mode: 'readwrite' })
        if (perm === 'granted') {
          setDirHandle(handle)
          dirHandleRef.current = handle
          await doLoadFromFolder(handle, { tags: cachedTags, recordTags: cachedRecordTags }, true)
        } else {
          // Permission needs to be re-requested via user gesture — show reconnect screen
          setReconnectHandle(handle)
        }
      }

      setIsLoaded(true)
    }
    init()
  }, [])

  // ── Debounced save (tags + recordTags only — records come from CSVs) ──────

  useEffect(() => {
    if (!isLoaded) return
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => {
      const meta = { tags, recordTags }
      idbPut(DATA_KEY, meta)
      if (dirHandleRef.current) saveMintDataToFolder(dirHandleRef.current, meta)
    }, 300)
  }, [isLoaded, tags, recordTags])

  // ── Folder loading ─────────────────────────────────────────────────────────

  async function doLoadFromFolder(handle, existingMeta, openModal = false) {
    setIsScanning(true)
    setError(null)
    try {
      const csvEntries = await scanFolderForCsvs(handle)
      setCsvCount(csvEntries.length)
      setCsvFiles(csvEntries.map((e) => e.name))

      if (csvEntries.length === 0) { setRecords([]); return }

      const newRecords = await readCsvFiles(csvEntries)

      const badDates = newRecords.filter((r) => !normalizeDateValue(r.date)).length
      setDateParseWarning(badDates > 0 ? badDates : null)

      // Folder's mint-data.json takes priority over IDB cache
      const folderData = await loadMintDataFromFolder(handle)
      const resolvedTags = Array.isArray(folderData?.tags) ? folderData.tags : (existingMeta?.tags ?? [])
      const resolvedRecordTags = (folderData?.recordTags && !Array.isArray(folderData.recordTags))
        ? folderData.recordTags : (existingMeta?.recordTags ?? {})

      setRecords(newRecords)
      setTags(resolvedTags)
      setRecordTags(resolvedRecordTags)
      setSelectedTags([...resolvedTags, 'Untagged'])

      if (openModal && newRecords.length > 0) {
        setModalRecordIndex(0)
        setShowTagModal(true)
      }
    } catch {
      setError('Failed to read folder contents.')
    } finally {
      setIsScanning(false)
    }
  }

  // ── Choose folder (initial or change) ─────────────────────────────────────

  const handleChooseFolder = async () => {
    if (!window.showDirectoryPicker) {
      setError('Your browser does not support folder access. Use Chrome 86+ or Edge 86+.')
      return
    }
    try {
      const handle = await window.showDirectoryPicker({ mode: 'readwrite' })
      setDirHandle(handle)
      setReconnectHandle(null)
      dirHandleRef.current = handle
      await idbPut(DIR_HANDLE_KEY, handle)
      await doLoadFromFolder(handle, { tags, recordTags }, true)
    } catch (e) {
      if (e?.name !== 'AbortError') setError('Could not access the selected folder.')
    }
  }

  // ── Reconnect (needs user gesture to re-grant permission) ─────────────────

  const handleReconnect = async () => {
    if (!reconnectHandle) return
    try {
      const perm = await reconnectHandle.requestPermission({ mode: 'readwrite' })
      if (perm === 'granted') {
        setDirHandle(reconnectHandle)
        dirHandleRef.current = reconnectHandle
        setReconnectHandle(null)
        await doLoadFromFolder(reconnectHandle, { tags, recordTags }, true)
      } else {
        setError('Permission denied. Try choosing the folder again.')
      }
    } catch {
      setError('Could not reconnect to folder.')
    }
  }

  // ── Refresh (re-scan folder for new/changed CSVs) ─────────────────────────

  const handleRefresh = async () => {
    if (!dirHandleRef.current) return
    try {
      const perm = await dirHandleRef.current.requestPermission({ mode: 'readwrite' })
      if (perm !== 'granted') { setError('Permission denied.'); return }
      await doLoadFromFolder(dirHandleRef.current, { tags, recordTags })
    } catch {
      setError('Could not refresh folder contents.')
    }
  }

  // ── Tag operations (keyed by record._id, not array index) ─────────────────

  const getRecordTag = (rec) => {
    return rec ? (recordTags[rec._id] ?? null) : null
  }

  const hasRecordTag = (rec, tag) => rec ? recordTags[rec._id] === tag : false

  const toggleRecordTag = (rec, tag) => {
    if (!rec) return
    setRecordTags((prev) => {
      const n = { ...prev }
      if (n[rec._id] === tag) delete n[rec._id]; else n[rec._id] = tag
      return n
    })
  }

  const setRecordTag = (rec, tag) => {
    if (!rec) return
    setRecordTags((prev) => {
      const n = { ...prev }
      if (tag == null) delete n[rec._id]; else n[rec._id] = tag
      return n
    })
  }

  const addTag = () => {
    const name = newTagName.trim()
    if (!name || tags.includes(name)) return
    setTags((t) => [...t, name])
    setSelectedTags((prev) => [...prev, name])
    setNewTagName('')
  }

  const removeTag = (tag) => {
    setTags((t) => t.filter((x) => x !== tag))
    setRecordTags((prev) => {
      const n = { ...prev }
      for (const k of Object.keys(n)) { if (n[k] === tag) delete n[k] }
      return n
    })
  }


  // ── Derived state ──────────────────────────────────────────────────────────

  const sortedTags = [...tags].sort()
  const allTagOptions = [...sortedTags, 'Untagged']

  const tagColors = useMemo(
    () => Object.fromEntries(allTagOptions.map((t, i) => [t, TAG_COLORS[i % TAG_COLORS.length]])),
    [allTagOptions]
  )

  const filteredRecords = useMemo(() => {
    const from = normalizeDateValue(dateFrom)
    const to = normalizeDateValue(dateTo)
    return records
      .map((row, i) => ({ row, originalIndex: i }))
      .filter(({ row }) => {
        const tag = recordTags[row._id] ?? null
        if (selectedTags.length > 0) {
          const untaggedSel = selectedTags.includes('Untagged')
          if (!(untaggedSel && tag == null || (tag && selectedTags.includes(tag)))) return false
        }
        if (!from && !to) return true
        const d = normalizeDateValue(row.date)
        if (!d) return false
        if (from && d < from) return false
        if (to && d > to) return false
        return true
      })
      .sort((a, b) => {
        const da = normalizeDateValue(a.row.date) ?? ''
        const db = normalizeDateValue(b.row.date) ?? ''
        return db < da ? -1 : db > da ? 1 : 0
      })
  }, [records, selectedTags, dateFrom, dateTo, recordTags])

  // ── Keyboard handler (modal) ───────────────────────────────────────────────

  useEffect(() => {
    if (!showTagModal) return
    const onKey = (e) => {
      const active = document.activeElement
      if (active?.tagName === 'INPUT' || active?.tagName === 'TEXTAREA') return
      if (e.key === 'Escape') { setShowTagModal(false); return }
      if (e.key === 'ArrowLeft') { e.preventDefault(); setModalRecordIndex((i) => Math.max(0, i - 1)); return }
      if (e.key === 'ArrowRight') { e.preventDefault(); setModalRecordIndex((i) => Math.min(modalRecords.length - 1, i + 1)); return }
      const key = e.key.toLowerCase()
      if (TAG_SHORTCUT_KEYS.includes(key)) {
        const tagIndex = TAG_SHORTCUT_KEYS.indexOf(key)
        if (tagIndex < tags.length) { e.preventDefault(); toggleRecordTag(modalRecords[modalRecordIndex]?.row, tags[tagIndex]) }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [showTagModal, modalRecordIndex, tags, modalRecords])


  const chartData = useMemo(() => {
    const by = {}
    tags.forEach((t) => { by[t] = 0 })
    by['Untagged'] = 0
    filteredRecords.forEach(({ row }) => {
      const t = recordTags[row._id] ?? 'Untagged'
      by[t] = (by[t] ?? 0) + parseAmount(row.amount)
    })
    return [...tags.map((t) => [t, by[t] ?? 0]), ['Untagged', by['Untagged'] ?? 0]]
      .sort((a, b) => b[1] - a[1])
      .map(([tag, sum]) => ({ tag, sum }))
  }, [filteredRecords, recordTags, tags])

  const maxChartValue = useMemo(() => Math.max(1, ...chartData.map((d) => d.sum)), [chartData])
  const chartTotal = useMemo(() => chartData.reduce((a, d) => a + d.sum, 0), [chartData])

  const pieSlices = useMemo(() => {
    if (chartTotal <= 0) return []
    let a = 0
    return chartData.map((item, i) => {
      const s = (item.sum / chartTotal) * Math.PI * 2
      const x1 = 100 + 80 * Math.cos(a), y1 = 100 + 80 * Math.sin(a)
      a += s
      const x2 = 100 + 80 * Math.cos(a), y2 = 100 + 80 * Math.sin(a)
      return {
        ...item,
        path: `M 100 100 L ${x1} ${y1} A 80 80 0 ${s > Math.PI ? 1 : 0} 1 ${x2} ${y2} Z`,
        percentage: (item.sum / chartTotal) * 100,
        color: tagColors[item.tag] ?? TAG_COLORS[i % TAG_COLORS.length],
      }
    })
  }, [chartData, chartTotal, tagColors])

  const calendarData = useMemo(() => {
    const by = {}
    filteredRecords.forEach(({ row }) => {
      const d = normalizeDateValue(row.date)
      if (!d) return
      const tag = recordTags[row._id] ?? 'Untagged'
      if (!by[d]) by[d] = {}
      by[d][tag] = (by[d][tag] || 0) + parseAmount(row.amount)
    })
    return by
  }, [filteredRecords, recordTags])

  const calendarMonthData = useMemo(() => {
    let vm = calendarViewMonth
    if (vm && filteredRecords.length > 0) {
      const has = filteredRecords.some(({ row }) => { const d = normalizeDateValue(row.date); return d && d.slice(0, 7) === vm })
      if (!has) { const f = filteredRecords.map(({ row }) => normalizeDateValue(row.date)).filter(Boolean).sort()[0]; if (f) vm = f.slice(0, 7) }
    }
    if (!vm) return null
    const [year, month] = vm.split('-').map(Number)
    if (!year || !month) return null
    const dim = new Date(year, month, 0).getDate()
    const fd = new Date(year, month - 1, 1).getDay()
    const days = []
    for (let i = 0; i < fd; i++) days.push(null)
    for (let d = 1; d <= dim; d++) {
      const ds = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`
      days.push({ day: d, dateStr: ds, sumByTag: calendarData[ds] || {} })
    }
    return { year, month, calendarDays: days }
  }, [calendarData, calendarViewMonth, filteredRecords])

  useEffect(() => {
    if (calendarViewMonth !== null) return
    const first = records.map((r) => normalizeDateValue(r.date)).filter(Boolean).sort()[0]
    if (first) setCalendarViewMonth(first.slice(0, 7))
  }, [records, calendarViewMonth])

  const recordMonths = useMemo(() => {
    const months = records.map((r) => normalizeDateValue(r.date)?.slice(0, 7)).filter(Boolean)
    if (!months.length) return { min: null, max: null }
    months.sort()
    return { min: months[0], max: months[months.length - 1] }
  }, [records])

  const changeCalendarMonth = (delta) =>
    setCalendarViewMonth((cur) => {
      const [y, m] = cur ? cur.split('-').map(Number) : [new Date().getFullYear(), new Date().getMonth() + 1]
      const n = new Date(y, m - 1 + delta, 1)
      const next = `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}`
      if (recordMonths.min && next < recordMonths.min) return cur
      if (recordMonths.max && next > recordMonths.max) return cur
      return next
    })

  const toggleTag = (tag) =>
    setSelectedTags((prev) => prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag])

  const handleSelectAll = (checked) => setSelectedTags(checked ? allTagOptions : [])

  const getTagShortcutKey = (i) => i < TAG_SHORTCUT_KEYS.length ? TAG_SHORTCUT_KEYS[i].toUpperCase() : null

  // Progress
  const totalCount = records.length

  // ── Render: pre-folder screens ─────────────────────────────────────────────

  if (!isLoaded) {
    return (
      <div className="app app--centered">
        <h1 className="splash-title">🌿 mint</h1>
        <p className="loading-text">Loading…</p>
      </div>
    )
  }

  // Folder in IDB but permission needs re-granting (requires user gesture)
  if (reconnectHandle && !dirHandle) {
    return (
      <div className="app app--centered">
        <header className="app-header"><h1>🌿 mint</h1></header>
        {error && <p className="error">{error}</p>}
        <div className="onboard-card">
          <div className="onboard-icon">🔒</div>
          <h2 className="onboard-title">Reconnect to folder</h2>
          <p className="onboard-desc">
            Mint needs your permission to access <strong>{reconnectHandle.name}</strong> again.
          </p>
          <button type="button" className="onboard-btn" onClick={handleReconnect}>
            Grant access
          </button>
          <button type="button" className="onboard-alt-btn" onClick={() => { setReconnectHandle(null) }}>
            Choose a different folder
          </button>
        </div>
      </div>
    )
  }

  // No folder chosen yet — onboarding
  if (!dirHandle) {
    return (
      <div className="app app--centered">
        <header className="app-header"><h1>🌿 mint</h1></header>
        {error && <p className="error">{error}</p>}
        <div className="onboard-card">
          <div className="onboard-icon">📂</div>
          <h2 className="onboard-title">Choose your data folder</h2>
          <p className="onboard-desc">
            Mint reads all CSV files from a folder on your device and keeps your tags synced there automatically. Nothing leaves your machine.
          </p>
          <button type="button" className="onboard-btn" onClick={handleChooseFolder}>
            Choose Folder
          </button>
          {!window.showDirectoryPicker && (
            <p className="onboard-compat">Requires Chrome 86+ or Edge 86+</p>
          )}
          <ul className="onboard-hints">
            <li>Drop bank CSV exports into one folder</li>
            <li>Mint reads all CSVs and deduplicates records</li>
            <li>Tags sync back to the same folder as <code>mint-data.json</code></li>
          </ul>
        </div>
      </div>
    )
  }

  // Scanning
  if (isScanning) {
    return (
      <div className="app app--centered">
        <header className="app-header"><h1>🌿 mint</h1></header>
        <p className="loading-text">Reading folder…</p>
      </div>
    )
  }

  // ── Render: main app ───────────────────────────────────────────────────────

  return (
    <div className="app">
      {/* Tag Modal */}
      {showTagModal && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="tag-modal-title"
          onClick={(e) => e.target === e.currentTarget && setShowTagModal(false)}>
          <div className="modal-panel" onClick={(e) => e.stopPropagation()}>
            <h2 id="tag-modal-title" className="modal-title">Tags</h2>

            <div className="modal-tags-manage">
              <div className="modal-tags-input-row">
                <input type="text" value={newTagName} onChange={(e) => setNewTagName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && addTag()} placeholder="New tag name"
                  className="tag-input modal-tag-input" aria-label="New tag name" />
                <button type="button" onClick={addTag} className="tag-add-btn">Add</button>
              </div>
              {tags.length > 0 && (
                <ul className="modal-tags-list">
                  {tags.map((tag) => (
                    <li key={tag} className="tag-chip">
                      <span className="tag-chip-label">{tag}</span>
                      <button type="button" onClick={() => removeTag(tag)} className="tag-chip-remove" aria-label={`Remove ${tag}`}>×</button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <p className="modal-desc">
              {modalRecords.length > 0 ? 'Go through each record and optionally apply tags. You can change tags later.' : 'No records match the current filters.'}
            </p>

            <div className="modal-record-view">
              <div className="modal-nav-row">
                <button type="button" onClick={() => setModalRecordIndex((i) => Math.max(0, i - 1))}
                  disabled={modalRecordIndex === 0 || modalRecords.length === 0} className="modal-nav-btn" aria-label="Previous record">←</button>
                <span className="modal-record-counter">Record {modalRecords.length > 0 ? modalRecordIndex + 1 : 0} of {modalRecords.length}</span>
                <button type="button" onClick={() => setModalRecordIndex((i) => Math.min(Math.max(0, modalRecords.length - 1), i + 1))}
                  disabled={modalRecordIndex >= modalRecords.length - 1 || modalRecords.length === 0} className="modal-nav-btn" aria-label="Next record">→</button>
              </div>

              {modalRecords[modalRecordIndex]?.row && (
                <>
                  <div className="modal-record-summary-block">
                    <span className="modal-record-label">DATE</span>
                    <span className="modal-record-value">{modalRecords[modalRecordIndex].row.date}</span>
                    <span className="modal-record-label">TITLE</span>
                    <span className="modal-record-value">{modalRecords[modalRecordIndex].row.title}</span>
                    <span className="modal-record-label">AMOUNT</span>
                    <span className="modal-record-value">{modalRecords[modalRecordIndex].row.amount}</span>
                  </div>

                  <div className="modal-record-tags">
                    <span className="modal-tags-label">TAG (PRESS KEY TO ASSIGN, SAME KEY TO CLEAR)</span>
                    <div className="modal-tag-checks" role="radiogroup" aria-label="Tag">
                      {tags.map((tag, tagIndex) => {
                        const shortcut = getTagShortcutKey(tagIndex)
                        return (
                          <label key={tag} className="modal-tag-check">
                            <input type="radio" name={`record-tag-${modalRecordIndex}`}
                              checked={hasRecordTag(modalRecords[modalRecordIndex]?.row, tag)}
                              onChange={() => toggleRecordTag(modalRecords[modalRecordIndex]?.row, tag)} className="tag-radio" />
                            <span>{tag}</span>
                            {shortcut && <kbd className="modal-tag-kbd" aria-label={`Shortcut: ${shortcut}`}>{shortcut}</kbd>}
                          </label>
                        )
                      })}
                      <label className="modal-tag-check">
                        <input type="radio" name={`record-tag-${modalRecordIndex}`}
                          checked={!getRecordTag(modalRecords[modalRecordIndex]?.row)}
                          onChange={() => setRecordTag(modalRecords[modalRecordIndex]?.row, null)} className="tag-radio" />
                        <span>None</span>
                      </label>
                    </div>
                  </div>
                </>
              )}
            </div>

            <div className="modal-actions">
              <button type="button" onClick={() => setShowTagModal(false)} className="modal-done-btn">Done</button>
            </div>
          </div>
        </div>
      )}

      {/* Header */}
      <header className="app-header">
        <h1>🌿 mint</h1>
        <div className="folder-badge-wrap">
          <button type="button" className="folder-badge" onClick={() => setShowFolderPopover((v) => !v)} title="Show loaded files">
            <span className="folder-badge-icon">📂</span>
            <span className="folder-badge-name">{dirHandle?.name}</span>
          </button>
          <button type="button" className="refresh-btn" onClick={handleRefresh} title="Re-scan folder for CSV changes">↺</button>
          {showFolderPopover && (
            <div className="folder-popover">
              <div className="folder-popover-title">{csvFiles.length} CSV file{csvFiles.length !== 1 ? 's' : ''} loaded</div>
              <ul className="folder-popover-list">
                {csvFiles.map((f) => <li key={f} className="folder-popover-item">{f}</li>)}
              </ul>
            </div>
          )}
        </div>
      </header>

      {error && <p className="error">{error}</p>}

      {dateParseWarning && (
        <div className="date-warning">
          <span>{dateParseWarning} record{dateParseWarning > 1 ? 's' : ''} had unreadable dates and will be excluded from date filters.</span>
          <button type="button" className="date-warning-dismiss" onClick={() => setDateParseWarning(null)}>✕</button>
        </div>
      )}

      {/* No CSV files in folder */}
      {csvCount === 0 && (
        <div className="empty-state empty-state--main">
          <div className="empty-state-icon">📄</div>
          <p className="empty-state-title">No CSV files in this folder</p>
          <p className="empty-state-sub">Add CSV files to <strong>{dirHandle?.name}</strong>, then click ↺ to refresh.</p>
          <button type="button" className="onboard-alt-btn" onClick={handleChooseFolder} style={{ marginTop: '0.75rem' }}>
            Change folder
          </button>
        </div>
      )}


      {records.length > 0 && (
        <>
          <div className="table-actions">
            <div className="table-filter">
              <span className="filter-label">Tags</span>
              <div className="filter-checkboxes">
                <label className="filter-checkbox">
                  <input type="checkbox" checked={selectedTags.length === allTagOptions.length} onChange={(e) => handleSelectAll(e.target.checked)} />
                  All
                </label>
                {sortedTags.map((tag) => (
                  <label key={tag} className="filter-checkbox">
                    <input type="checkbox" checked={selectedTags.includes(tag)} onChange={() => toggleTag(tag)} />
                    {tag}
                  </label>
                ))}
                <label className="filter-checkbox">
                  <input type="checkbox" checked={selectedTags.includes('Untagged')} onChange={() => toggleTag('Untagged')} />
                  Untagged
                </label>
              </div>
            </div>
            <div className="date-filters-row">
              <div className="table-filter">
                <label htmlFor="date-from-filter" className="filter-label">From</label>
                <input id="date-from-filter" type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="filter-date-input" />
              </div>
              <div className="table-filter">
                <label htmlFor="date-to-filter" className="filter-label">To</label>
                <input id="date-to-filter" type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="filter-date-input" />
              </div>
            </div>
          </div>

          {filteredRecords.length === 0 && (
            <div className="empty-state">
              <p className="empty-state-text">No transactions match these filters.</p>
              <button type="button" className="empty-state-link" onClick={() => handleSelectAll(true)}>Clear filters</button>
            </div>
          )}

          {filteredRecords.length > 0 && (<div className="table-wrap">
            <table className="records-table">
              <thead>
                <tr><th>Date</th><th>Title</th><th>Amount</th><th>Tag</th></tr>
              </thead>
              <tbody>
                {filteredRecords.map(({ row, originalIndex }, filteredIndex) => {
                  const rowTag = getRecordTag(row)
                  return (
                    <tr key={originalIndex} className="table-row-clickable"
                      onClick={() => { setModalRecords([...filteredRecords]); setModalRecordIndex(filteredIndex); setShowTagModal(true) }}>
                      <td className="td-date">{row.date}</td>
                      <td className="td-title">{row.title}</td>
                      <td className={`td-amount ${parseAmount(row.amount) >= 0 ? 'amount--positive' : 'amount--negative'}`}>{row.amount}</td>
                      <td className="tag-cell">
                        {rowTag
                          ? <span className="tag-pill" style={{ '--tag-color': tagColors[rowTag] }}>{rowTag}</span>
                          : <span className="tag-pill tag-pill--empty">—</span>}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>)}

          <div className={`chart-section${chartMode === 'calendar' ? ' chart-section--calendar' : ''}`}>
            <div className="chart-tabs" role="tablist">
              {[['bar', '▯'], ['pie', '⊗'], ['calendar', '🗓']].map(([mode, icon]) => (
                <button key={mode} role="tab" aria-selected={chartMode === mode}
                  className={`chart-tab${chartMode === mode ? ' active' : ''}`} onClick={() => setChartMode(mode)}>
                  <span className="chart-tab-icon">{icon}</span>
                </button>
              ))}
            </div>

            {chartMode === 'bar' && (
              <div className="chart-bars">
                {chartData.map(({ tag, sum }) => (
                  <div key={tag} className="chart-bar-wrap">
                    <div className="chart-bar-container">
                      <div className="chart-bar" style={{ height: `${(sum / maxChartValue) * 100}%`, backgroundColor: tagColors[tag] || '#2d8a6e' }} title={`${tag}: ${sum.toFixed(2)}`} />
                    </div>
                    <span className="chart-bar-label">{tag}</span>
                    <span className="chart-bar-value">{sum.toFixed(2)}</span>
                  </div>
                ))}
              </div>
            )}

            {chartMode === 'pie' && (
              <div className="pie-chart-section">
                {chartTotal <= 0 ? <p className="chart-empty">No data to display.</p> : (
                  <div className="pie-chart-wrap">
                    <svg viewBox="0 0 200 200" width="200" height="200" className="pie-chart">
                      {pieSlices.map(({ tag, path, color }) => (
                        <path key={tag} d={path} fill={color} stroke="#1a1a1a" strokeWidth="1.5" />
                      ))}
                      <circle cx="100" cy="100" r="40" fill="#1a1a1a" />
                    </svg>
                    <div className="pie-legend">
                      {pieSlices.map(({ tag, percentage, color }) => (
                        <div key={tag} className="pie-legend-item">
                          <span className="pie-legend-color" style={{ backgroundColor: color }} />
                          <span>{tag}: {percentage.toFixed(1)}%</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {chartMode === 'calendar' && (
              <div className="calendar-section">
                {!calendarMonthData ? <p className="chart-empty">No data to display.</p> : (
                  <div className="calendar-container">
                    <div className="calendar-nav-row">
                      <button onClick={() => changeCalendarMonth(-1)} className="calendar-nav-btn"
                        disabled={calendarViewMonth === recordMonths.min}>←</button>
                      <h4 className="calendar-month">
                        {new Date(calendarMonthData.year, calendarMonthData.month - 1).toLocaleDateString('en-US', { year: 'numeric', month: 'long' })}
                      </h4>
                      <button onClick={() => changeCalendarMonth(1)} className="calendar-nav-btn"
                        disabled={calendarViewMonth === recordMonths.max}>→</button>
                    </div>
                    <div className="calendar-content">
                      <div className="calendar-grid">
                        {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => (
                          <div key={d} className="calendar-header">{d}</div>
                        ))}
                        {calendarMonthData.calendarDays.map((day, i) => (
                          <div key={i} className={`calendar-day${!day ? ' empty' : ''}`}>
                            {day && (
                              <>
                                <div className="calendar-day-number">{day.day}</div>
                                {Object.entries(day.sumByTag).map(([tag, sum]) =>
                                  sum ? <div key={tag} className="calendar-day-tag" style={{ color: tagColors[tag] || 'inherit' }}>{sum.toFixed(2)}</div> : null
                                )}
                              </>
                            )}
                          </div>
                        ))}
                      </div>
                      <div className="calendar-legend">
                        {allTagOptions.map((tag) => (
                          <div key={tag} className="calendar-legend-item">
                            <span className="calendar-legend-color" style={{ backgroundColor: tagColors[tag] }} />
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
