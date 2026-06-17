const express = require('express');
const path = require('path');

const app = express();

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true }));

// Simple in-memory storage
const db = {
  reviews: [],
  settings: {},
  requests: [],
  questions: [],
  subscriptions: {}
};

function generateId() {
  return Math.random().toString(36).substring(2, 15) + Date.now().toString(36);
}

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// PUBLIC API - Get reviews for a product
app.get("/api/reviews/product/:productId", (req, res) => {
  try {
    const { productId } = req.params;
    const { shop, page = 1, limit = 10, sort = "newest" } = req.query;

    let reviews = db.reviews.filter(r => r.shop === shop && r.productId === productId && r.published);

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

    res.json({
      reviews: paginated,
      pagination: { total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)) },
      stats: { average: Math.round(avg * 10) / 10, total, breakdown }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUBLIC API - Submit a review
app.post("/api/reviews/submit", (req, res) => {
  try {
    const { shop, productId, customerName, customerEmail, rating, title, body, photos = [] } = req.body;

    const settings = db.settings[shop] || { autoPublish: true };

    const review = {
      id: generateId(),
      shop,
      productId,
      customerName,
      customerEmail,
      rating: parseInt(rating),
      title,
      body,
      photos,
      verified: false,
      published: settings.autoPublish !== false,
      featured: false,
      helpfulCount: 0,
      notHelpfulCount: 0,
      reply: null,
      replyDate: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    db.reviews.push(review);

    res.status(201).json(review);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUBLIC API - Mark helpful
app.post("/api/reviews/:id/helpful", (req, res) => {
  try {
    const { id } = req.params;
    const { action } = req.body;

    const review = db.reviews.find(r => r.id === id);
    if (!review) return res.status(404).json({ error: "Not found" });

    if (action === "increment") review.helpfulCount++;
    else review.helpfulCount = Math.max(0, review.helpfulCount - 1);

    res.json(review);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ADMIN API - Get all reviews
app.get("/api/reviews/admin/all", (req, res) => {
  try {
    const { shop, status, page = 1, limit = 20, search } = req.query;

    let reviews = db.reviews.filter(r => r.shop === shop);

    if (status === "published") reviews = reviews.filter(r => r.published);
    if (status === "pending") reviews = reviews.filter(r => !r.published);
    if (search) {
      const s = search.toLowerCase();
      reviews = reviews.filter(r => 
        r.customerName.toLowerCase().includes(s) ||
        r.body.toLowerCase().includes(s)
      );
    }

    reviews.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    const start = (parseInt(page) - 1) * parseInt(limit);
    const paginated = reviews.slice(start, start + parseInt(limit));

    res.json({
      reviews: paginated,
      pagination: { total: reviews.length, page: parseInt(page), pages: Math.ceil(reviews.length / parseInt(limit)) }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ADMIN API - Update review
app.put("/api/reviews/admin/:id", (req, res) => {
  try {
    const { id } = req.params;
    const { published, featured, reply } = req.body;

    const review = db.reviews.find(r => r.id === id);
    if (!review) return res.status(404).json({ error: "Not found" });

    if (published !== undefined) review.published = published;
    if (featured !== undefined) review.featured = featured;
    if (reply !== undefined) {
      review.reply = reply;
      review.replyDate = reply ? new Date().toISOString() : null;
    }
    review.updatedAt = new Date().toISOString();

    res.json(review);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ADMIN API - Delete review
app.delete("/api/reviews/admin/:id", (req, res) => {
  try {
    db.reviews = db.reviews.filter(r => r.id !== req.params.id);
    res.status(204).send();
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ADMIN API - Bulk actions
app.post("/api/reviews/admin/bulk", (req, res) => {
  try {
    const { ids, action } = req.body;

    db.reviews.forEach(r => {
      if (ids.includes(r.id)) {
        if (action === "publish") r.published = true;
        if (action === "unpublish") r.published = false;
        if (action === "feature") r.featured = true;
      }
    });

    if (action === "delete") {
      db.reviews = db.reviews.filter(r => !ids.includes(r.id));
    }

    res.json({ success: true, affected: ids.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// SETTINGS API
app.get("/api/settings", (req, res) => {
  try {
    const { shop } = req.query;
    const settings = db.settings[shop] || {
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
    res.json(settings);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put("/api/settings", (req, res) => {
  try {
    const { shop } = req.query;
    db.settings[shop] = { ...db.settings[shop], ...req.body };
    res.json(db.settings[shop]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// BILLING API
app.get("/api/billing/subscription", (req, res) => {
  try {
    const { shop } = req.query;
    const sub = db.subscriptions[shop] || { plan: "free", status: "active" };
    res.json(sub);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/billing/plans", (req, res) => {
  res.json({
    free: { name: "Free", price: 0, reviewRequests: 50, reviews: 100, photos: false, videos: false, qna: false, imports: false, analytics: false, branding: true, support: "community" },
    starter: { name: "Starter", price: 9.99, reviewRequests: 500, reviews: 1000, photos: true, videos: false, qna: true, imports: true, analytics: true, branding: false, support: "email" },
    growth: { name: "Growth", price: 29.99, reviewRequests: 2000, reviews: 5000, photos: true, videos: true, qna: true, imports: true, analytics: true, branding: false, support: "priority" },
    pro: { name: "Pro", price: 79.99, reviewRequests: 10000, reviews: "unlimited", photos: true, videos: true, qna: true, imports: true, analytics: true, branding: false, support: "dedicated" }
  });
});

// ANALYTICS API
app.get("/api/analytics/dashboard", (req, res) => {
  try {
    const { shop } = req.query;
    const reviews = db.reviews.filter(r => r.shop === shop);
    const published = reviews.filter(r => r.published);
    const pending = reviews.filter(r => !r.published);

    const avg = published.length > 0 ? published.reduce((sum, r) => sum + r.rating, 0) / published.length : 0;

    res.json({
      overview: {
        totalReviews: reviews.length,
        publishedReviews: published.length,
        pendingReviews: pending.length,
        averageRating: Math.round(avg * 10) / 10,
        totalRequests: db.requests.filter(r => r.shop === shop).length,
        conversionRate: "0%"
      },
      ratingDistribution: reviews.reduce((acc, r) => {
        acc[r.rating] = (acc[r.rating] || 0) + 1;
        return acc;
      }, {}),
      topProducts: []
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Q&A API
app.get("/api/qna/product/:productId", (req, res) => {
  try {
    const { productId } = req.params;
    const { shop } = req.query;
    const questions = db.questions.filter(q => q.shop === shop && q.productId === productId && q.status === "answered");
    res.json({ questions });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/qna/ask", (req, res) => {
  try {
    const { shop, productId, productTitle, customerName, customerEmail, question } = req.body;
    const settings = db.settings[shop] || {};
    if (!settings.enableQandA) return res.status(403).json({ error: "Q&A not enabled" });

    const newQuestion = {
      id: generateId(),
      shop,
      productId,
      productTitle,
      customerName,
      customerEmail,
      question,
      answer: null,
      answeredBy: null,
      answerDate: null,
      status: "pending",
      votes: 0,
      createdAt: new Date().toISOString()
    };

    db.questions.push(newQuestion);
    res.status(201).json(newQuestion);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Serve static frontend
app.use(express.static("web"));
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "web", "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

module.exports = app;