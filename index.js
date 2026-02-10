const express = require('express');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;
const APP_TOKEN = process.env.APP_TOKEN;

// PostgreSQL connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Initialize database
async function initDb() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS activity_logs (
        id BIGSERIAL PRIMARY KEY,
        content TEXT NOT NULL,
        category VARCHAR(50) DEFAULT 'general',
        details TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    // Add details column if it doesn't exist
    await client.query(`
      ALTER TABLE activity_logs ADD COLUMN IF NOT EXISTS details TEXT
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_activity_logs_created_at ON activity_logs(created_at DESC)
    `);
    console.log('Database initialized');
  } finally {
    client.release();
  }
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Cookie parser
app.use((req, res, next) => {
  req.cookies = {};
  const cookieHeader = req.headers.cookie;
  if (cookieHeader) {
    cookieHeader.split(';').forEach(cookie => {
      const [name, value] = cookie.trim().split('=');
      req.cookies[name] = value;
    });
  }
  next();
});

// Serve static files (for avatar)
app.use('/public', express.static('public'));

// Auth endpoint
app.get('/auth', (req, res) => {
  const { token } = req.query;
  if (token === APP_TOKEN) {
    res.setHeader('Set-Cookie', `app_token=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`);
    res.redirect('/');
  } else {
    res.status(401).send('Invalid token');
  }
});

