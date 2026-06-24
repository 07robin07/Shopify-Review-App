const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const express = require('express');
const session = require('express-session');
const crypto = require('crypto');

// Shopify API setup
const SHOPIFY_API_KEY = process.env.SHOPIFY_API_KEY || 'ab67a788ab296b66c963abf0605dffd7';
const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET || '';
const APP_URL = 'https://midnightblue-hornet-725465.hostingersite.com';
const SCOPES = 'read_products,read_orders,write_script_tags';

// SQLite database setup
const dbPath = path.join(__dirname, 'reviews.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Error opening database:', err.message);
  } else {
    console.log('Connected to SQLite database.');
  }
});

// Create tables if they don't exist
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS reviews (
    id TEXT PRIMARY KEY,
    shop TEXT NOT NULL,
    productId TEXT NOT NULL,
    customerName TEXT,
    customerEmail TEXT,
    rating INTEGER,
    title TEXT,
    body TEXT,
    photos TEXT,
    verified INTEGER DEFAULT 0,
    published INTEGER DEFAULT 1,
    featured INTEGER DEFAULT 0,
    helpfulCount INTEGER DEFAULT 0,
    notHelpfulCount INTEGER DEFAULT 0,
    reply TEXT,
    replyDate TEXT,
    createdAt TEXT,
    updatedAt TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS settings (
    shop TEXT PRIMARY KEY,
    autoPublish INTEGER DEFAULT 1,
    reviewRequestDelay INTEGER DEFAULT 7,
    widgetTheme TEXT DEFAULT 'default',
    starColor TEXT DEFAULT '#f5c518',
    showPhotos INTEGER DEFAULT 1,
    minReviewLength INTEGER DEFAULT 10,
    enableCoupons INTEGER DEFAULT 0,
    enableQandA INTEGER DEFAULT 0,
    enableRichSnippets INTEGER DEFAULT 1
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS questions (
    id TEXT PRIMARY KEY,
    shop TEXT NOT NULL,
    productId TEXT NOT NULL,
    productTitle TEXT,
    customerName TEXT,
    customerEmail TEXT,
    question TEXT,
    answer TEXT,
    answeredBy TEXT,
    answerDate TEXT,
    status TEXT DEFAULT 'pending',
    votes INTEGER DEFAULT 0,
    createdAt TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS subscriptions (
    shop TEXT PRIMARY KEY,
    plan TEXT DEFAULT 'free',
    status TEXT DEFAULT 'active',
    reviewCount INTEGER DEFAULT 0,
    reviewLimit INTEGER DEFAULT 50
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    shop TEXT NOT NULL,
    state TEXT,
    isOnline INTEGER DEFAULT 1,
    accessToken TEXT,
    expires INTEGER,
    scope TEXT,
    createdAt TEXT
  )`);
});

const app = express();

// Session middleware
app.use(session({
  secret: 'put-any-random-32-character-string-here-for-testing',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    maxAge: 24 * 60 * 60 * 1000
  }
}));

// CRITICAL: Enable CORS for Shopify store to communicate with server
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  if (req.method === 'OPTIONS') res.sendStatus(200);
  else next();
});

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true }));

function generateId() {
  return Math.random().toString(36).substring(2, 15) + Date.now().toString(36);
}

function generateNonce() {
  return crypto.randomBytes(16).toString('hex');
}

function runQuery(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

function runRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

// ==================== OAUTH ROUTES ====================

// Step 1: Start OAuth - redirect to Shopify authorization
app.get('/auth', async (req, res) => {
  try {
    const { shop } = req.query;
    if (!shop) {
      return res.status(400).send('Missing shop parameter');
    }

    const sanitizedShop = shop.replace('.myshopify.com', '').trim();
    const shopDomain = `${sanitizedShop}.myshopify.com`;

    const state = generateNonce();
    req.session.oauthState = state;
    req.session.shop = shopDomain;

    // Use base URL as redirect (what's whitelisted in Shopify)
    const redirectUri = `${APP_URL}/`;
    const authUrl = `https://${shopDomain}/admin/oauth/authorize?client_id=${SHOPIFY_API_KEY}&scope=${SCOPES}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`;

    console.log(`[OAuth] Redirecting ${shopDomain} to Shopify auth`);
    res.redirect(authUrl);
  } catch (error) {
    console.error('[OAuth] Auth start error:', error);
    res.status(500).send('Authentication error');
  }
});

