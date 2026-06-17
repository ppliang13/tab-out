# Hot Sites Sync API

扩展与同步服务器之间的接口契约。

---

## POST `/api/visits`

扩展上报本机访问数据到服务器。

### Request

```
POST /api/visits
Content-Type: application/json
```

**Body:**

```json
{
  "userId": "user-lz0abc123-def",
  "syncedAt": "2026-06-17T10:30:00.000Z",
  "visits": {
    "github.com": {
      "count": 42,
      "lastVisit": "2026-06-17T10:25:00.000Z",
      "dailyCounts": {
        "2026-06-17": 5,
        "2026-06-16": 8,
        "2026-06-15": 3,
        "2026-06-14": 6
      }
    },
    "google.com": {
      "count": 120,
      "lastVisit": "2026-06-17T10:00:00.000Z",
      "dailyCounts": {
        "2026-06-17": 12,
        "2026-06-16": 9
      }
    }
  }
}
```

**字段说明:**

| 字段 | 类型 | 说明 |
|---|---|---|
| `userId` | `string` | 扩展实例唯一 ID，首次同步时自动生成，格式 `user-{base36时间戳}-{6位随机}` |
| `syncedAt` | `string` (ISO 8601) | 本次同步时间 |
| `visits` | `object` | 以域名为 key 的访问记录 map |
| `visits[domain].count` | `number` | 该域名历史总访问次数 |
| `visits[domain].lastVisit` | `string` (ISO 8601) | 最近一次访问时间 |
| `visits[domain].dailyCounts` | `object` | 按日期（`YYYY-MM-DD`）记录的访问次数，只保留最近 30 天 |

> **域名已标准化**：全部小写、去 `www.` 前缀，如 `www.GitHub.com` → `github.com`

### Response

```json
{ "ok": true }
```

只需返回 2xx 状态码即可，body 内容扩展端不解析。

### 后端处理建议

1. 以 `userId` + `domain` 为唯一键做 upsert
2. 用 `visits[domain].dailyCounts` 覆盖该用户该域名的日访问数据（全量替换，不是增量——扩展每次发送完整快照）
3. 更新 `lastVisit = max(现有值, 新值)`
4. `count` 可选更新（仅用于参考，排行榜用 `dailyCounts` 聚合）

---

## GET `/api/hot`

获取团队聚合后的热门网站排行。

### Request

```
GET /api/hot?days=30
```

**Query 参数:**

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `days` | `number` | `7` | 聚合最近 N 天的数据。扩展当前传 `30` |

### Response

```json
{
  "sites": [
    {
      "domain": "google.com",
      "totalVisits": 320,
      "uniqueUsers": 5,
      "lastVisit": "2026-06-17T10:00:00.000Z"
    },
    {
      "domain": "github.com",
      "totalVisits": 185,
      "uniqueUsers": 3,
      "lastVisit": "2026-06-17T10:25:00.000Z"
    }
  ]
}
```

**字段说明:**

| 字段 | 类型 | 说明 |
|---|---|---|
| `sites` | `array` | 按热度降序排列的网站列表 |
| `sites[].domain` | `string` | 标准化域名 |
| `sites[].totalVisits` | `number` | 所有用户在最近 N 天内的总访问次数 |
| `sites[].uniqueUsers` | `number` | 在最近 N 天内访问过该域名的不同用户数 |
| `sites[].lastVisit` | `string` (ISO 8601) | 全团队中该域名最近一次访问时间 |

### 后端聚合逻辑

1. 查出最近 `{days}` 天内所有用户的 `dailyCounts` 数据
2. 按 `domain` 分组聚合：
   - `totalVisits` = SUM(所有用户该域名在 N 天内的 dailyCounts)
   - `uniqueUsers` = COUNT(DISTINCT userId)
   - `lastVisit`   = MAX(所有记录的 lastVisit)
3. 按 `totalVisits` 降序排序
4. 返回 `{ sites: [...] }`

---

## 同步流程时序

```
扩展 (每 N 分钟)                    服务器
    │                                 │
    │  POST /api/visits               │
    │  { userId, visits: {...} }      │
    │ ──────────────────────────────► │  存储/更新用户数据
    │                                 │
    │  GET /api/hot?days=30           │
    │ ◄────────────────────────────── │  聚合所有用户 → 排行榜
    │  { sites: [...] }               │
    │                                 │
    │  存入 hotSitesData               │
    │  渲染 Team Sites 标签页           │
```

---

## 最小后端参考实现 (Node/Express)

```js
const express = require('express');
const app = express();
app.use(express.json({ limit: '5mb' }));

// 内存存储：key = `${userId}:${domain}` → { userId, domain, dailyCounts, lastVisit, count }
const db = new Map();

// POST /api/visits — 接收扩展上报的访问数据
app.post('/api/visits', (req, res) => {
  const { userId, visits } = req.body;
  if (!userId || !visits) {
    return res.status(400).json({ ok: false, error: 'missing userId or visits' });
  }

  for (const [domain, data] of Object.entries(visits)) {
    const key = `${userId}:${domain}`;
    db.set(key, {
      userId,
      domain,
      count: data.count || 0,
      lastVisit: data.lastVisit || new Date().toISOString(),
      dailyCounts: data.dailyCounts || {},  // 全量覆盖
    });
  }

  res.json({ ok: true });
});

// GET /api/hot — 聚合返回团队热门网站
app.get('/api/hot', (req, res) => {
  const days = parseInt(req.query.days) || 7;

  // 生成最近 N 天的日期列表 ['2026-06-15', ..., '2026-06-17']
  const cutoffDates = [];
  const now = new Date();
  for (let i = 0; i < days; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    cutoffDates.push(d.toISOString().slice(0, 10));
  }

  // 按域名聚合
  const agg = {};  // domain -> { totalVisits, users:Set, lastVisit }
  for (const record of db.values()) {
    let total = 0;
    for (const date of cutoffDates) {
      total += record.dailyCounts?.[date] || 0;
    }
    if (total === 0) continue;

    if (!agg[record.domain]) {
      agg[record.domain] = { totalVisits: 0, users: new Set(), lastVisit: '' };
    }
    agg[record.domain].totalVisits += total;
    agg[record.domain].users.add(record.userId);
    if (record.lastVisit > agg[record.domain].lastVisit) {
      agg[record.domain].lastVisit = record.lastVisit;
    }
  }

  // 排序输出
  const sites = Object.entries(agg)
    .map(([domain, v]) => ({
      domain,
      totalVisits: v.totalVisits,
      uniqueUsers: v.users.size,
      lastVisit: v.lastVisit,
    }))
    .sort((a, b) => b.totalVisits - a.totalVisits);

  res.json({ sites });
});

app.listen(3000, () => console.log('Hot Sites sync server on :3000'));
```

> 生产环境建议将 `db` 替换为 Redis 或数据库（如 SQLite / PostgreSQL），并添加数据过期清理。
