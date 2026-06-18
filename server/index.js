const sqlite3 = require('sqlite3').verbose();
const path = require('path');

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
    reviewLimit INTEGER DEFAULT 100
  )`);
});
