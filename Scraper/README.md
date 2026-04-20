# Scraper IDE

This workspace now owns the **Chrome extension IDE** only. The local portal lives as a sibling project at `/Users/tomas/Desktop/full scraper/portal`.

## 1. Start the portal

```bash
cd "/Users/tomas/Desktop/full scraper/portal"
npm install      # first time only
npm start
```

The portal serves the robot catalog and run history at **http://127.0.0.1:5077**.

## 2. Load the Chrome extension

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked** → select `/Users/tomas/Desktop/full scraper/Scraper`.
4. Open the extension **Details** page and enable **Allow User Scripts**.
5. Click the toolbar icon to open the IDE.

The IDE syncs robots once when it opens. After that, use the new **Refresh robots** button when you want to pull the latest list from the portal.

---

## How data flows

```
Chrome extension IDE
      │
      │  GET  /api/robots        (startup + refresh)
      │  PUT  /api/robots/:id    (save existing robot)
      │  POST /api/runs          (on Run start)
      │  PUT  /api/runs/:id      (on emit / step done / finish)
      ▼
  Portal (sibling project)
      │
      └─ PostgreSQL
```

Robots must be created from the **portal** (`/robots/new`). The IDE can only load and save robots that already exist in the portal.

---

## Tests

```bash
npm test
```
