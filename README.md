# [mint](https://mint---box.vercel.app/) 🌿
**A frontend-only personal finance tagger — no backend, no accounts, no cloud.**

---

### what it does

Banks don't expose APIs for personal transaction data, but they do let you export CSVs. Mint reads those CSV files directly from a folder on your machine, lets you tag each transaction, and visualises your spending through charts and a calendar heatmap — all without a single server request.

---

### the experiment

Most web apps treat the server as the source of truth and the browser as a thin client. This project inverts that assumption entirely.

The premise: if modern passkey authentication ties identity to the device, why shouldn't the data live there too? Mint explores what it looks like to build a fully capable, stateful web application where **the user's machine is the database**.

State is persisted in two layers:

- **File system** — a `mint-data.json` file written directly into the user's chosen folder via the [File System Access API](https://developer.chrome.com/docs/capabilities/web-apis/file-system-access). The file is human-readable, portable, and owned entirely by the user.
- **IndexedDB** — a browser-side cache for instant load times on revisit, synced on every change with a debounced write.

There is no login. There is no sync service. The data never leaves the machine. The frontend simply reads from and writes to a folder the user controls.

---

### stack

**React 19 · Vite · File System Access API · IndexedDB · Vercel**

No backend. No database. No authentication layer.

---

### setup

Navigate to the [live app](https://mint---box.vercel.app/) and choose a folder on your machine containing your bank's exported CSV files. Mint expects columns named `Date`, `Amount`, and `Title` (or `Description`). Everything else is automatic.

---

### demo

https://github.com/user-attachments/assets/31358819-f8aa-4dcf-950b-0d072ef7da5d
