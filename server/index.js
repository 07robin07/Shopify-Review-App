const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const express = require('express');

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
});

const app = express();

// CRITICAL: Enable CORS for Shopify store to communicate with server
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  if (req.method === 'OPTIONS') res.sendStatus(200);
  else next();
});

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true }));

function generateId() {
  return Math.random().toString(36).substring(2, 15) + Date.now().toString(36);
}

// Helper function to run SQL SELECT queries with promises
function runQuery(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

// Helper function to run SQL INSERT/UPDATE/DELETE with promises
// FIXED: Use regular function (not arrow) so 'this' binds correctly
function runRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// PUBLIC API - Get reviews for a product
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

    // Parse photos from JSON string and convert booleans
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

// PUBLIC API - Submit a review
app.post("/api/reviews/submit", async (req, res) => {
  try {
    const { shop, productId, customerName, customerEmail, rating, title, body, photos = [] } = req.body;

    if (!shop || !productId || !rating) {
      return res.status(400).json({ error: "Missing required fields: shop, productId, rating" });
    }

    // Get settings for auto-publish
    const settingsRows = await runQuery(`SELECT * FROM settings WHERE shop = ?`, [shop]);
    const autoPublish = settingsRows.length > 0 ? settingsRows[0].autoPublish : 1;

    const id = generateId();
    const now = new Date().toISOString();

    await runRun(
      `INSERT INTO reviews (id, shop, productId, customerName, customerEmail, rating, title, body, photos, verified, published, featured, helpfulCount, notHelpfulCount, reply, replyDate, createdAt, updatedAt) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, shop, productId, customerName || null, customerEmail || null, parseInt(rating), title || null, body || null, JSON.stringify(photos || []), 0, autoPublish, 0, 0, 0, null, null, now, now]
    );

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

// PUBLIC API - Mark helpful
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

// ADMIN API - Get all reviews
app.get("/api/reviews/admin/all", async (req, res) => {
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

    // Parse booleans and photos
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

    // Get total count
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

// ADMIN API - Update review
app.put("/api/reviews/admin/:id", async (req, res) => {
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

// ADMIN API - Delete review
app.delete("/api/reviews/admin/:id", async (req, res) => {
  try {
    await runRun(`DELETE FROM reviews WHERE id = ?`, [req.params.id]);
    res.status(204).send();
  } catch (error) {
    console.error("Error deleting review:", error);
    res.status(500).json({ error: error.message });
  }
});

// ADMIN API - Bulk actions
app.post("/api/reviews/admin/bulk", async (req, res) => {
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

// SETTINGS API - Get settings
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

// SETTINGS API - Update settings
app.put("/api/settings", async (req, res) => {
  try {
    const { shop } = req.query;
    const body = req.body;

    if (!shop) {
      return res.status(400).json({ error: "Missing shop parameter" });
    }

    const existing = await runQuery(`SELECT * FROM settings WHERE shop = ?`, [shop]);

    // Define valid columns to prevent SQL injection from unknown keys
    const validColumns = ['autoPublish', 'reviewRequestDelay', 'widgetTheme', 'starColor', 'showPhotos', 'minReviewLength', 'enableCoupons', 'enableQandA', 'enableRichSnippets'];

    if (existing.length === 0) {
      // Insert default settings with provided overrides
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
        [shop, values.autoPublish, values.reviewRequestDelay