// Step 2: OAuth callback - handle on root route when code is present
app.get('/', async (req, res) => {
  const { code, shop, state } = req.query;
  
  // If no code parameter, serve the normal frontend
  if (!code) {
    return res.sendFile(path.join(__dirname, "..", "web", "index.html"));
  }
  
  // Handle OAuth callback
  try {
    if (state !== req.session.oauthState) {
      return res.status(403).send('Invalid state parameter');
    }

    if (!code || !shop) {
      return res.status(400).send('Missing authorization code or shop');
    }

    const tokenUrl = `https://${shop}/admin/oauth/access_token`;
    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: SHOPIFY_API_KEY,
        client_secret: SHOPIFY_API_SECRET,
        code: code
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Token exchange failed: ${errorText}`);
    }

    const tokenData = await response.json();

    const sessionId = generateId();
    const now = new Date().toISOString();

    await runRun(
      `INSERT OR REPLACE INTO sessions (id, shop, accessToken, scope, createdAt) VALUES (?, ?, ?, ?, ?)`,
      [sessionId, shop, tokenData.access_token, tokenData.scope, now]
    );

    req.session.shopifySessionId = sessionId;
    req.session.shop = shop;

    const existingSub = await runQuery(`SELECT * FROM subscriptions WHERE shop = ?`, [shop]);
    if (existingSub.length === 0) {
      await runRun(
        `INSERT INTO subscriptions (shop, plan, status, reviewCount, reviewLimit) VALUES (?, ?, ?, ?, ?)`,
        [shop, 'free', 'active', 0, 50]
      );
    }

    console.log(`[OAuth] Successfully authenticated ${shop}`);
    res.redirect(`${APP_URL}/?shop=${shop}`);
  } catch (error) {
    console.error('[OAuth] Callback error:', error);
    res.status(500).send('Authentication failed: ' + error.message);
  }
});

// Middleware to check if user is authenticated
async function requireAuth(req, res, next) {
  try {
    const { shop } = req.query;
    
    // For development: allow if no auth is configured
    if (!SHOPIFY_API_KEY || !SHOPIFY_API_SECRET || SHOPIFY_API_SECRET === 'YOUR_SECRET_HERE') {
      console.log('[Auth] API keys not fully configured, allowing request');
      return next();
    }

    const sessionId = req.session.shopifySessionId;
    if (!sessionId) {
      return res.status(401).json({ error: 'Unauthorized', authUrl: `${APP_URL}/auth?shop=${shop || ''}` });
    }

    const sessions = await runQuery(`SELECT * FROM sessions WHERE id = ? AND shop = ?`, [sessionId, shop]);
    if (sessions.length === 0) {
      return res.status(401).json({ error: 'Session expired', authUrl: `${APP_URL}/auth?shop=${shop || ''}` });
    }

    next();
  } catch (error) {
    console.error('[Auth] Middleware error:', error);
    res.status(500).json({ error: 'Authentication error' });
  }
}

// ==================== PUBLIC API (Storefront) ====================

app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.get("/api/reviews/product/:productId", async (req, res) => {
  try {
    const { productId } = req.params;
    const { shop, page = 1, limit = 10, sort = "newest" } = req.query;

    if (!shop) {
      return res.status(400).json({ error: "Missing shop parameter" });
    }

    let sql = `SELECT * FROM reviews WHERE shop = ? AND productId = ? AND published = 1`;
    let reviews = await runQuery(sql, [shop, productId]);

    const sortFn = {
      newest: (a, b) => new Date(b.createdAt) - new Date(a.createdAt),
      oldest: (a, b) => new Date(a.createdAt) - new Date(b.createdAt),
      highest: (a, b) => b.rating - a.rating,
      lowest: (a, b) => a.rating - b.rating,
      helpful: (a, b) => b.helpfulCount - a.helpfulCount
    };
    reviews.sort(sortFn[sort] || sortFn.newest);

    const start = (parseInt(page) - 1) * parseInt(limit);
    const paginated = reviews.slice(start, start + parseInt(limit));

    const total = reviews.length;
    const avg = total > 0 ? reviews.reduce((sum, r) => sum + r.rating, 0) / total : 0;
    const breakdown = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
    reviews.forEach(r => breakdown[r.rating] = (breakdown[r.rating] || 0) + 1);

    paginated.forEach(r => {
      try {
        r.photos = r.photos ? JSON.parse(r.photos) : [];
      } catch (e) {
        r.photos = [];
      }
      r.verified = r.verified === 1;
      r.published = r.published === 1;
      r.featured = r.featured === 1;
    });

    res.json({
      reviews: paginated,
      pagination: { total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)) },
      stats: { average: Math.round(avg * 10) / 10, total, breakdown }
    });
  } catch (error) {
    console.error("Error fetching reviews:", error);
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/reviews/submit", async (req, res) => {
  try {
    const { shop, productId, customerName, customerEmail, rating, title, body, photos = [] } = req.body;

    if (!shop || !productId || !rating) {
      return res.status(400).json({ error: "Missing required fields: shop, productId, rating" });
    }

    const subRows = await runQuery(`SELECT * FROM subscriptions WHERE shop = ?`, [shop]);
    const subscription = subRows[0] || { plan: 'free', reviewCount: 0, reviewLimit: 50 };

    if (subscription.plan === 'free' && subscription.reviewCount >= subscription.reviewLimit) {
      return res.status(403).json({ error: "Review limit reached. Upgrade to Unlimited plan." });
    }

    if (photos && photos.length > 0 && subscription.plan === 'free') {
      return res.status(403).json({ error: "Photo reviews require Unlimited plan." });
    }

    const settingsRows = await runQuery(`SELECT * FROM settings WHERE shop = ?`, [shop]);
    const autoPublish = settingsRows.length > 0 ? settingsRows[0].autoPublish : 1;

    const id = generateId();
    const now = new Date().toISOString();

    await runRun(
      `INSERT INTO reviews (id, shop, productId, customerName, customerEmail, rating, title, body, photos, verified, published, featured, helpfulCount, notHelpfulCount, reply, replyDate, createdAt, updatedAt) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, shop, productId, customerName || null, customerEmail || null, parseInt(rating), title || null, body || null, JSON.stringify(photos || []), 0, autoPublish, 0, 0, 0, null, null, now, now]
    );

    await runRun(`UPDATE subscriptions SET reviewCount = reviewCount + 1 WHERE shop = ?`, [shop]);

    const review = {
      id, shop, productId, customerName, customerEmail,
      rating: parseInt(rating), title, body, photos: photos || [],
      verified: false, published: autoPublish === 1,
      featured: false, helpfulCount: 0, notHelpfulCount: 0,
      reply: null, replyDate: null, createdAt: now, updatedAt: now
    };

    res.status(201).json(review);
  } catch (error) {
    console.error("Error submitting review:", error);
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/reviews/:id/helpful", async (req, res) => {
  try {
    const { id } = req.params;
    const { action } = req.body;

    const rows = await runQuery(`SELECT * FROM reviews WHERE id = ?`, [id]);
    if (rows.length === 0) return res.status(404).json({ error: "Not found" });

    const review = rows[0];
    const newCount = action === "increment" ? (review.helpfulCount || 0) + 1 : Math.max(0, (review.helpfulCount || 0) - 1);

    await runRun(`UPDATE reviews SET helpfulCount = ? WHERE id = ?`, [newCount, id]);

    review.helpfulCount = newCount;
    try {
      review.photos = review.photos ? JSON.parse(review.photos) : [];
    } catch (e) {
      review.photos = [];
    }
    review.verified = review.verified === 1;
    review.published = review.published === 1;
    review.featured = review.featured === 1;

    res.json(review);
  } catch (error) {
    console.error("Error marking helpful:", error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== ADMIN API (Protected) ====================

app.get("/api/reviews/admin/all", requireAuth, async (req, res) => {
  try {
    const { shop, status, page = 1, limit = 20, search } = req.query;

    if (!shop) {
      return res.status(400).json({ error: "Missing shop parameter" });
    }

    let sql = `SELECT * FROM reviews WHERE shop = ?`;
    let params = [shop];

    if (status === "published") {
      sql += ` AND published = 1`;
    } else if (status === "pending") {
      sql += ` AND published = 0`;
    }

    if (search) {
      sql += ` AND (LOWER(customerName) LIKE ? OR LOWER(body) LIKE ? OR LOWER(title) LIKE ?)`;
      params.push(`%${search.toLowerCase()}%`, `%${search.toLowerCase()}%`, `%${search.toLowerCase()}%`);
    }

    sql += ` ORDER BY createdAt DESC LIMIT ? OFFSET ?`;
    params.push(parseInt(limit), (parseInt(page) - 1) * parseInt(limit));

    let reviews = await runQuery(sql, params);

    reviews.forEach(r => {
      try {
        r.photos = r.photos ? JSON.parse(r.photos) : [];
      } catch (e) {
        r.photos = [];
      }
      r.verified = r.verified === 1;
      r.published = r.published === 1;
      r.featured = r.featured === 1;
    });

    const countRows = await runQuery(`SELECT COUNT(*) as count FROM reviews WHERE shop = ?`, [shop]);
    const total = countRows[0].count;

    res.json({
      reviews,
      pagination: { total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)) }
    });
  } catch (error) {
    console.error("Error fetching admin reviews:", error);
    res.status(500).json({ error: error.message });
  }
});

app.put("/api/reviews/admin/:id", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { published, featured, reply } = req.body;

    const rows = await runQuery(`SELECT * FROM reviews WHERE id = ?`, [id]);
    if (rows.length === 0) return res.status(404).json({ error: "Not found" });

    const updates = [];
    const params = [];
    const now = new Date().toISOString();

    if (published !== undefined) {
      updates.push("published = ?");
      params.push(published ? 1 : 0);
    }
    if (featured !== undefined) {
      updates.push("featured = ?");
      params.push(featured ? 1 : 0);
    }
    if (reply !== undefined) {
      updates.push("reply = ?");
      params.push(reply);
      updates.push("replyDate = ?");
      params.push(reply ? now : null);
    }

    updates.push("updatedAt = ?");
    params.push(now);
    params.push(id);

    await runRun(`UPDATE reviews SET ${updates.join(', ')} WHERE id = ?`, params);

    const updated = await runQuery(`SELECT * FROM reviews WHERE id = ?`, [id]);
    const review = updated[0];
    try {
      review.photos = review.photos ? JSON.parse(review.photos) : [];
    } catch (e) {
      review.photos = [];
    }
    review.verified = review.verified === 1;
    review.published = review.published === 1;
    review.featured = review.featured === 1;

    res.json(review);
  } catch (error) {
    console.error("Error updating review:", error);
    res.status(500).json({ error: error.message });
  }
});

