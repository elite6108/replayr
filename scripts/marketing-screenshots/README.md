# Marketing screenshot harness

Isolated Vite entry that aliases `@tauri-apps/*` so the real desktop React app can render without Tauri. Used only to capture `artifacts/marketing-screenshots/`. Does not change product routes or behavior.

```bash
npm install --prefix scripts/marketing-screenshots
node scripts/marketing-screenshots/capture.mjs
```
