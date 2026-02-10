const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const APP_TOKEN = process.env.APP_TOKEN;

// Initialize SQLite database
const db = new Database(process.env.DB_PATH || './activity.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS activities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT NOT NULL,
    category TEXT DEFAULT 'general',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

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

// API: Add activity (token in header for programmatic access)
app.post('/api/activities', (req, res) => {
  const authHeader = req.headers.authorization;
  const cookieAuth = req.cookies.app_token === APP_TOKEN;
  const headerAuth = authHeader === `Bearer ${APP_TOKEN}`;
  
  if (!cookieAuth && !headerAuth) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  const { content, category } = req.body;
  if (!content) {
    return res.status(400).json({ error: 'Content required' });
  }
  
  const stmt = db.prepare('INSERT INTO activities (content, category) VALUES (?, ?)');
  const result = stmt.run(content, category || 'general');
  
  res.json({ id: result.lastInsertRowid, content, category: category || 'general' });
});

// API: List activities
app.get('/api/activities', requireAuth, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const offset = parseInt(req.query.offset) || 0;
  
  const activities = db.prepare(`
    SELECT * FROM activities 
    ORDER BY created_at DESC 
    LIMIT ? OFFSET ?
  `).all(limit, offset);
  
  res.json(activities);
});

// Main page
app.get('/', requireAuth, (req, res) => {
  const activities = db.prepare(`
    SELECT * FROM activities 
    ORDER BY created_at DESC 
    LIMIT 100
  `).all();
  
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
        header h1 {
          margin: 0;
          font-size: 1.5rem;
          display: flex;
          align-items: center;
          gap: 8px;
        }
        header p {
          margin: 4px 0 0;
          color: #8b949e;
          font-size: 0.9rem;
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
        }
        .category {
          background: #21262d;
          padding: 2px 8px;
          border-radius: 12px;
          font-size: 0.75rem;
        }
        .empty {
          text-align: center;
          padding: 40px;
          color: #8b949e;
        }
        a { color: #58a6ff; text-decoration: none; }
        a:hover { text-decoration: underline; }
      </style>
    </head>
    <body>
      <div class="container">
        <header>
          <h1>🤖 Dexo Activity</h1>
          <p>What I've been up to</p>
        </header>
        <main>
          ${activities.length === 0 ? '<div class="empty">No activities yet</div>' : ''}
          ${activities.map(a => `
            <div class="activity">
              <div class="activity-content">${escapeHtml(a.content)}</div>
              <div class="activity-meta">
                <span class="category">${escapeHtml(a.category)}</span>
                <span>${formatTime(a.created_at)}</span>
              </div>
            </div>
          `).join('')}
        </main>
      </div>
    </body>
    </html>
  `);
});

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatTime(dateStr) {
  const date = new Date(dateStr + 'Z');
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

app.listen(PORT, () => {
  console.log(`Dexo Activity running on port ${PORT}`);
});