// Auth middleware
function requireAuth(req, res, next) {
  if (req.cookies.app_token === APP_TOKEN) {
    next();
  } else {
    res.status(401).send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Dexo Activity</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          body { font-family: system-ui; background: #0d1117; color: #c9d1d9; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
          .lock { text-align: center; }
          .lock h1 { font-size: 3rem; margin: 0; }
          .lock p { color: #8b949e; }
        </style>
      </head>
      <body>
        <div class="lock">
          <h1>🔒</h1>
          <p>Private activity log</p>
        </div>
      </body>
      </html>
    `);
  }
}

// API: Add activity
app.post('/api/activities', async (req, res) => {
  const authHeader = req.headers.authorization;
  const cookieAuth = req.cookies.app_token === APP_TOKEN;
  const headerAuth = authHeader === `Bearer ${APP_TOKEN}`;
  
  if (!cookieAuth && !headerAuth) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  const { content, category, details } = req.body;
  if (!content) {
    return res.status(400).json({ error: 'Content required' });
  }
  
  try {
    const result = await pool.query(
      'INSERT INTO activity_logs (content, category, details) VALUES ($1, $2, $3) RETURNING *',
      [content, category || 'general', details || null]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Insert error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// API: Get single activity
app.get('/api/activities/:id', requireAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM activity_logs WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

// API: List activities
app.get('/api/activities', requireAuth, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const offset = parseInt(req.query.offset) || 0;
  const search = req.query.q || '';
  const date = req.query.date || '';
  
  try {
    let query = 'SELECT * FROM activity_logs WHERE 1=1';
    const params = [];
    let paramIndex = 1;
    
    if (date) {
      query += ` AND DATE(created_at AT TIME ZONE 'America/Los_Angeles') = $${paramIndex}`;
      params.push(date);
      paramIndex++;
    }
    
    if (search) {
      query += ` AND (content ILIKE $${paramIndex} OR category ILIKE $${paramIndex})`;
      params.push(`%${search}%`);
      paramIndex++;
    }
    
    query += ` ORDER BY created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(limit, offset);
    
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error('Query error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// Get unique dates from activities
async function getUniqueDates() {
  try {
    const result = await pool.query(`
      SELECT DISTINCT DATE(created_at AT TIME ZONE 'America/Los_Angeles') as date
      FROM activity_logs
      ORDER BY date DESC
      LIMIT 14
    `);
    return result.rows.map(r => r.date.toISOString().split('T')[0]);
  } catch (err) {
    console.error('Date query error:', err);
    return [];
  }
}

// Format date for tab label
function formatDateTab(dateStr) {
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  
  const todayStr = today.toISOString().split('T')[0];
  const yesterdayStr = yesterday.toISOString().split('T')[0];
  
  if (dateStr === todayStr) return 'Today';
  if (dateStr === yesterdayStr) return 'Yesterday';
  
  const date = new Date(dateStr + 'T12:00:00');
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// Main page
app.get('/', requireAuth, async (req, res) => {
  const search = req.query.q || '';
  const selectedDate = req.query.date || '';
  
  try {
    const uniqueDates = await getUniqueDates();
    
    let query = 'SELECT * FROM activity_logs WHERE 1=1';
    const params = [];
    let paramIndex = 1;
    
    if (selectedDate) {
      query += ` AND DATE(created_at AT TIME ZONE 'America/Los_Angeles') = $${paramIndex}`;
      params.push(selectedDate);
      paramIndex++;
    }
    
    if (search) {
      query += ` AND (content ILIKE $${paramIndex} OR category ILIKE $${paramIndex})`;
      params.push(`%${search}%`);
      paramIndex++;
    }
    
    query += ' ORDER BY created_at DESC LIMIT 100';
    
    const result = await pool.query(query, params);
    const activities = result.rows;
    
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Dexo Activity</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <meta name="robots" content="noindex, nofollow">
        <style>
          * { box-sizing: border-box; }
          body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            background: #0d1117;
            color: #c9d1d9;
            margin: 0;
            padding: 0;
            line-height: 1.5;
          }
          .container {
            max-width: 600px;
            margin: 0 auto;
            padding: 20px;
          }
          header {
            border-bottom: 1px solid #21262d;
            padding-bottom: 16px;
            margin-bottom: 20px;
          }
          .header-top {
            display: flex;
            align-items: center;
            gap: 12px;
          }
          .avatar {
            width: 48px;
            height: 48px;
            border-radius: 50%;
            object-fit: cover;
            border: 2px solid #30363d;
          }
          .header-text h1 {
            margin: 0;
            font-size: 1.3rem;
          }
          .header-text p {
            margin: 2px 0 0;
            color: #8b949e;
            font-size: 0.85rem;
          }
          .search-box {
            margin-top: 16px;
          }
          .search-box input {
            width: 100%;
            padding: 10px 16px;
            border: 1px solid #30363d;
            border-radius: 24px;
            background: #161b22;
            color: #c9d1d9;
            font-size: 0.95rem;
            outline: none;
            transition: border-color 0.2s;
          }
          .search-box input:focus {
            border-color: #58a6ff;
          }
          .search-box input::placeholder {
            color: #6e7681;
          }
          .date-tabs {
            display: flex;
            gap: 8px;
            margin-top: 16px;
            overflow-x: auto;
            padding-bottom: 4px;
            -webkit-overflow-scrolling: touch;
          }
          .date-tabs::-webkit-scrollbar {
            height: 4px;
          }
          .date-tabs::-webkit-scrollbar-track {
            background: transparent;
          }
          .date-tabs::-webkit-scrollbar-thumb {
            background: #30363d;
            border-radius: 2px;
          }
          .date-tab {
            padding: 6px 14px;
            border-radius: 20px;
            background: #21262d;
            color: #8b949e;
            text-decoration: none;
            font-size: 0.85rem;
            white-space: nowrap;
            transition: all 0.15s;
            border: 1px solid transparent;
          }
          .date-tab:hover {
            background: #30363d;
            color: #c9d1d9;
          }
          .date-tab.active {
            background: #58a6ff;
            color: #0d1117;
            font-weight: 500;
          }
          .date-tab.all {
            border: 1px solid #30363d;
            background: transparent;
          }
          .date-tab.all.active {
            background: #58a6ff;
            border-color: #58a6ff;
          }
          .activity {
            padding: 16px 0;
            border-bottom: 1px solid #21262d;
          }
          .activity:last-child {
            border-bottom: none;
          }
          .activity-content {
            font-size: 1rem;
            margin-bottom: 8px;
          }
          .activity-meta {
            font-size: 0.8rem;
            color: #8b949e;
            display: flex;
            gap: 12px;
            align-items: center;
          }
          .category {
            background: #21262d;
            padding: 2px 8px;
            border-radius: 12px;
            font-size: 0.75rem;
          }
          .has-details {
            cursor: pointer;
          }
          .has-details:hover .activity-content {
            color: #58a6ff;
          }
          .details-badge {
            background: #1f6feb;
            color: white;
            padding: 2px 6px;
            border-radius: 8px;
            font-size: 0.7rem;
            cursor: pointer;
          }
          .activity-details {
            display: none;
            margin-top: 12px;
            padding: 12px;
            background: #161b22;
            border-radius: 8px;
            font-size: 0.9rem;
            white-space: pre-wrap;
            border-left: 3px solid #1f6feb;
          }
          .activity-details.show {
            display: block;
          }
          .empty {
            text-align: center;
            padding: 40px;
            color: #8b949e;
          }
          .search-results {
            color: #8b949e;
            font-size: 0.85rem;
            margin-bottom: 12px;
          }
          mark {
            background: #634d00;
            color: #f0e68c;
            padding: 0 2px;
            border-radius: 2px;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <header>
            <div class="header-top">
              <img src="/public/avatar.jpg" alt="Dexo" class="avatar">
              <div class="header-text">
                <h1>Dexo Activity</h1>
                <p>What I've been up to</p>
              </div>
            </div>
            <div class="search-box">
              <form method="GET" action="/">
                <input type="text" name="q" placeholder="Search activities..." value="${escapeHtml(search)}" autocomplete="off">
                ${selectedDate ? `<input type="hidden" name="date" value="${escapeHtml(selectedDate)}">` : ''}
              </form>
            </div>
            <div class="date-tabs">
              <a href="/${search ? '?q=' + encodeURIComponent(search) : ''}" class="date-tab all ${!selectedDate ? 'active' : ''}">All</a>
              ${uniqueDates.map(d => `
                <a href="/?date=${d}${search ? '&q=' + encodeURIComponent(search) : ''}" class="date-tab ${selectedDate === d ? 'active' : ''}">${formatDateTab(d)}</a>
              `).join('')}
            </div>
          </header>
          <main>
            ${search ? `<div class="search-results">${activities.length} result${activities.length !== 1 ? 's' : ''} for "${escapeHtml(search)}"</div>` : ''}
            ${activities.length === 0 ? '<div class="empty">' + (search ? 'No matching activities' : (selectedDate ? 'No activities on this day' : 'No activities yet')) + '</div>' : ''}
            ${activities.map(a => `
              <div class="activity ${a.details ? 'has-details' : ''}" ${a.details ? `onclick="toggleDetails(${a.id})"` : ''}>
                <div class="activity-content">${highlightSearch(escapeHtml(a.content), search)}</div>
                <div class="activity-meta">
                  <span class="category">${escapeHtml(a.category)}</span>
                  <span>${formatTime(a.created_at)}</span>
                  ${a.details ? '<span class="details-badge">+ details</span>' : ''}
                </div>
                ${a.details ? `<div class="activity-details" id="details-${a.id}">${escapeHtml(a.details)}</div>` : ''}
              </div>
            `).join('')}
          </main>
        </div>
        <script>
          function toggleDetails(id) {
            const el = document.getElementById('details-' + id);
            if (el) el.classList.toggle('show');
          }
        </script>
      </body>
      </html>
    `);
  } catch (err) {
    console.error('Page error:', err);
    res.status(500).send('Database error');
  }
});

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function highlightSearch(text, search) {
  if (!search) return text;
  const regex = new RegExp(`(${search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
  return text.replace(regex, '<mark>$1</mark>');
}

function formatTime(dateStr) {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);
  
  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return diffMins + 'm ago';
  if (diffHours < 24) return diffHours + 'h ago';
  if (diffDays < 7) return diffDays + 'd ago';
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// Start server
initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`Dexo Activity running on port ${PORT}`);
  });
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});
