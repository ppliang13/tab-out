const express = require('express');
const app = express();
app.use(express.json({ limit: '5mb' }));

// Enable CORS for extension access
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

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

  console.log(`[POST /api/visits] Received data from user ${userId}, ${Object.keys(visits).length} domains`);
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

  console.log(`[GET /api/hot] Returning ${sites.length} hot sites (last ${days} days)`);
  res.json({ sites });
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    recordsCount: db.size
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Hot Sites sync server running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});
