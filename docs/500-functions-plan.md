# Plan: 500 Functions Implementation (1–500)

> ที่มา: `docs/500-functions.txt` (500 ไอเดีย แบ่ง 25 หมวด × 20 ฟังก์ชัน)

## สถานะปัจจุบัน (ผล audit)

- Ideas ครบ: **500/500**
- API names ครบ: **505/505** (5 ideas มี API คู่)
- ทุกหมวด A–Y ครบ: **20/20 ต่อหมวด**
- ไม่มีฟังก์ชันเหลือให้ implement
- เกณฑ์ audit: นับ declaration/function method/arrow function จริงใน source เท่านั้น; ไม่นับ TODO, import หรือชื่อใน comment

| หมวด | ช่วงไอเดีย | ครบ | สถานะ |
| -------------------------- | ------: | ----: | ----- |
| A. Path & File             | 1–20    | 20/20 | ✅ ครบ |
| B. String & Text           | 21–40   | 20/20 | ✅ ครบ |
| C. AST & Code Analysis     | 41–60   | 20/20 | ✅ ครบ |
| D. Diff & Patch            | 61–80   | 20/20 | ✅ ครบ |
| E. Git                     | 81–100  | 20/20 | ✅ ครบ |
| F. Shell & Process         | 101–120 | 20/20 | ✅ ครบ |
| G. Validation & Schema     | 121–140 | 20/20 | ✅ ครบ |
| H. Security & Sanitization | 141–160 | 20/20 | ✅ ครบ |
| I. Config Management       | 161–180 | 20/20 | ✅ ครบ |
| J. Logging & Telemetry     | 181–200 | 20/20 | ✅ ครบ |
| K. Token & Context         | 201–220 | 20/20 | ✅ ครบ |
| L. Caching                 | 221–240 | 20/20 | ✅ ครบ |
| M. Concurrency & Queue     | 241–260 | 20/20 | ✅ ครบ |
| N. Error & Retry           | 261–280 | 20/20 | ✅ ครบ |
| O. Testing                 | 281–300 | 20/20 | ✅ ครบ |
| P. Dependency & Package    | 301–320 | 20/20 | ✅ ครบ |
| Q. Network & HTTP          | 321–340 | 20/20 | ✅ ครบ |
| R. Storage & Database      | 341–360 | 20/20 | ✅ ครบ |
| S. UI / TUI                | 361–380 | 20/20 | ✅ ครบ |
| T. Embedding & Search      | 381–400 | 20/20 | ✅ ครบ |
| U. Model & Provider        | 401–420 | 20/20 | ✅ ครบ |
| V. Plan & Graph             | 421–440 | 20/20 | ✅ ครบ |
| W. Cost & Usage             | 441–460 | 20/20 | ✅ ครบ |
| X. Human-in-the-Loop        | 461–480 | 20/20 | ✅ ครบ |
| Y. Misc / Cross-cutting     | 481–500 | 20/20 | ✅ ครบ |
| **รวม**                     | **1–500** | **500/500** | ✅ ครบ |

## Verification status

- Audit: **500/500 ideas**, **505/505 API names**, every category A–Y **20/20**
- Full tests: **42 suites / 716 passed**
- `npm run typecheck`: **passed**
- `npm run build`: **passed**
- Full ESLint (`npm run lint`): **clean — 0 errors, 0 warnings**
  - unused imports/vars removed (`fs`/`path` in Agent, `PathValidator`, `str`, `symbol`, `match`, `context` args)
  - useless regex escapes fixed, `prefer-const` fixes, `QUALITY_TIMEOUT` wired in as the run_tests default
  - `any` → precise types: typed tool inputs (FileTools/GitTools/SearchTool/ShellTool), `unknown` in `catch` blocks, `ToolSchema[]` for `ToolRegistry.getSchemas()`
- หมายเหตุ: นับเฉพาะ named API declarations ที่ audit เจอจริงใน source (505/505)

## 15 ตัวคุ้มสุด (ตาม NOTES ท้ายไฟล์ต้นฉบับ)

`resolveSafePath`, `execSafe`, `atomicWriteFile`, `validateToolInput`,
`detectSecretPattern`, `retryWithExponentialBackoff`, `promptCacheKeyGenerator`,
`dependencyGraphBuilder`, `topologicalSort`, `contextBudgetAllocator`,
`modelRouterByComplexity`, `runTestSuite`, `batchDiffGrouper`,
`costPerModuleCalculator`, `auditTrailWriter` — ครอบ security/cost/context/verify/review
