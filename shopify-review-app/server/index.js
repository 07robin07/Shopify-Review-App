import express from "express";
import dotenv from "dotenv";
import { shopifyApi, LATEST_API_VERSION } from "@shopify/shopify-api";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import { PrismaClient } from "@prisma/client";
import reviewRoutes from "./routes/reviews.js";
import settingsRoutes from "./routes/settings.js";
import webhookRoutes from "./routes/webhooks.js";
import billingRoutes from "./routes/billing.js";
import qnaRoutes from "./routes/qna.js";
import importRoutes from "./routes/imports.js";
import analyticsRoutes from "./routes/analytics.js";
import cors from "cors";
import cron from "node-cron";
import { sendReviewRequest } from "./services/email.js";

dotenv.config();

const prisma = new PrismaClient();
const app = express();

// Middleware
app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true }));

// Shopify API setup
const shopify = shopifyApi({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET,
  apiVersion: LATEST_API_VERSION,
  scopes: [
    "read_products",
    "read_orders",
    "read_customers",
    "write_themes",
    "write_script_tags",
    "read_fulfillments",
    "read_shopify_payments_accounts"
  ],
  hostName: process.env.HOST,
  isEmbeddedApp: true,
});

// Session storage
const sessionStorage = new PrismaSessionStorage(prisma);

// Auth routes
app.get("/api/auth", async (req, res) => {
  try {
    await shopify.auth.begin({
      shop: req.query.shop,
      callbackPath: "/api/auth/callback",
      isOnline: false,
      rawRequest: req,
      rawResponse: res,
    });
  } catch (e) {
    res.status(500).send(e.message);
  }
});

app.get("/api/auth/callback", async (req, res) => {
  try {
    const session = await shopify.auth.callback({
      rawRequest: req,
      rawResponse: res,
    });
    await sessionStorage.storeSession(session);

    // Create default subscription (free plan)
    await prisma.subscription.upsert({
      where: { shop: session.shop },
      update: {},
      create: {
        shop: session.shop,
        sessionId: session.id,
        plan: "free",
        status: "active"
      }
    });

    // Create default settings
    await prisma.storeSettings.upsert({
      where: { shop: session.shop },
      update: {},
      create: {
        shop: session.shop,
        sessionId: session.id
      }
    });

    res.redirect(`/?shop=${session.shop}`);
  } catch (e) {
    res.status(500).send(e.message);
  }
});

// API Routes
app.use("/api/reviews", reviewRoutes);
app.use("/api/settings", settingsRoutes);
app.use("/api/webhooks", webhookRoutes);
app.use("/api/billing", billingRoutes);
app.use("/api/qna", qnaRoutes);
app.use("/api/imports", importRoutes);
app.use("/api/analytics", analyticsRoutes);

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Serve frontend
app.use(express.static("web"));
app.get("*", (req, res) => {
  res.sendFile("web/index.html", { root: "." });
});

// Cron job: Send review requests daily at 9 AM
if (process.env.NODE_ENV === "production") {
  cron.schedule("0 9 * * *", async () => {
    console.log("Running daily review request job...");
    const pending = await prisma.reviewRequest.findMany({
      where: { status: "pending" }
    });

    for (const request of pending) {
      await sendReviewRequest(request.shop, request);
    }
  });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

export { shopify, prisma };