app.delete("/api/reviews/admin/:id", requireAuth, async (req, res) => {
  try {
    await runRun(`DELETE FROM reviews WHERE id = ?`, [req.params.id]);
    res.status(204).send();
  } catch (error) {
    console.error("Error deleting review:", error);
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/reviews/admin/bulk", requireAuth, async (req, res) => {
  try {
    const { ids, action } = req.body;

    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: "Invalid ids array" });
    }

    if (action === "delete") {
      const placeholders = ids.map(() => '?').join(',');
      await runRun(`DELETE FROM reviews WHERE id IN (${placeholders})`, ids);
    } else {
      let field, value;
      if (action === "publish") { field = "published"; value = 1; }
      else if (action === "unpublish") { field = "published"; value = 0; }
      else if (action === "feature") { field = "featured"; value = 1; }
      else {
        return res.status(400).json({ error: "Invalid action" });
      }

      const placeholders = ids.map(() => '?').join(',');
      await runRun(`UPDATE reviews SET ${field} = ? WHERE id IN (${placeholders})`, [value, ...ids]);
    }

    res.json({ success: true, affected: ids.length });
  } catch (error) {
    console.error("Error bulk action:", error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== SETTINGS API ====================

app.get("/api/settings", async (req, res) => {
  try {
    const { shop } = req.query;

    if (!shop) {
      return res.status(400).json({ error: "Missing shop parameter" });
    }

    const rows = await runQuery(`SELECT * FROM settings WHERE shop = ?`, [shop]);

    if (rows.length === 0) {
      const defaultSettings = {
        autoPublish: true,
        reviewRequestDelay: 7,
        widgetTheme: "default",
        starColor: "#f5c518",
        showPhotos: true,
        minReviewLength: 10,
        enableCoupons: false,
        enableQandA: false,
        enableRichSnippets: true
      };
      return res.json(defaultSettings);
    }

    const s = rows[0];
    res.json({
      autoPublish: s.autoPublish === 1,
      reviewRequestDelay: s.reviewRequestDelay,
      widgetTheme: s.widgetTheme,
      starColor: s.starColor,
      showPhotos: s.showPhotos === 1,
      minReviewLength: s.minReviewLength,
      enableCoupons: s.enableCoupons === 1,
      enableQandA: s.enableQandA === 1,
      enableRichSnippets: s.enableRichSnippets === 1
    });
  } catch (error) {
    console.error("Error fetching settings:", error);
    res.status(500).json({ error: error.message });
  }
});

app.put("/api/settings", requireAuth, async (req, res) => {
  try {
    const { shop } = req.query;
    const body = req.body;

    if (!shop) {
      return res.status(400).json({ error: "Missing shop parameter" });
    }

    const existing = await runQuery(`SELECT * FROM settings WHERE shop = ?`, [shop]);

    const validColumns = ['autoPublish', 'reviewRequestDelay', 'widgetTheme', 'starColor', 'showPhotos', 'minReviewLength', 'enableCoupons', 'enableQandA', 'enableRichSnippets'];

    if (existing.length === 0) {
      const values = {
        autoPublish: body.autoPublish !== undefined ? (body.autoPublish ? 1 : 0) : 1,
        reviewRequestDelay: body.reviewRequestDelay || 7,
        widgetTheme: body.widgetTheme || 'default',
        starColor: body.starColor || '#f5c518',
        showPhotos: body.showPhotos !== undefined ? (body.showPhotos ? 1 : 0) : 1,
        minReviewLength: body.minReviewLength || 10,
        enableCoupons: body.enableCoupons !== undefined ? (body.enableCoupons ? 1 : 0) : 0,
        enableQandA: body.enableQandA !== undefined ? (body.enableQandA ? 1 : 0) : 0,
        enableRichSnippets: body.enableRichSnippets !== undefined ? (body.enableRichSnippets ? 1 : 0) : 1
      };

      await runRun(
        `INSERT INTO settings (shop, autoPublish, reviewRequestDelay, widgetTheme, starColor, showPhotos, minReviewLength, enableCoupons, enableQandA, enableRichSnippets) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [shop, values.autoPublish, values.reviewRequestDelay, values.widgetTheme, values.starColor, values.showPhotos, values.minReviewLength, values.enableCoupons, values.enableQandA, values.enableRichSnippets]
      );
    } else {
      const updates = [];
      const params = [];

      for (const [key, value] of Object.entries(body)) {
        if (validColumns.includes(key)) {
          updates.push(`${key} = ?`);
          params.push(typeof value === 'boolean' ? (value ? 1 : 0) : value);
        }
      }

      if (updates.length === 0) {
        return res.status(400).json({ error: "No valid settings to update" });
      }

      params.push(shop);
      await runRun(`UPDATE settings SET ${updates.join(', ')} WHERE shop = ?`, params);
    }

    const updated = await runQuery(`SELECT * FROM settings WHERE shop = ?`, [shop]);
    const s = updated[0];
    res.json({
      autoPublish: s.autoPublish === 1,
      reviewRequestDelay: s.reviewRequestDelay,
      widgetTheme: s.widgetTheme,
      starColor: s.starColor,
      showPhotos: s.showPhotos === 1,
      minReviewLength: s.minReviewLength,
      enableCoupons: s.enableCoupons === 1,
      enableQandA: s.enableQandA === 1,
      enableRichSnippets: s.enableRichSnippets === 1
    });
  } catch (error) {
    console.error("Error updating settings:", error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== BILLING API ====================

app.get("/api/billing/subscription", async (req, res) => {
  try {
    const { shop } = req.query;

    if (!shop) {
      return res.status(400).json({ error: "Missing shop parameter" });
    }

    const rows = await runQuery(`SELECT * FROM subscriptions WHERE shop = ?`, [shop]);
    
    if (rows.length === 0) {
      await runRun(`INSERT INTO subscriptions (shop, plan, status, reviewCount, reviewLimit) VALUES (?, ?, ?, ?, ?)`, 
        [shop, "free", "active", 0, 50]);
      return res.json({ plan: "free", status: "active", reviewCount: 0, reviewLimit: 50 });
    }

    const sub = rows[0];
    res.json({
      plan: sub.plan,
      status: sub.status,
      reviewCount: sub.reviewCount,
      reviewLimit: sub.reviewLimit
    });
  } catch (error) {
    console.error("Error fetching subscription:", error);
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/billing/plans", (req, res) => {
  res.json({
    free: { 
      name: "Free", 
      price: 0, 
      reviewRequests: 50, 
      reviews: 50, 
      photos: false, 
      videos: false, 
      qna: false, 
      imports: false, 
      analytics: false, 
      branding: true, 
      support: "email" 
    },
    unlimited: { 
      name: "Unlimited", 
      price: 15, 
      reviewRequests: "unlimited", 
      reviews: "unlimited", 
      photos: true, 
      videos: true, 
      qna: true, 
      imports: true, 
      analytics: true, 
      branding: false, 
      support: "priority" 
    }
  });
});

// ==================== ANALYTICS API ====================

app.get("/api/analytics/dashboard", requireAuth, async (req, res) => {
  try {
    const { shop } = req.query;

    if (!shop) {
      return res.status(400).json({ error: "Missing shop parameter" });
    }

    const allReviews = await runQuery(`SELECT * FROM reviews WHERE shop = ?`, [shop]);
    const published = allReviews.filter(r => r.published === 1);
    const pending = allReviews.filter(r => r.published === 0);

    const avg = published.length > 0 ? published.reduce((sum, r) => sum + r.rating, 0) / published.length : 0;

    const breakdown = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    allReviews.forEach(r => breakdown[r.rating] = (breakdown[r.rating] || 0) + 1);

    res.json({
      overview: {
        totalReviews: allReviews.length,
        publishedReviews: published.length,
        pendingReviews: pending.length,
        averageRating: Math.round(avg * 10) / 10,
        totalRequests: 0,
        conversionRate: "0%"
      },
      ratingDistribution: breakdown,
      topProducts: []
    });
  } catch (error) {
    console.error("Error fetching analytics:", error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== Q&A API ====================

app.get("/api/qna/product/:productId", async (req, res) => {
  try {
    const { productId } = req.params;
    const { shop } = req.query;

    if (!shop) {
      return res.status(400).json({ error: "Missing shop parameter" });
    }

    const questions = await runQuery(`SELECT * FROM questions WHERE shop = ? AND productId = ? AND status = "answered"`, [shop, productId]);
    res.json({ questions });
  } catch (error) {
    console.error("Error fetching Q&A:", error);
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/qna/ask", async (req, res) => {
  try {
    const { shop, productId, productTitle, customerName, customerEmail, question } = req.body;

    if (!shop || !productId || !question) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const settingsRows = await runQuery(`SELECT * FROM settings WHERE shop = ?`, [shop]);
    const settings = settingsRows[0] || {};
    if (settings.enableQandA !== 1) {
      return res.status(403).json({ error: "Q&A not enabled" });
    }

    const id = generateId();
    const now = new Date().toISOString();

    await runRun(
      `INSERT INTO questions (id, shop, productId, productTitle, customerName, customerEmail, question, answer, answeredBy, answerDate, status, votes, createdAt) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, shop, productId, productTitle || null, customerName || null, customerEmail || null, question, null, null, null, "pending", 0, now]
    );

    res.status(201).json({
      id, shop, productId, productTitle, customerName, customerEmail,
      question, answer: null, answeredBy: null, answerDate: null,
      status: "pending", votes: 0, createdAt: now
    });
  } catch (error) {
    console.error("Error asking question:", error);
    res.status(500).json({ error: error.message });
  }
});

// ==================== STATIC FILES ====================

// 404 handler for API routes
app.use("/api", (req, res) => {
  res.status(404).json({ error: "API endpoint not found" });
});

// Serve static frontend
app.use(express.static("web"));

// NOTE: Removed app.get('*', ...) because app.get('/', ...) above handles root
// For any other unmatched routes, serve the SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, "..", "web", "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Database: ${dbPath}`);
  console.log(`App URL: ${APP_URL}`);
});

module.exports = app;